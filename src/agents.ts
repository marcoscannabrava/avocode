/**
 * The variation operator's *driver*: how avo starts a headless coding agent.
 *
 * Every surface here was read off the real binaries (pi 0.84.3, claude 2.1.241, codex-cli 0.147.0)
 * rather than from memory, because a wrong flag here fails silently — the agent starts, refuses to
 * edit anything, exits 0, and the probe reads as "the model had no idea". That is exactly the trap
 * S5 recorded for `pi --approve`, and each template below carries the same class of flag.
 */

export interface AgentInvocation {
  prompt: string;
  /** `null` = let the agent use its own default (usually the user's configured model). */
  model: string | null;
}

export interface AgentTokens {
  input: number;
  output: number;
}

/** What we can recover from an agent's own output. Both fields are best-effort. */
export interface AgentOutput {
  /** The agent's final message — the probe's answer, in its own words. */
  summary: string | null;
  tokens: AgentTokens | null;
}

export type OutputFormat = "pi" | "claude" | "codex" | "text";

export interface AgentTemplate {
  name: string;
  command: string;
  args(inv: AgentInvocation): string[];
  format: OutputFormat;
  /**
   * The flag that stops the agent asking a human for permission, and why it is safe here. Reported
   * by `avo fan --json` so the operator can see what their agent was actually allowed to do.
   */
  approval: string;
}

/** Ends option parsing, so a prompt that begins with `-` is a prompt and not a misread flag. */
const END_OPTS = "--";

const model = (inv: AgentInvocation, flag: string): string[] => (inv.model === null ? [] : [flag, inv.model]);

export const PI: AgentTemplate = {
  name: "pi",
  command: "pi",
  // --approve is load-bearing: headless pi never shows the project-trust dialog, and without a
  // saved decision it ignores project-local .agents/skills/ and .pi/settings.json entirely — so the
  // skills `avo install` wired would not load in the one mode `avo fan` uses (PLAN §4, S5).
  args: (inv) => ["--mode", "json", "--print", "--approve", ...model(inv, "--model"), END_OPTS, inv.prompt],
  format: "pi",
  approval: "--approve (trusts project-local files for this run; headless pi cannot ask)",
};

export const CLAUDE: AgentTemplate = {
  name: "claude",
  command: "claude",
  // --verbose is required alongside --output-format stream-json under --print. bypassPermissions is
  // what makes the probe able to edit at all: in print mode a permission prompt is an auto-denial,
  // so the default mode yields an agent that reads and never writes.
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
  // workspace-write, not --dangerously-bypass-approvals-and-sandbox: the worktree *is* the writable
  // workspace, which is the whole point of fanning out into one. Reads are unrestricted, so
  // `avo score` works; writes outside the worktree do not, so a probe cannot reach the real repo.
  // The cost is that `avo commit` inside a codex probe is blocked — it would write to the parent
  // repo's .git — and promotion is the intended path anyway (invariant 7).
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
 * `{prompt}` and `{model}` are replaced inside each argument. An argument mentioning `{model}` is
 * dropped entirely when no model is set, so one template serves both cases without a second list.
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
      // A killed agent leaves a half-written line; that is not a parse failure worth reporting.
    }
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** `input`/`output` (pi) or `input_tokens`/`output_tokens` (claude, codex) — whichever is present. */
function tokensFrom(usage: unknown): AgentTokens | null {
  const u = obj(usage);
  if (u === null) return null;
  const input = num(u["input"]) ?? num(u["input_tokens"]);
  const output = num(u["output"]) ?? num(u["output_tokens"]);
  if (input === null && output === null) return null;
  return { input: input ?? 0, output: output ?? 0 };
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
 * Pulls the final message and the token count out of one agent's stdout.
 *
 * Deliberately tolerant: a format that changes under us must degrade to `summary: null` and a
 * scored, diffed probe, never to a crash that loses the whole fan-out (invariant 4).
 */
export function parseAgentOutput(format: OutputFormat, stdout: string): AgentOutput {
  if (format === "text") return { summary: lastLine(stdout), tokens: null };

  let summary: string | null = null;
  let tokens: AgentTokens | null = null;

  for (const e of jsonLines(stdout)) {
    switch (format) {
      case "claude": {
        // The single {"type":"result"} line closes the stream and carries both, verified against
        // claude 2.1.241 --output-format stream-json.
        if (e["type"] === "result") {
          if (typeof e["result"] === "string") summary = e["result"];
          tokens = tokensFrom(e["usage"]) ?? tokens;
        }
        break;
      }
      case "pi": {
        // message_end is the final authoritative message (docs/json.md); message_update carries the
        // latest cumulative usage, which is all a provider reporting only at completion gives us.
        if (e["type"] === "message_end") {
          const m = obj(e["message"]);
          if (m !== null && m["role"] === "assistant") {
            summary = textOf(m["content"]) ?? summary;
            tokens = tokensFrom(m["usage"]) ?? tokens;
          }
        } else if (e["type"] === "message_update") {
          tokens = tokensFrom(e["usage"]) ?? tokens;
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

  // A structured agent that died mid-stream still said something useful on the way down.
  return { summary: summary ?? lastLine(stdout), tokens };
}
