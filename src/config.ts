import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

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
}

export const DEFAULT_CONFIG: AvoConfig = { reduce: "dominate", floor: 0, weights: {}, configs: null };

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
    return { config: { ...DEFAULT_CONFIG }, warnings: [], present: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      config: { ...DEFAULT_CONFIG },
      warnings: [`${CONFIG_PATH} is not valid JSON (${(e as Error).message}); using defaults`],
      present: true,
    };
  }

  const warnings: string[] = [];
  for (const e of Value.Errors(ConfigSchema, parsed)) {
    const field = e.path.replace(/^\//, "").replaceAll("/", ".");
    warnings.push(`${CONFIG_PATH}: field '${field}' ${e.message.toLowerCase()} (got ${JSON.stringify(e.value)})`);
  }
  if (warnings.length > 0) return { config: { ...DEFAULT_CONFIG }, warnings, present: true };

  const file = parsed as ConfigFile;
  const config: AvoConfig = {
    reduce: file.reduce ?? DEFAULT_CONFIG.reduce,
    floor: file.floor ?? DEFAULT_CONFIG.floor,
    weights: file.weights ?? {},
    configs: null,
  };

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
