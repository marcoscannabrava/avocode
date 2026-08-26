import { spawnSync } from "node:child_process";
import type { Io } from "./io.ts";

/**
 * `required` — avo cannot work without it.
 * `agent`    — the variation operator; at least one must be present.
 * `optional` — enables a slice; absence degrades with a named fallback (invariant 4).
 */
export type DepKind = "required" | "agent" | "optional";

export interface DepSpec {
  name: string;
  kind: DepKind;
  why: string;
  install: string;
  /** Defaults to ["--version"]. */
  versionArgs?: string[];
}

export interface Probe {
  present: boolean;
  version: string | null;
}

/** Looks up one command. Injected so the report logic is testable without a filesystem. */
export type Prober = (name: string, versionArgs: string[]) => Probe;

export interface DepResult extends Probe {
  name: string;
  kind: DepKind;
  why: string;
  install: string;
}

export interface KeyResult {
  name: string;
  /** Presence only — invariant 6 forbids ever reporting a key's value. */
  set: boolean;
  why: string;
}

export interface DoctorReport {
  ok: boolean;
  version: string;
  deps: DepResult[];
  keys: KeyResult[];
  /** Human-readable reasons `ok` is false; empty when ok. */
  problems: string[];
}

export const DEPS: readonly DepSpec[] = [
  { name: "git", kind: "required", why: "lineage P_t lives in commits, notes and worktrees", install: "https://git-scm.com/downloads" },
  { name: "jq", kind: "required", why: "every subcommand speaks --json; scorers and skills pipe through jq", install: "https://jqlang.org/download/" },
  { name: "pi", kind: "agent", why: "coding agent driving Vary(); native avo extension target", install: "npm i -g @earendil-works/pi-coding-agent" },
  { name: "claude", kind: "agent", why: "coding agent driving Vary() in headless mode", install: "npm i -g @anthropic-ai/claude-code" },
  { name: "codex", kind: "agent", why: "coding agent driving Vary() via `codex exec`", install: "npm i -g @openai/codex" },
  { name: "qmd", kind: "optional", why: "knowledge base K: hybrid search + local rerank (S4); falls back to a local scan", install: "npm i -g @tobilu/qmd" },
  { name: "ddgs", kind: "optional", why: "keyless web search backend for avo know search (S4)", install: "pip install ddgs", versionArgs: ["version"] },
  { name: "bd", kind: "optional", why: "beads memory graph (S3); falls back to lineage/memory.jsonl", install: "npm i -g @beads/bd" },
  { name: "hyperfine", kind: "optional", why: "wall-clock scorer template (S1)", install: "https://github.com/sharkdp/hyperfine#installation" },
  { name: "just", kind: "optional", why: "task runner for lint/typecheck/test/e2e", install: "https://github.com/casey/just#installation" },
  { name: "shellcheck", kind: "optional", why: "the lint gate for every shell script in the repo (#2); falls back to `npm exec -- shellcheck`", install: "https://github.com/koalaman/shellcheck#installing" },
];

export const KEYS: readonly { name: string; why: string }[] = [
  { name: "ANTHROPIC_API_KEY", why: "claude / pi anthropic provider" },
  { name: "OPENAI_API_KEY", why: "codex / pi openai provider" },
  { name: "FIRECRAWL_API_KEY", why: "avo know add|search default backend (S4); free tier is 1000 credits/month" },
  { name: "SEARXNG_URL", why: "keyless avo know search backend (S4); the instance needs format=json" },
  { name: "GROQ_API_KEY", why: "small probe model for avo fan (S6)" },
  { name: "CEREBRAS_API_KEY", why: "small probe model for avo fan (S6)" },
  { name: "OPENROUTER_API_KEY", why: "small probe model for avo fan (S6)" },
  { name: "ARC_API_KEY", why: "the official ARC-AGI-3 games, for verifying a bench/arcagi3 run; the offline f never needs it" },
];

/** Real prober: runs `<name> --version` and keeps the first line. */
export const spawnProber: Prober = (name, versionArgs) => {
  const r = spawnSync(name, versionArgs, { encoding: "utf8", timeout: 10_000 });
  if (r.error !== undefined) return { present: false, version: null };
  const line = `${r.stdout ?? ""}${r.stderr ?? ""}`.split("\n").find((l) => l.trim() !== "");
  return { present: true, version: line?.trim() ?? null };
};

export function buildReport(
  version: string,
  prober: Prober,
  env: Record<string, string | undefined>,
  deps: readonly DepSpec[] = DEPS,
  keys: readonly { name: string; why: string }[] = KEYS,
): DoctorReport {
  const results: DepResult[] = deps.map((d) => {
    const probe = prober(d.name, d.versionArgs ?? ["--version"]);
    return { name: d.name, kind: d.kind, why: d.why, install: d.install, ...probe };
  });

  const problems: string[] = [];
  for (const d of results) {
    if (d.kind === "required" && !d.present) {
      problems.push(`missing required dependency '${d.name}' — ${d.why}. install: ${d.install}`);
    }
  }
  const agents = results.filter((d) => d.kind === "agent");
  if (agents.length > 0 && !agents.some((d) => d.present)) {
    problems.push(
      `no coding agent found — avo needs at least one of ${agents.map((a) => a.name).join(", ")} to act as the variation operator. install one, e.g. ${agents[0]?.install}`,
    );
  }

  const keyResults: KeyResult[] = keys.map((k) => ({
    name: k.name,
    set: (env[k.name] ?? "") !== "",
    why: k.why,
  }));

  return { ok: problems.length === 0, version, deps: results, keys: keyResults, problems };
}

const MARK = { yes: "ok  ", no: "MISS" } as const;

export function renderReport(r: DoctorReport): string {
  const lines: string[] = [`avo ${r.version} — doctor`, ""];
  for (const kind of ["required", "agent", "optional"] as const) {
    const group = r.deps.filter((d) => d.kind === kind);
    if (group.length === 0) continue;
    const heading = kind === "agent" ? "agent (at least one)" : kind;
    lines.push(`${heading}:`);
    for (const d of group) {
      const mark = d.present ? MARK.yes : MARK.no;
      const detail = d.present ? (d.version ?? "present") : `not found — ${d.install}`;
      lines.push(`  [${mark}] ${d.name.padEnd(10)} ${detail}`);
    }
    lines.push("");
  }
  lines.push("api keys (presence only, never values):");
  for (const k of r.keys) {
    lines.push(`  [${k.set ? MARK.yes : "unset"}] ${k.name.padEnd(20)} ${k.why}`);
  }
  lines.push("");
  if (r.ok) {
    lines.push("ok — all required dependencies present.");
  } else {
    lines.push(`not ok — ${r.problems.length} problem(s):`);
    for (const p of r.problems) lines.push(`  - ${p}`);
  }
  return `${lines.join("\n")}\n`;
}

export interface DoctorOptions {
  json: boolean;
}

export function parseDoctorArgs(argv: readonly string[]): DoctorOptions | { error: string } {
  const opts: DoctorOptions = { json: false };
  for (const a of argv) {
    if (a === "--json") opts.json = true;
    else return { error: `avo doctor: unknown option '${a}'` };
  }
  return opts;
}

export function doctorCommand(
  argv: readonly string[],
  io: Io,
  version: string,
  prober: Prober = spawnProber,
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = parseDoctorArgs(argv);
  if ("error" in parsed) {
    io.err(`${parsed.error}\n`);
    return 2;
  }
  const report = buildReport(version, prober, env);
  io.out(parsed.json ? `${JSON.stringify(report)}\n` : renderReport(report));
  return report.ok ? 0 : 1;
}
