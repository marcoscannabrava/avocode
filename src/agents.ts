/**
 * The variation operator's *driver*: starting a headless coding agent, running one turn, classifying
 * how it ended.
 *
 * Every surface was read off the real binaries (pi 0.84.3, claude 2.1.241, codex-cli 0.147.0), not
 * from memory: a wrong flag fails silently — the agent starts, edits nothing, exits 0, and the probe
 * reads as "the model had no idea". That is S5's `pi --approve` trap, and every template below
 * carries the same class of flag.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Runner } from "./score.ts";

export interface AgentInvocation {
  prompt: string;
  /** `null` = let the agent use its own default (usually the user's configured model). */
  model: string | null;
}

/**
 * One turn's usage, normalized so the four counts are **disjoint**: total input sent is
 * `input + cache_read + cache_write`. Cached input stays apart from uncached because it is priced at
 * roughly a tenth (read) and a quarter over (write) — summing them throws away the whole point.
 */
export interface AgentTokens {
  /** Input billed at full rate: the portion that did *not* come from the prompt cache. */
  input: number;
  output: number;
  /** Input replayed from the prompt cache. On a long loop over one repo this is most of it. */
  cache_read: number;
  /** Input written *into* the cache by this turn. */
  cache_write: number;
}

/** What we can recover from an agent's own output. Every field is best-effort. */
export interface AgentOutput {
  /** The agent's final message — the probe's answer, in its own words. */
  summary: string | null;
  tokens: AgentTokens | null;
  /**
   * The turn's USD as the agent reported it, else `null`. Taken from the agent, not derived from
   * `tokens`: it knows which model served each request and at what rate. #28 spends this number.
   */
  cost_usd: number | null;
}

export type OutputFormat = "pi" | "claude" | "codex" | "text";

export interface AgentTemplate {
  name: string;
  command: string;
  args(inv: AgentInvocation): string[];
  format: OutputFormat;
  /**
   * The flag that stops the agent asking a human for permission, and why it is safe. Reported by
   * `avo fan --json` so the operator sees what the agent was allowed to do.
   */
  approval: string;
}

/** Ends option parsing, so a prompt that begins with `-` is a prompt and not a misread flag. */
const END_OPTS = "--";

const model = (inv: AgentInvocation, flag: string): string[] => (inv.model === null ? [] : [flag, inv.model]);

export const PI: AgentTemplate = {
  name: "pi",
  command: "pi",
  // --approve is load-bearing: headless pi never shows the project-trust dialog, and untrusted it
  // ignores project-local .agents/skills/ and .pi/settings.json entirely (PLAN §4, S5).
  args: (inv) => ["--mode", "json", "--print", "--approve", ...model(inv, "--model"), END_OPTS, inv.prompt],
  format: "pi",
  approval: "--approve (trusts project-local files for this run; headless pi cannot ask)",
};

export const CLAUDE: AgentTemplate = {
  name: "claude",
  command: "claude",
  // --verbose is required alongside stream-json under --print. bypassPermissions is what lets the
  // probe edit at all: in print mode a permission prompt is an auto-denial.
  args: (inv) => [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    ...model(inv, "--model"),
    END_OPTS,
    inv.prompt,
  ],
  format: "claude",
  approval: "--permission-mode bypassPermissions (a prompt in --print mode is an auto-denial)",
};

export const CODEX: AgentTemplate = {
  name: "codex",
  command: "codex",
  // workspace-write, not the bypass flag: the worktree *is* the writable workspace. Reads stay
  // unrestricted so `avo score` works; writes outside it do not, so a probe cannot reach the real
  // repo. Cost: `avo commit` inside a codex probe is blocked, and promotion is the path (invariant 7).
  args: (inv) => [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    ...model(inv, "--model"),
    END_OPTS,
    inv.prompt,
  ],
  format: "codex",
  approval: "--sandbox workspace-write (the worktree is the writable root; the parent repo is not)",
};

export const BUILTIN_AGENTS: readonly AgentTemplate[] = [PI, CLAUDE, CODEX];
export const BUILTIN_AGENT_NAMES: readonly string[] = BUILTIN_AGENTS.map((a) => a.name);

/** A `custom` agent declared in `.avo/config.json`. Placeholders are substituted per argument. */
export interface CustomAgent {
  name: string;
  command: string;
  args: string[];
  format?: OutputFormat;
}

/**
 * `{prompt}` and `{model}` are replaced per argument. An argument mentioning `{model}` is dropped
 * when no model is set, so one template serves both cases.
 */
export function customTemplate(spec: CustomAgent): AgentTemplate {
  return {
    name: spec.name,
    command: spec.command,
    args: (inv) =>
      spec.args
        .filter((a) => inv.model !== null || !a.includes("{model}"))
        .map((a) => a.replaceAll("{prompt}", inv.prompt).replaceAll("{model}", inv.model ?? "")),
    format: spec.format ?? "text",
    approval: `custom (${spec.command}) — approval flags are the template author's responsibility`,
  };
}

export function resolveTemplate(name: string, custom: CustomAgent | null): AgentTemplate | { error: string } {
  if (custom !== null && name === custom.name) return customTemplate(custom);
  const builtin = BUILTIN_AGENTS.find((a) => a.name === name);
  if (builtin !== undefined) return builtin;
  const known = [...BUILTIN_AGENT_NAMES, ...(custom === null ? [] : [custom.name])].join(" | ");
  return {
    error:
      `unknown agent '${name}' (expected ${known})` +
      (custom === null ? `; declare your own as {"agent":{"name":"…","command":"…","args":[…]}} in .avo/config.json` : ""),
  };
}

// ---------------------------------------------------------------------------
// reading what the agent said
// ---------------------------------------------------------------------------

/** Parses JSONL leniently: a partial last line, or interleaved non-JSON noise, is skipped. */
function* jsonLines(stdout: string): Generator<Record<string, unknown>> {
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (t === "" || !t.startsWith("{")) continue;
    try {
      const v: unknown = JSON.parse(t);
      if (typeof v === "object" && v !== null && !Array.isArray(v)) yield v as Record<string, unknown>;
    } catch {
      // A killed agent leaves a half-written line. Not worth reporting.
    }
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Reads one usage object, in whichever of the three shapes produced it, into `AgentTokens`.
 *
 * | agent | uncached in | output | cache read | cache write |
 * | --- | --- | --- | --- | --- |
 * | pi 0.84.3 | `input` | `output` | `cacheRead` | `cacheWrite` |
 * | claude 2.1.241 | `input_tokens` | `output_tokens` | `cache_read_input_tokens` | `cache_creation_input_tokens` |
 * | codex-cli 0.147.0 | `input_tokens` *minus* `cached_input_tokens` | `output_tokens` | `cached_input_tokens` | — |
 *
 * Codex is why this normalizes instead of copying: it follows OpenAI, where `cached_input_tokens`
 * is a **subset** of `input_tokens`, while pi and claude report it **disjointly**. Copying both raw
 * double-counts codex's cache hits and drops claude's entirely — the S9b-1 run recorded 24 input
 * tokens for a turn that sent 573,313, because 523,326 were a cache read (#43).
 */
function tokensFrom(usage: unknown): AgentTokens | null {
  const u = obj(usage);
  if (u === null) return null;
  const output = num(u["output"]) ?? num(u["output_tokens"]);
  const rawInput = num(u["input"]) ?? num(u["input_tokens"]);
  const cacheWrite = num(u["cacheWrite"]) ?? num(u["cache_creation_input_tokens"]);
  // `cached_input_tokens` last and apart: codex's, and inclusive.
  const disjointRead = num(u["cacheRead"]) ?? num(u["cache_read_input_tokens"]);
  const inclusiveRead = num(u["cached_input_tokens"]);
  const cacheRead = disjointRead ?? inclusiveRead;
  if (rawInput === null && output === null && cacheRead === null && cacheWrite === null) return null;
  const input =
    disjointRead === null && inclusiveRead !== null
      ? Math.max(0, (rawInput ?? 0) - inclusiveRead) // clamped: a subset larger than its set is not a debt
      : (rawInput ?? 0);
  return { input, output: output ?? 0, cache_read: cacheRead ?? 0, cache_write: cacheWrite ?? 0 };
}

/** pi carries the turn's USD inside `usage` (`cost`); claude puts it beside it; codex omits it. */
function costFrom(usage: unknown): number | null {
  const u = obj(usage);
  return u === null ? null : num(u["cost"]);
}

/** Concatenates the `text` parts of a pi/anthropic-shaped content array, dropping thinking blocks. */
function textOf(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((c) => obj(c))
    .filter((c): c is Record<string, unknown> => c !== null && c["type"] === "text")
    .map((c) => (typeof c["text"] === "string" ? c["text"] : ""))
    .filter((t) => t !== "");
  return parts.length > 0 ? parts.join("\n") : null;
}

/** The last non-empty line, for agents that just print prose. */
function lastLine(stdout: string): string | null {
  const lines = stdout.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  return lines.length > 0 ? (lines.at(-1) as string) : null;
}

/**
 * The last line, but only if the agent *said* it rather than its protocol emitting it (#49).
 *
 * A dying structured agent still prints prose on the way down: `fatal: out of credits` explains a
 * turn. A protocol event does not, and it becomes `avo commit --why` — permanent in the commit body,
 * `lineage/vNNN.md` and `memory.jsonl`, and replayed to later turns as a known dead end.
 *
 * Anything opening a JSON object or array counts as protocol, including a half-written line from a
 * killed process. Only the LAST line is considered: earlier prose is startup noise (`npm notice`),
 * not a rationale.
 */
function lastProseLine(stdout: string): string | null {
  const line = lastLine(stdout);
  if (line === null) return null;
  const t = line.trim();
  return t.startsWith("{") || t.startsWith("[") ? null : line;
}

/**
 * Pulls the final message, the token counts and the reported cost out of one agent's stdout.
 *
 * **All three agents report usage cumulatively for the turn**, so last-seen wins rather than being
 * summed: one `result` event from claude, one `turn.completed` from codex, and pi's
 * `message_update`/`message_end` usage is a session running total (docs/json.md). An agent reporting
 * *per-message* usage would need summing here, and would silently report only its last message —
 * hence the assumption is written down rather than left in the shape of the code.
 *
 * Deliberately tolerant: a changed format must degrade to `summary: null` and a scored, diffed
 * probe, never a crash that loses the fan-out (invariant 4).
 */
export function parseAgentOutput(format: OutputFormat, stdout: string): AgentOutput {
  if (format === "text") return { summary: lastLine(stdout), tokens: null, cost_usd: null };

  let summary: string | null = null;
  // Fallback only: a turn killed mid-stream has no `result` event but usually already spoke.
  let streamed: string | null = null;
  let tokens: AgentTokens | null = null;
  let costUsd: number | null = null;

  for (const e of jsonLines(stdout)) {
    switch (format) {
      case "claude": {
        // One {"type":"result"} line closes the stream and carries both (claude 2.1.241).
        if (e["type"] === "result") {
          if (typeof e["result"] === "string") summary = e["result"];
          tokens = tokensFrom(e["usage"]) ?? tokens;
          // Sibling of `usage`, not a member — and what the ralph loop bills by.
          costUsd = num(e["total_cost_usd"]) ?? costUsd;
        } else if (e["type"] === "assistant") {
          const m = obj(e["message"]);
          if (m !== null) streamed = textOf(m["content"]) ?? streamed;
        }
        break;
      }
      case "pi": {
        // message_end is authoritative for the message; message_update carries the latest
        // cumulative usage, all a provider reporting only at completion gives us (docs/json.md).
        if (e["type"] === "message_end") {
          const m = obj(e["message"]);
          if (m !== null && m["role"] === "assistant") {
            summary = textOf(m["content"]) ?? summary;
            tokens = tokensFrom(m["usage"]) ?? tokens;
            costUsd = costFrom(m["usage"]) ?? costUsd;
          }
        } else if (e["type"] === "message_update") {
          const m = obj(e["message"]);
          if (m !== null && m["role"] === "assistant") streamed = textOf(m["content"]) ?? streamed;
          tokens = tokensFrom(e["usage"]) ?? tokens;
          costUsd = costFrom(e["usage"]) ?? costUsd;
        }
        break;
      }
      case "codex": {
        if (e["type"] === "item.completed") {
          const item = obj(e["item"]);
          if (item !== null && item["type"] === "agent_message" && typeof item["text"] === "string") {
            summary = item["text"];
          }
        } else if (e["type"] === "turn.completed") {
          tokens = tokensFrom(e["usage"]) ?? tokens;
        }
        break;
      }
    }
  }

  // A mid-stream death still said something: its last message first, then any prose it printed.
  // Never a protocol event dressed as a rationale (#49) — silence is the honest answer.
  return { summary: summary ?? streamed ?? lastProseLine(stdout), tokens, cost_usd: costUsd };
}

// ---------------------------------------------------------------------------
// driving one turn
// ---------------------------------------------------------------------------

/** 50KB / 2000 lines, whichever comes first. The uncapped text is always on disk (`log_path`). */
const SUMMARY_CAP_CHARS = 50_000;
const SUMMARY_CAP_LINES = 2_000;

export interface Capped {
  text: string;
  truncated: boolean;
}

export function capOutput(s: string, maxChars = SUMMARY_CAP_CHARS, maxLines = SUMMARY_CAP_LINES): Capped {
  const lines = s.split("\n");
  let text = s;
  let truncated = false;
  if (lines.length > maxLines) {
    text = lines.slice(0, maxLines).join("\n");
    truncated = true;
  }
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  return { text, truncated };
}

export interface TurnOpts {
  /** Where the agent runs: a worktree for `avo fan`, the root tree for `avo run`. */
  cwd: string;
  /** Repo-relative, so the message points at something the operator can open. */
  logPath: string;
  /** Absolute path the raw output is written to. */
  logFile: string;
  timeoutS: number;
  env: Record<string, string>;
}

/** One agent turn, as both `avo fan` and `avo run` see it. `ok` describes the PROCESS, not the work. */
export interface AgentTurn {
  ok: boolean;
  summary: string | null;
  tokens: AgentTokens | null;
  /** USD for this turn as the agent itself reported it; `null` when it reports none. */
  cost_usd: number | null;
  wall_s: number;
  exit_code: number;
  timed_out: boolean;
  truncated: boolean;
  /** The command could not be started at all — the one failure worth stopping a whole loop for. */
  spawn_failed: boolean;
  error: string | null;
}

/**
 * Starts a headless agent, records what it said, classifies how it ended.
 *
 * Shared by `avo fan` (per worktree) and `avo run` (per iteration), so both report a timeout, a
 * crash and a missing binary in the same words. The worktree, diffstat and commit stay with caller.
 */
export async function driveAgent(
  runner: Runner,
  template: AgentTemplate,
  inv: AgentInvocation,
  opts: TurnOpts,
  now: () => Date,
): Promise<AgentTurn> {
  const started = now().getTime();
  const run = await runner(template.command, template.args(inv), {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutS * 1000,
    env: opts.env,
  });
  const wallS = Math.round((now().getTime() - started) / 100) / 10;

  const raw = run.stderr === "" ? run.stdout : `${run.stdout}\n--- stderr ---\n${run.stderr}`;
  try {
    mkdirSync(dirname(opts.logFile), { recursive: true });
    writeFileSync(opts.logFile, raw);
  } catch {
    // An unwritable log must not lose the turn; the result still carries the summary.
  }

  const parsed = parseAgentOutput(template.format, run.stdout);
  const capped = capOutput(parsed.summary ?? "");

  let error: string | null = null;
  if (run.spawnError !== null) {
    error = `could not execute '${template.command}' — ${run.spawnError}. Is it on PATH?`;
  } else if (run.timedOut) {
    error = `the agent exceeded --timeout ${opts.timeoutS}s and its process group was killed`;
  } else if (run.code !== 0) {
    error = `the agent exited ${run.code}; its output is in ${opts.logPath}`;
  }

  return {
    ok: error === null,
    summary: capped.text === "" ? null : capped.text,
    tokens: parsed.tokens,
    cost_usd: parsed.cost_usd,
    wall_s: wallS,
    exit_code: run.code,
    timed_out: run.timedOut,
    truncated: capped.truncated,
    spawn_failed: run.spawnError !== null,
    error,
  };
}
