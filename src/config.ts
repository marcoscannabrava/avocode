import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { CustomAgent, OutputFormat } from "./agents.ts";

/** Optional per-repo settings. Absent is the common case and never a warning. */
export const CONFIG_PATH = ".avo/config.json";

/** Config names must be plain tokens — also how we detect a scorer with no `--configs`. */
export const CONFIG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const ConfigSchema = Type.Object(
  {
    /**
     * How the score *vector* reduces to a commit decision (PLAN §6 Q1).
     * `dominate` (default) — no config may regress and at least one must improve.
     * `mean` — the weighted mean must improve. Use only when configs genuinely trade off; a mean
     * lets a large win on one config pay for a regression on another.
     */
    reduce: Type.Optional(Type.Union([Type.Literal("dominate"), Type.Literal("mean")])),
    /** Relative noise band: a change smaller than this counts as neither better nor worse. */
    floor: Type.Optional(Type.Number({ minimum: 0 })),
    /** Per-config weights for `reduce: "mean"`. Unlisted configs weigh 1. */
    weights: Type.Optional(Type.Record(Type.String(), Type.Number({ minimum: 0 }))),
    /** Declares the scorer's configs so `avo score --parallel` skips the `--configs` probe. */
    configs: Type.Optional(Type.Array(Type.String())),
    /**
     * When the supervisor intervenes (S7). `stall`: attempts allowed with no committed improvement.
     * `thrash`: consecutive same-signature failures that count as re-trying one broken thing. Repo
     * policy — an hour-long scorer wants a smaller `stall` than a one-second one.
     */
    supervise: Type.Optional(
      Type.Object({
        stall: Type.Optional(Type.Integer({ minimum: 1 })),
        thrash: Type.Optional(Type.Integer({ minimum: 2 })),
      }),
    ),
    /**
     * A custom headless agent for `avo fan`, so the harness drives something beyond the three
     * built-ins with no code change (PLAN §2). `{prompt}` and `{model}` are substituted per
     * argument, and one mentioning `{model}` is dropped when no model is set. `format` picks the
     * output parser; omit it for an agent that prints prose.
     */
    agent: Type.Optional(
      Type.Object({
        name: Type.String({ minLength: 1 }),
        command: Type.String({ minLength: 1 }),
        args: Type.Array(Type.String()),
        format: Type.Optional(
          Type.Union([Type.Literal("pi"), Type.Literal("claude"), Type.Literal("codex"), Type.Literal("text")]),
        ),
      }),
    ),
  },
  { additionalProperties: true },
);

export type ConfigFile = Static<typeof ConfigSchema>;

export interface AvoConfig {
  reduce: "dominate" | "mean";
  floor: number;
  weights: Record<string, number>;
  /** `null` = not declared; probe the scorer instead. */
  configs: string[] | null;
  /** `null` = no custom agent declared; `avo fan` offers only the built-ins. */
  agent: CustomAgent | null;
  /** Thresholds `avo supervise` fires at. A flag overrides them; the defaults apply otherwise. */
  supervise: { stall: number; thrash: number };
}

/** Attempts with no committed improvement before the supervisor calls it a stall. */
export const DEFAULT_STALL = 5;
/** Consecutive same-signature failures before it calls it thrash. */
export const DEFAULT_THRASH = 3;

export const DEFAULT_CONFIG: AvoConfig = {
  reduce: "dominate",
  floor: 0,
  weights: {},
  configs: null,
  agent: null,
  supervise: { stall: DEFAULT_STALL, thrash: DEFAULT_THRASH },
};

/**
 * A fresh copy every time. Spreading `DEFAULT_CONFIG` is shallow, so callers would share one
 * `weights` and one `supervise` object — S4's shared-`args` bug, which let two `avo know` calls in
 * one process accumulate each other's arguments.
 */
function defaults(): AvoConfig {
  return { ...DEFAULT_CONFIG, weights: {}, supervise: { ...DEFAULT_CONFIG.supervise } };
}

export interface LoadedConfig {
  config: AvoConfig;
  warnings: string[];
  /** Whether a config file was found at all. */
  present: boolean;
}

/**
 * Reads `.avo/config.json`. A missing file yields the defaults silently; a malformed one yields the
 * defaults plus a warning naming the offending field — the commit gate must never be disabled by a
 * typo, and it must never crash on one either (invariant 4).
 */
export function loadConfig(cwd: string): LoadedConfig {
  let raw: string;
  try {
    raw = readFileSync(join(cwd, CONFIG_PATH), "utf8");
  } catch {
    return { config: defaults(), warnings: [], present: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      config: defaults(),
      warnings: [`${CONFIG_PATH} is not valid JSON (${(e as Error).message}); using defaults`],
      present: true,
    };
  }

  const warnings: string[] = [];
  for (const e of Value.Errors(ConfigSchema, parsed)) {
    const field = e.path.replace(/^\//, "").replaceAll("/", ".");
    warnings.push(`${CONFIG_PATH}: field '${field}' ${e.message.toLowerCase()} (got ${JSON.stringify(e.value)})`);
  }
  if (warnings.length > 0) return { config: defaults(), warnings, present: true };

  const file = parsed as ConfigFile;
  const config: AvoConfig = {
    reduce: file.reduce ?? DEFAULT_CONFIG.reduce,
    floor: file.floor ?? DEFAULT_CONFIG.floor,
    weights: file.weights ?? {},
    configs: null,
    agent: null,
    supervise: {
      stall: file.supervise?.stall ?? DEFAULT_STALL,
      thrash: file.supervise?.thrash ?? DEFAULT_THRASH,
    },
  };

  if (file.agent !== undefined) {
    const reserved = ["pi", "claude", "codex"];
    if (reserved.includes(file.agent.name)) {
      // Shadowing a built-in name would make `--agent claude` mean different things in different
      // repos, which is exactly the kind of silent divergence the templates exist to prevent.
      warnings.push(`${CONFIG_PATH}: field 'agent.name' may not shadow a built-in (${reserved.join(", ")}); ignoring it`);
    } else if (!file.agent.args.some((a) => a.includes("{prompt}"))) {
      warnings.push(`${CONFIG_PATH}: field 'agent.args' never mentions {prompt}, so the agent would get no task; ignoring it`);
    } else {
      const { name, command, args, format } = file.agent;
      config.agent = format === undefined ? { name, command, args } : { name, command, args, format: format as OutputFormat };
    }
  }

  if (file.configs !== undefined) {
    const bad = file.configs.filter((c) => !CONFIG_NAME.test(c));
    if (bad.length > 0) {
      warnings.push(`${CONFIG_PATH}: field 'configs' has invalid config names (${bad.join(", ")}); ignoring it`);
    } else if (file.configs.length === 0) {
      warnings.push(`${CONFIG_PATH}: field 'configs' is empty; ignoring it`);
    } else {
      config.configs = [...new Set(file.configs)];
    }
  }
  return { config, warnings, present: true };
}
