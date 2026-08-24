/**
 * The supervisor — `avo supervise`. AVO's harness runs for days, and the paper is explicit that the
 * agent needs *steering*, not just scoring: a variation operator with no supervisor plateaus and
 * keeps plateauing, re-deriving the same idea because nothing tells it the idea is old.
 *
 * Two detections, both computed from what the harness already records and nothing else:
 *
 *   stall   — attempts have accumulated since the last committed improvement. `P_t` is monotone by
 *             construction, so the newest version *is* the last improvement; everything logged
 *             after it is a variation that did not win.
 *   thrash  — consecutive failures with the same signature. The agent is re-trying the same broken
 *             thing, which reads exactly like progress from inside a single turn.
 *
 * The output is a directive that **cites**. A steering message that says "try something else" is
 * worthless — the agent already believes it is trying something else. So the directive names prior
 * versions with their scores and rationales, the dead ends memory already holds, and the docs in
 * `K` that no version has ever mentioned. That last one is the reason S3 and S4 exist: without a
 * lineage and a knowledge base there is nothing concrete to cite.
 *
 * `detect` is pure and takes fixtures. Everything that touches git, `bd` or the filesystem lives in
 * `supervise`, so the thresholds can be tested at their exact firing point without a repo.
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig } from "./config.ts";
import type { Io } from "./io.ts";
import { listDocs, queryTerms, type DocRef } from "./knowledge.ts";
import { bestVersion, isGitRepo, LINEAGE_DIR, readLineage, type Version } from "./lineage.ts";
import { listMemories, resolveBackend, type Memory } from "./mem.ts";
import { ATTEMPTS_PATH, spawnRunner, type Attempt, type Runner } from "./score.ts";

/**
 * Only the tail of the attempt log is examined. Both detections are about *recent* history, and a
 * week-long run's log is large enough that parsing all of it every iteration would be felt — `avo
 * run` calls this between every agent turn.
 */
export const ANALYSIS_WINDOW = 1_000;

/** The directive is injected into a prompt, so it has to stay a prompt-sized thing. */
const DIRECTIVE_CAP = 4_000;
const SIGNATURE_CAP = 200;

const MAX_VERSION_CITATIONS = 3;
const MAX_MEMORY_CITATIONS = 5;
const MAX_KNOWLEDGE_CITATIONS = 3;

// ---------------------------------------------------------------------------
// the attempt log
// ---------------------------------------------------------------------------

export interface AttemptLog {
  /** Newest last, at most `window` of them. */
  attempts: Attempt[];
  /** Valid records in the whole file, even the ones outside the window. */
  total: number;
  warnings: string[];
}

/** Enough of an `Attempt` to reason about. A record failing this is trajectory we cannot read. */
function isAttempt(v: unknown): v is Attempt {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["ts"] === "string" &&
    typeof o["pass"] === "boolean" &&
    typeof o["ok"] === "boolean" &&
    typeof o["correct"] === "boolean" &&
    (typeof o["primary"] === "number" || o["primary"] === null) &&
    Array.isArray(o["errors"])
  );
}

/**
 * Reads `.avo/attempts.jsonl`. A missing file is the normal state of a repo that has never scored,
 * not a warning. A malformed line is skipped and counted: a truncated write (a killed run) must not
 * cost us the rest of the log (invariant 4).
 */
export function readAttempts(cwd: string, window = ANALYSIS_WINDOW): AttemptLog {
  let raw: string;
  try {
    raw = readFileSync(join(cwd, ATTEMPTS_PATH), "utf8");
  } catch {
    return { attempts: [], total: 0, warnings: [] };
  }

  const attempts: Attempt[] = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    if (!isAttempt(parsed)) {
      skipped++;
      continue;
    }
    attempts.push(parsed);
  }

  const warnings: string[] = [];
  if (skipped > 0) {
    warnings.push(`${ATTEMPTS_PATH} has ${skipped} unreadable line(s); they were skipped`);
  }
  const total = attempts.length;
  if (total > window) {
    warnings.push(`${total} attempts recorded; only the last ${window} were examined`);
  }
  return { attempts: attempts.slice(-window), total, warnings };
}

// ---------------------------------------------------------------------------
// the detector
// ---------------------------------------------------------------------------

/**
 * Two failures are "the same" when their signatures match, so the signature has to survive the
 * things that change between two runs of the same broken code: temp directories, timings, pids,
 * commit shas. Everything volatile is folded to a placeholder; hex before digits, or a sha would be
 * partly digested into `N` first and two runs would stop matching.
 */
export function normalizeSignature(s: string): string {
  return s
    .toLowerCase()
    .replaceAll("\\", "/")
    .replace(/(\/(?:tmp|var\/folders)\/)[^\s:,)"']+/g, "$1T")
    .replace(/\b[0-9a-f]{7,40}\b/g, "H")
    .replace(/\d+(?:\.\d+)?/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SIGNATURE_CAP);
}

/**
 * What this attempt failed *at*, or `null` for one that passed. Harness errors (missing scorer,
 * malformed output, timeout) are the sharpest signal and come first; after them the scorer's own
 * first line of log, which is where a compiler puts the error the agent needs to read.
 */
export function failureSignature(a: Attempt): string | null {
  if (a.pass) return null;
  if (a.errors.length > 0) return normalizeSignature(a.errors.join(" | "));
  const fromLog = (a.log ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (fromLog !== undefined) return normalizeSignature(fromLog);
  return normalizeSignature(a.ok ? "f reported correct: false" : "f reported ok: false");
}

export interface SuperviseState {
  versions: number;
  best: { version: number; sha: string; date: string; primary: number | null; unit: string } | null;
  /** Valid records in the whole log. */
  attempts: number;
  /** How many of them the detector examined (`ANALYSIS_WINDOW` at most). */
  analyzed: number;
  /** Attempts logged after the newest version was committed — i.e. since the last improvement. */
  since_best: number;
  /** Trailing consecutive failing attempts. */
  failing_streak: number;
  /** How many of those trailing failures share `signature`. */
  repeat: number;
  signature: string | null;
  last_pass: string | null;
}

export type SignalKind = "stall" | "thrash";

export interface Signal {
  kind: SignalKind;
  /** What was measured (attempts since best; repeated failures). */
  count: number;
  threshold: number;
  /** One sentence, specific enough that an operator needs nothing else to agree with it. */
  detail: string;
}

export interface SuperviseInput {
  versions: readonly Version[];
  attempts: readonly Attempt[];
  /** Valid records in the whole log; `attempts.length` when nothing was windowed out. */
  total?: number;
  stall: number;
  thrash: number;
}

/**
 * Attempts logged after `best` was committed.
 *
 * The discriminator is the sha the attempt recorded, not its clock: an attempt scored *on top of*
 * the best version carries that version's sha in `git.head`, while the attempt that *became* the
 * version was scored before the commit existed and carries its parent's. Timestamps cannot do this
 * job alone — git truncates author dates to the second, so the committing attempt's millisecond
 * `ts` can read as *later* than the commit it produced, which would make every stall fire one
 * attempt early, forever. Flooring to the second fixes that and breaks the opposite case: with a
 * fast scorer, several real attempts land inside the commit's own second and vanish.
 *
 * The clock is still the fallback for an attempt whose head matches neither — the agent made its own
 * commits since — and there one full second of margin keeps the committing attempt out.
 */
function sinceBest(attempts: readonly Attempt[], best: Version | null): number {
  if (best === null) return attempts.length;
  const commitMs = Date.parse(best.date);
  return attempts.filter((a) => {
    if (a.git.head === best.sha) return true;
    if (Number.isNaN(commitMs)) return true;
    const t = Date.parse(a.ts);
    return !Number.isNaN(t) && t >= commitMs + 1_000;
  }).length;
}

const fmtScore = (primary: number | null, unit: string): string => (primary === null ? "—" : `${primary} ${unit}`.trim());

/** Pure: everything it needs is in `input`, so both thresholds are testable off fixtures. */
export function detect(input: SuperviseInput): { state: SuperviseState; signals: Signal[] } {
  const { attempts, versions, stall, thrash } = input;
  const best = bestVersion(versions);

  let failing = 0;
  for (let i = attempts.length - 1; i >= 0; i--) {
    if ((attempts[i] as Attempt).pass) break;
    failing++;
  }
  const last = attempts[attempts.length - 1];
  const signature = last === undefined ? null : failureSignature(last);
  let repeat = 0;
  if (signature !== null) {
    for (let i = attempts.length - 1; i >= 0; i--) {
      if (failureSignature(attempts[i] as Attempt) !== signature) break;
      repeat++;
    }
  }

  let lastPass: string | null = null;
  for (let i = attempts.length - 1; i >= 0; i--) {
    const a = attempts[i] as Attempt;
    if (a.pass) {
      lastPass = a.ts;
      break;
    }
  }

  const since = sinceBest(attempts, best);
  const state: SuperviseState = {
    versions: versions.length,
    best:
      best === null
        ? null
        : {
            version: best.version,
            sha: best.sha,
            date: best.date,
            primary: best.score.primary,
            unit: best.score.unit,
          },
    attempts: input.total ?? attempts.length,
    analyzed: attempts.length,
    since_best: since,
    failing_streak: failing,
    repeat,
    signature,
    last_pass: lastPass,
  };

  const signals: Signal[] = [];
  if (since >= stall && since > 0) {
    const detail =
      best === null
        ? `${since} attempt(s) recorded and no version has ever been committed; the threshold is ${stall}`
        : `${since} attempt(s) since v${best.version} (${fmtScore(best.score.primary, best.score.unit)}) with no committed improvement; the threshold is ${stall}`;
    signals.push({ kind: "stall", count: since, threshold: stall, detail });
  }
  if (repeat >= thrash) {
    signals.push({
      kind: "thrash",
      count: repeat,
      threshold: thrash,
      detail: `the last ${repeat} attempts failed the same way ("${signature ?? ""}"); the threshold is ${thrash}`,
    });
  }
  return { state, signals };
}

// ---------------------------------------------------------------------------
// what the directive cites
// ---------------------------------------------------------------------------

export interface Citation {
  kind: "version" | "insight" | "failure" | "knowledge";
  /** `v3`, a memory key, or a repo-relative path — always something the agent can look up. */
  ref: string;
  text: string;
}

/**
 * Whether the lineage has already talked about this doc. Half its title's significant terms
 * appearing in the corpus is deliberately a low bar: a doc wrongly called explored is a citation we
 * merely fail to make, while a doc wrongly called *unexplored* sends the agent back down a road it
 * already travelled — which is precisely the failure the supervisor exists to prevent.
 */
export function isExplored(doc: DocRef, corpus: string): boolean {
  const label = doc.title ?? basename(doc.file).replace(/\.md$/i, "").replaceAll(/[-_]/g, " ");
  const terms = queryTerms(label);
  if (terms.length === 0) return true;
  const found = terms.filter((t) => corpus.includes(t)).length;
  return found * 2 >= terms.length;
}

export function unexplored(docs: readonly DocRef[], corpus: string, limit = MAX_KNOWLEDGE_CITATIONS): DocRef[] {
  return docs.filter((d) => !isExplored(d, corpus.toLowerCase())).slice(0, limit);
}

/**
 * Memories that say something about the *problem*. Interventions are excluded, and that exclusion is
 * load-bearing in two ways — both found by running the loop rather than by reading it (S7b):
 *
 * 1. An intervention's text is a whole previous directive, so citing one nests the last directive
 *    inside this one. Three iterations in, the agent reads its own supervisor quoting itself.
 * 2. Worse, that directive *names* the unexplored docs it cited. Fold it into the corpus below and
 *    every doc the supervisor has ever recommended reads as explored — so a doc is cited exactly
 *    once, by the intervention that then buries it. The supervisor would erase its own best advice.
 *
 * An intervention is trajectory about the supervisor, not knowledge about the problem. It is
 * recorded so a run can be audited (`avo mem`), never so a directive can cite it.
 */
export function aboutTheProblem(memories: readonly Memory[]): Memory[] {
  return memories.filter((m) => m.kind !== "intervention");
}

/** The corpus "explored" is measured against: every rationale and everything remembered. */
export function exploredCorpus(versions: readonly Version[], memories: readonly Memory[]): string {
  return [...versions.map((v) => `${v.subject} ${v.why ?? ""}`), ...aboutTheProblem(memories).map((m) => m.text)]
    .join("\n")
    .toLowerCase();
}

export function citationsFor(
  versions: readonly Version[],
  memories: readonly Memory[],
  docs: readonly DocRef[],
): Citation[] {
  const citations: Citation[] = [];
  // Newest first: the most recent versions are the ones an agent is most likely to re-derive.
  for (const v of [...versions].reverse().slice(0, MAX_VERSION_CITATIONS)) {
    const why = v.why === null ? v.subject : v.why.split("\n")[0]?.trim() ?? v.subject;
    const file = join(LINEAGE_DIR, `v${String(v.version).padStart(3, "0")}.md`);
    citations.push({
      kind: "version",
      ref: `v${v.version}`,
      text: `${fmtScore(v.score.primary, v.score.unit)} — ${why} (${file})`,
    });
  }
  // Dead ends first: "do not re-try this" is worth more to a stalled agent than a general insight.
  const about = aboutTheProblem(memories);
  const ranked = [...about.filter((m) => m.kind === "failure"), ...about.filter((m) => m.kind === "insight")];
  for (const m of ranked.slice(0, MAX_MEMORY_CITATIONS)) {
    citations.push({ kind: m.kind === "failure" ? "failure" : "insight", ref: m.key, text: m.text });
  }
  for (const d of docs) {
    citations.push({ kind: "knowledge", ref: d.file, text: d.title ?? basename(d.file) });
  }
  return citations;
}

// ---------------------------------------------------------------------------
// the directive
// ---------------------------------------------------------------------------

const STALL_STEPS: readonly string[] = [
  "Name the direction you are about to take, and say how it differs from every line above. If you cannot, you do not have a new idea yet.",
  "Change one thing, then `avo score` before you change a second — two edits at once cannot be attributed.",
  "`avo commit --why \"<the direction>\"` when it measures better. A refusal is a measurement: record it with `avo mem add`, do not retry it.",
  "If every direction you can name is already above, do not guess: `avo fan --n 4` explores four at once and lets `f` choose, and `avo know search \"<question>\"` puts what you find into `K`.",
];

const THRASH_STEPS: readonly string[] = [
  "Read the failure before editing again — the same error N times means the *diagnosis* is wrong, not the edit. `avo score --json` carries the scorer's log.",
  "Get back to a measurable state first: `avo best` names the version to return to, and `git diff` shows what you have actually changed since.",
  "Then change direction, not degree. A smaller version of the same edit fails the same way.",
];

export function renderDirective(state: SuperviseState, signals: readonly Signal[], citations: readonly Citation[]): string {
  const lines: string[] = ["STEERING (avo supervise)", ""];
  for (const s of signals) lines.push(`- ${s.kind}: ${s.detail}`);
  lines.push("", "Read this before editing anything:", "  avo lineage            # every version and its score");
  if (state.best !== null) lines.push(`  avo lineage show ${state.best.version}     # the version to beat, and why it won`);
  lines.push("  avo mem prime          # what earlier runs already learned", "");

  const group = (kind: Citation["kind"], title: string) => {
    const items = citations.filter((c) => c.kind === kind);
    if (items.length === 0) return;
    lines.push(title);
    for (const c of items) lines.push(`  - ${c.ref} — ${c.text}`);
    lines.push("");
  };
  group("version", "Already committed (a variation that only re-derives one of these is not progress):");
  group("failure", "Known dead ends (do not re-try these):");
  group("insight", "Remembered:");
  group("knowledge", "In K and never mentioned by any version — unexplored:");

  const steps = signals.some((s) => s.kind === "thrash") ? THRASH_STEPS : STALL_STEPS;
  lines.push("Do this next:");
  steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  lines.push("");

  const text = lines.join("\n");
  return text.length <= DIRECTIVE_CAP ? text : `${text.slice(0, DIRECTIVE_CAP)}\n… (directive truncated)\n`;
}

export interface Supervision {
  /** Whether any signal fired. `avo supervise` exits 1 when it did, 0 when it did not. */
  triggered: boolean;
  state: SuperviseState;
  signals: Signal[];
  citations: Citation[];
  /** `null` when nothing fired: there is no directive to inject if there is nothing to steer. */
  directive: string | null;
  thresholds: { stall: number; thrash: number };
  warnings: string[];
}

export interface SuperviseDeps {
  runner: Runner;
}

export interface SuperviseOptions {
  json: boolean;
  cwd: string;
  /** `null` = take it from `.avo/config.json`, then the default. */
  stall: number | null;
  thrash: number | null;
}

export async function supervise(opts: SuperviseOptions, deps: SuperviseDeps): Promise<Supervision> {
  const { runner } = deps;
  const loaded = loadConfig(opts.cwd);
  const stall = opts.stall ?? loaded.config.supervise.stall;
  const thrash = opts.thrash ?? loaded.config.supervise.thrash;
  const warnings = [...loaded.warnings];

  const log = readAttempts(opts.cwd);
  warnings.push(...log.warnings);

  let versions: Version[] = [];
  if (await isGitRepo(runner, opts.cwd)) {
    const lineage = await readLineage(runner, opts.cwd);
    versions = lineage.versions;
    warnings.push(...lineage.warnings);
  } else {
    warnings.push(`${opts.cwd} is not a git repository, so there is no lineage to read; only the attempt log was examined`);
  }

  const { state, signals } = detect({ versions, attempts: log.attempts, total: log.total, stall, thrash });

  // Memory and K are read only to *cite*. A supervisor that cannot reach them still detects and
  // still steers, with a thinner directive — never with a crash (invariant 4).
  let memories: Memory[] = [];
  if (signals.length > 0) {
    const backend = await resolveBackend(runner, opts.cwd);
    warnings.push(...backend.warnings);
    const listed = await listMemories(runner, opts.cwd, backend);
    memories = listed.memories;
    warnings.push(...listed.warnings);
  }
  const docs = signals.length > 0 ? unexplored(listDocs(opts.cwd, "knowledge"), exploredCorpus(versions, memories)) : [];
  const citations = signals.length > 0 ? citationsFor(versions, memories, docs) : [];

  return {
    triggered: signals.length > 0,
    state,
    signals,
    citations,
    directive: signals.length > 0 ? renderDirective(state, signals, citations) : null,
    thresholds: { stall, thrash },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------

export function parseSuperviseArgs(argv: readonly string[]): SuperviseOptions | { error: string } {
  const opts: SuperviseOptions = { json: false, cwd: process.cwd(), stall: null, thrash: null };
  const int = (raw: string | undefined, flag: string, min: number): number | { error: string } => {
    const n = Number(raw);
    if (raw === undefined || !Number.isInteger(n) || n < min) {
      return { error: `avo supervise: ${flag} needs an integer >= ${min}` };
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      case "--stall": {
        const n = int(argv[i + 1], "--stall", 1);
        if (typeof n !== "number") return n;
        opts.stall = n;
        i++;
        break;
      }
      case "--thrash": {
        const n = int(argv[i + 1], "--thrash", 2);
        if (typeof n !== "number") return n;
        opts.thrash = n;
        i++;
        break;
      }
      case "--cwd": {
        const v = argv[i + 1];
        if (v === undefined) return { error: "avo supervise: --cwd needs a directory" };
        opts.cwd = v;
        i++;
        break;
      }
      default:
        return { error: `avo supervise: unknown option '${a}'` };
    }
  }
  return opts;
}

export function renderSupervision(s: Supervision): string {
  const lines = ["avo supervise", ""];
  for (const w of s.warnings) lines.push(`warning: ${w}`);
  if (s.warnings.length > 0) lines.push("");

  const b = s.state.best;
  lines.push(
    `  best         ${b === null ? "— (nothing committed yet)" : `v${b.version} ${fmtScore(b.primary, b.unit)} (${b.sha.slice(0, 8)})`}`,
    `  attempts     ${s.state.attempts}${s.state.analyzed < s.state.attempts ? ` (last ${s.state.analyzed} examined)` : ""}`,
    `  since best   ${s.state.since_best} / ${s.thresholds.stall}`,
    `  failing      ${s.state.failing_streak} in a row, ${s.state.repeat} of them the same way / ${s.thresholds.thrash}`,
    "",
  );

  if (!s.triggered) {
    lines.push("no intervention: the loop is still making progress", "");
    return `${lines.join("\n")}\n`;
  }
  lines.push(s.directive ?? "");
  return `${lines.join("\n")}\n`;
}

/** 0 = no intervention needed, 1 = a signal fired and a directive was emitted, 2 = harness error. */
export async function superviseCommand(argv: readonly string[], io: Io, runner: Runner = spawnRunner): Promise<number> {
  const opts = parseSuperviseArgs(argv);
  if ("error" in opts) {
    io.err(`${opts.error}\n`);
    return 2;
  }
  const result = await supervise(opts, { runner });
  io.out(opts.json ? `${JSON.stringify(result)}\n` : renderSupervision(result));
  return result.triggered ? 1 : 0;
}
