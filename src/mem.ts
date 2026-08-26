import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnRunner, type RunResult, type Runner } from "./score.ts";

/**
 * `bd` — beads (Dolt-backed issue + memory graph) is the loop's memory: what was tried, what worked,
 * which directions are dead ends. Optional, so the fallback below is the common path (invariant 4).
 */
export const BD = "bd";
/** Memory without `bd`. Already a qmd collection, like the rest of lineage/. */
export const MEMORY_PATH = "lineage/memory.jsonl";
/** Marks every bead avo writes, so a repo that also uses beads for its own work stays legible. */
export const BEAD_LABEL = "avo";
const BD_TIMEOUT_MS = 60_000;

/**
 * `intervention` is S7b's: a directive `avo run` injected into a turn. Deliberately NOT an insight —
 * insights are injected at prime time, so every future session would open with a stale "you are
 * stalling, read v3". A labelled bead instead: auditable when sought (the paper's 7-day run is only
 * interpretable because interventions are recorded), silent otherwise.
 */
export const MEMORY_KINDS = ["insight", "version", "failure", "intervention"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/**
 * One remembered thing, the same shape whichever backend holds it: an agent must not have to know
 * whether `bd` was installed.
 */
export interface Memory {
  ts: string;
  kind: MemoryKind;
  /** Stable identity: writing the same key again updates in place rather than piling up. */
  key: string;
  text: string;
  /** The committed version this memory is about, when it is about one. */
  version: number | null;
  /** The bead id, when beads wrote it. */
  bead: string | null;
  /** The parent bead this one was linked to via `bd dep add`. */
  parent: string | null;
}

export interface BdStatus {
  available: boolean;
  /** Why beads is unusable. Shown verbatim, so it must name the fix. */
  reason: string | null;
  /** The database's issue prefix, which is also the prefix explicit bead ids must carry. */
  prefix: string | null;
  version: string | null;
}

export interface Backend {
  kind: "beads" | "file";
  status: BdStatus;
  /** Emitted once per command, never once per record written. */
  warnings: string[];
}

export async function bd(runner: Runner, cwd: string, args: readonly string[]): Promise<RunResult> {
  return await runner(BD, args, { cwd, timeoutMs: BD_TIMEOUT_MS });
}

/** stderr first: bd puts its actionable hints there. */
function why(r: RunResult): string {
  const text = `${r.stderr}${r.stdout}`.trim().split("\n")[0] ?? "";
  return text === "" ? `exited ${r.code}` : text;
}

/**
 * `bd context --json` answers both questions in one call: is `bd` installed, and does this repo have
 * a database. It exits non-zero with a JSON error when there is none — the
 * installed-but-uninitialized case that must degrade rather than fail.
 */
export async function probeBd(runner: Runner, cwd: string): Promise<BdStatus> {
  const r = await bd(runner, cwd, ["context", "--json"]);
  if (r.spawnError !== null) {
    return { available: false, reason: `bd is not installed (${r.spawnError})`, prefix: null, version: null };
  }
  if (r.timedOut) return { available: false, reason: "bd timed out", prefix: null, version: null };
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    parsed = null;
  }
  const o = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
  if (r.code !== 0) {
    const detail = typeof o["error"] === "string" ? o["error"] : why(r);
    return {
      available: false,
      reason: `bd is installed but this repo has no beads database (${detail}); run 'avo init'`,
      prefix: null,
      version: typeof o["bd_version"] === "string" ? o["bd_version"] : null,
    };
  }
  const prefix = typeof o["database"] === "string" && o["database"] !== "" ? o["database"] : null;
  return {
    available: true,
    reason: null,
    prefix,
    version: typeof o["bd_version"] === "string" ? o["bd_version"] : null,
  };
}

/** Resolves the backend once per command, so the degradation warning is emitted exactly once. */
export async function resolveBackend(runner: Runner, cwd: string): Promise<Backend> {
  const status = await probeBd(runner, cwd);
  if (status.available) return { kind: "beads", status, warnings: [] };
  return {
    kind: "file",
    status,
    warnings: [`${status.reason ?? "bd is unavailable"}; memory falls back to ${MEMORY_PATH}`],
  };
}

/** `"register pressure was a dead end"` -> `"register-pressure-was-a-dead-end"`. */
export function slugKey(text: string, prefix = ""): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 8)
    .join("-");
  const body = slug === "" ? shortHash(text) : slug;
  return prefix === "" ? body : `${prefix}-${body}`;
}

export function shortHash(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 8);
}

/**
 * Reads the fallback store. Append-only on write, last-write-wins on read: rewriting in place would
 * lose when an insight was first learned, and only an append-only log survives two concurrent
 * probes.
 */
export function readMemoryFile(cwd: string): { memories: Memory[]; warnings: string[] } {
  let raw: string;
  try {
    raw = readFileSync(join(cwd, MEMORY_PATH), "utf8");
  } catch {
    return { memories: [], warnings: [] };
  }
  const warnings: string[] = [];
  const byKey = new Map<string, Memory>();
  let line = 0;
  for (const l of raw.split("\n")) {
    line++;
    if (l.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(l);
    } catch {
      warnings.push(`${MEMORY_PATH}:${line} is not valid JSON; skipped`);
      continue;
    }
    const m = parsed as Partial<Memory>;
    if (typeof m.key !== "string" || typeof m.text !== "string") {
      warnings.push(`${MEMORY_PATH}:${line} has no key/text; skipped`);
      continue;
    }
    byKey.set(m.key, {
      ts: typeof m.ts === "string" ? m.ts : "",
      // Checked against MEMORY_KINDS, not an inline list: the original left every S7b
      // intervention reading back as an insight, nesting one directive inside the next.
      kind: MEMORY_KINDS.includes(m.kind as MemoryKind) ? (m.kind as MemoryKind) : "insight",
      key: m.key,
      text: m.text,
      version: typeof m.version === "number" ? m.version : null,
      bead: typeof m.bead === "string" ? m.bead : null,
      parent: typeof m.parent === "string" ? m.parent : null,
    });
  }
  return { memories: [...byKey.values()], warnings };
}

function appendMemoryFile(cwd: string, m: Memory): string | null {
  try {
    mkdirSync(join(cwd, dirname(MEMORY_PATH)), { recursive: true });
    appendFileSync(join(cwd, MEMORY_PATH), `${JSON.stringify(m)}\n`);
    return null;
  } catch (e) {
    return `could not write ${MEMORY_PATH} — ${(e as Error).message}`;
  }
}

export interface MemoryInput {
  kind: MemoryKind;
  text: string;
  key?: string;
  version?: number | null;
  /** For `kind: "version"`: the version whose bead this one is linked to. */
  parentVersion?: number | null;
  /** Longer body — only beads keeps it; the file store holds `text`. */
  detail?: string;
}

export interface MemWrite {
  ok: boolean;
  backend: Backend["kind"];
  key: string;
  bead: string | null;
  parent: string | null;
  warnings: string[];
  error: string | null;
}

/** `avo` + the version number: deterministic, so re-recording a version updates one bead. */
export function beadId(prefix: string, input: MemoryInput): string {
  if (input.kind === "version" && typeof input.version === "number") return `${prefix}-v${input.version}`;
  return `${prefix}-x${shortHash(input.key ?? input.text)}`;
}

/**
 * Records one memory. Never throws: a bad write warns on an otherwise good commit, because the
 * lineage is the source of truth and beads a cache of *why* (invariant 4).
 */
export async function remember(
  runner: Runner,
  cwd: string,
  backend: Backend,
  input: MemoryInput,
  now: () => Date = () => new Date(),
): Promise<MemWrite> {
  const key = input.key ?? slugKey(input.text);
  const warnings: string[] = [];
  let bead: string | null = null;
  let parent: string | null = null;

  if (backend.kind === "beads") {
    const prefix = backend.status.prefix;
    if (prefix === null) {
      warnings.push(`bd reported no database prefix; wrote this memory to ${MEMORY_PATH} instead`);
    } else if (input.kind === "insight") {
      // Insights are memories, not issues: bd injects them at prime time, so they survive.
      const r = await bd(runner, cwd, ["remember", input.text, "--key", key]);
      if (r.code !== 0 || r.spawnError !== null) warnings.push(`bd remember failed (${why(r)}); using ${MEMORY_PATH}`);
      else return { ok: true, backend: "beads", key, bead: null, parent: null, warnings, error: null };
    } else {
      const id = beadId(prefix, { ...input, key });
      const label = `${BEAD_LABEL},avo-${input.kind === "version" ? "version" : input.kind === "intervention" ? "intervention" : "insight"}`;
      const args = ["create", input.text, "--id", id, "--silent", "--force", "-l", label];
      if (input.detail !== undefined && input.detail !== "") args.push("-d", input.detail);
      args.push("-t", input.kind === "version" ? "task" : "chore");
      const r = await bd(runner, cwd, args);
      if (r.code !== 0 || r.spawnError !== null) {
        warnings.push(`bd create failed (${why(r)}); using ${MEMORY_PATH}`);
      } else {
        bead = r.stdout.trim().split("\n").pop()?.trim() ?? id;
        if (typeof input.parentVersion === "number") {
          parent = `${prefix}-v${input.parentVersion}`;
          // `bd dep add <child> <parent>` is the lineage edge: v(N) descends from v(N-1).
          // Re-adding is a no-op in bd.
          const dep = await bd(runner, cwd, ["dep", "add", bead, parent]);
          if (dep.code !== 0 || dep.spawnError !== null) {
            warnings.push(`bd dep add ${bead} ${parent} failed (${why(dep)}); the bead has no parent edge`);
            parent = null;
          }
        }
        return { ok: true, backend: "beads", key, bead, parent, warnings, error: null };
      }
    }
  }

  const record: Memory = {
    ts: now().toISOString(),
    kind: input.kind,
    key,
    text: input.detail === undefined || input.detail === "" ? input.text : `${input.text} — ${input.detail}`,
    version: input.version ?? null,
    bead,
    parent: typeof input.parentVersion === "number" ? `v${input.parentVersion}` : null,
  };
  const error = appendMemoryFile(cwd, record);
  return { ok: error === null, backend: "file", key, bead: null, parent: record.parent, warnings, error };
}

/** Everything remembered, newest last. Beads memories carry no timestamp, so theirs stays empty. */
export async function listMemories(
  runner: Runner,
  cwd: string,
  backend: Backend,
): Promise<{ memories: Memory[]; warnings: string[] }> {
  if (backend.kind === "beads") {
    const r = await bd(runner, cwd, ["--json", "memories"]);
    if (r.code === 0 && r.spawnError === null) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        parsed = null;
      }
      if (typeof parsed === "object" && parsed !== null) {
        const memories: Memory[] = Object.entries(parsed as Record<string, unknown>)
          .filter(([k, v]) => k !== "schema_version" && typeof v === "string")
          .map(([k, v]) => ({ ts: "", kind: "insight", key: k, text: v as string, version: null, bead: null, parent: null }));
        // The file store may hold records written while bd was down; show both.
        const file = readMemoryFile(cwd);
        const seen = new Set(memories.map((m) => m.key));
        return {
          memories: [...memories, ...file.memories.filter((m) => !seen.has(m.key))],
          warnings: file.warnings,
        };
      }
    }
    const fallback = readMemoryFile(cwd);
    return { memories: fallback.memories, warnings: [`bd memories failed (${why(r)}); read ${MEMORY_PATH}`, ...fallback.warnings] };
  }
  return readMemoryFile(cwd);
}

/** `bd prime` — the session-start context. Without bd, our own digest of the same material. */
export async function primeContext(
  runner: Runner,
  cwd: string,
  backend: Backend,
): Promise<{ text: string; warnings: string[] }> {
  if (backend.kind === "beads") {
    const r = await bd(runner, cwd, ["prime"]);
    if (r.code === 0 && r.spawnError === null && r.stdout.trim() !== "") return { text: r.stdout, warnings: [] };
    const { memories, warnings } = await listMemories(runner, cwd, backend);
    return { text: renderPrime(memories), warnings: [`bd prime failed (${why(r)}); rendered ${MEMORY_PATH}`, ...warnings] };
  }
  const { memories, warnings } = await listMemories(runner, cwd, backend);
  return { text: renderPrime(memories), warnings };
}

export function renderPrime(memories: readonly Memory[]): string {
  const lines = ["# avo memory", ""];
  const group = (kind: MemoryKind, title: string) => {
    const items = memories.filter((m) => m.kind === kind);
    if (items.length === 0) return;
    lines.push(`## ${title} (${items.length})`, "");
    for (const m of items) lines.push(`- **${m.key}** — ${m.text}`);
    lines.push("");
  };
  if (memories.length === 0) lines.push("nothing remembered yet — `avo mem add \"<insight>\"` writes the first one", "");
  group("insight", "insights");
  group("failure", "dead ends (do not re-try these)");
  group("version", "committed versions");
  // Recorded for audit, not priming: see MemoryKind. `avo mem` lists them.
  return `${lines.join("\n")}\n`;
}

export function renderMemories(memories: readonly Memory[], backend: Backend): string {
  const lines = ["avo mem", ""];
  for (const w of backend.warnings) lines.push(`warning: ${w}`);
  if (backend.warnings.length > 0) lines.push("");
  if (memories.length === 0) {
    lines.push(`nothing remembered yet — \`avo mem add "<insight>"\` writes the first one`, "");
    return `${lines.join("\n")}\n`;
  }
  for (const m of memories) {
    const tag = m.kind === "insight" ? "" : ` [${m.kind}${m.version === null ? "" : ` v${m.version}`}]`;
    lines.push(`  ${m.key}${tag}`);
    lines.push(`    ${m.text}`);
  }
  lines.push("", `${memories.length} memor${memories.length === 1 ? "y" : "ies"} via ${backend.kind}`, "");
  return `${lines.join("\n")}\n`;
}

export interface MemOptions {
  json: boolean;
  cwd: string;
  sub: "list" | "add" | "prime";
  key: string | null;
  args: string[];
}

export function parseMemArgs(argv: readonly string[]): MemOptions | { error: string } {
  const opts: MemOptions = { json: false, cwd: process.cwd(), sub: "list", key: null, args: [] };
  let sawSub = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--json") opts.json = true;
    else if (a === "--cwd" || a === "--key") {
      const v = argv[i + 1];
      if (v === undefined) return { error: `avo mem: ${a} needs a value` };
      if (a === "--cwd") opts.cwd = v;
      else opts.key = v;
      i++;
    } else if (a.startsWith("-")) return { error: `avo mem: unknown option '${a}'` };
    else if (!sawSub && (a === "add" || a === "prime" || a === "list")) {
      opts.sub = a === "list" ? "list" : a;
      sawSub = true;
    } else opts.args.push(a);
  }
  if (opts.sub === "add" && opts.args.join(" ").trim() === "") {
    return { error: `avo mem add: needs the insight, e.g. avo mem add "shared memory beats registers here"` };
  }
  if (opts.sub !== "add" && opts.args.length > 0) {
    return { error: `avo mem: unknown argument '${opts.args[0]}'; try 'add "<insight>"' or 'prime'` };
  }
  if (opts.sub !== "add" && opts.key !== null) return { error: "avo mem: --key only applies to 'avo mem add'" };
  return opts;
}

/** Exit codes: 0 = fine, 2 = usage error or a memory that could not be written anywhere. */
export async function memCommand(
  argv: readonly string[],
  io: { out: (s: string) => void; err: (s: string) => void },
  runner: Runner = spawnRunner,
  now: () => Date = () => new Date(),
): Promise<number> {
  const parsed = parseMemArgs(argv);
  if ("error" in parsed) {
    io.err(`${parsed.error}\n`);
    return 2;
  }
  const opts = parsed;
  const backend = await resolveBackend(runner, opts.cwd);

  if (opts.sub === "add") {
    const text = opts.args.join(" ").trim();
    const input: MemoryInput = { kind: "insight", text };
    if (opts.key !== null) input.key = opts.key;
    const w = await remember(runner, opts.cwd, backend, input, now);
    const warnings = [...backend.warnings, ...w.warnings];
    if (opts.json) {
      io.out(`${JSON.stringify({ ...w, warnings, text })}\n`);
    } else {
      for (const warning of warnings) io.err(`warning: ${warning}\n`);
      if (w.ok) io.out(`remembered [${w.key}] via ${w.backend}: ${text}\n`);
      else io.err(`avo mem add: ${w.error ?? "could not record the memory"}\n`);
    }
    return w.ok ? 0 : 2;
  }

  if (opts.sub === "prime") {
    const { text, warnings: primeWarnings } = await primeContext(runner, opts.cwd, backend);
    const warnings = [...backend.warnings, ...primeWarnings];
    if (opts.json) io.out(`${JSON.stringify({ backend: backend.kind, warnings, text })}\n`);
    else {
      for (const w of warnings) io.err(`warning: ${w}\n`);
      io.out(text);
    }
    return 0;
  }

  const { memories, warnings: listWarnings } = await listMemories(runner, opts.cwd, backend);
  const warnings = [...backend.warnings, ...listWarnings];
  if (opts.json) io.out(`${JSON.stringify({ backend: backend.kind, warnings, memories })}\n`);
  else io.out(renderMemories(memories, { ...backend, warnings }));
  return 0;
}
