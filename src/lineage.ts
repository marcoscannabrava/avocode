import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareVectors, formatRel, scoreVector, type Comparison, type Scored, type Vector } from "./compare.ts";
import { loadConfig, type AvoConfig } from "./config.ts";
import type { Io } from "./io.ts";
import { MEMORY_PATH, remember, resolveBackend, shortHash, type MemoryInput } from "./mem.ts";
import { runScore, spawnRunner, type Attempt, type RunResult, type Runner, type ScoreOptions } from "./score.ts";

/** Rendered, human- and qmd-readable record of each committed version. */
export const LINEAGE_DIR = "lineage";
/**
 * Trajectory, not population. These are written *by* the harness during a variation step, so they
 * must never enter the lineage: committing them would make every version's diff include the log of
 * how it was reached, and would leave the working tree permanently dirty — which would in turn
 * defeat the no-op check below.
 */
export const TRAJECTORY_PATHS: readonly string[] = [".avo/attempts.jsonl", ".avo/worktrees", ".avo/runs"];
const TRAJECTORY_IGNORE = ".avo/.gitignore";
/**
 * What `.avo/.gitignore` says, one entry per trajectory path — patterns relative to `.avo/`, with a
 * trailing slash on the directories. A test asserts every TRAJECTORY_PATH has an entry, because the
 * two lists drifting apart is silent: the path stays unstaged by `avo commit` and still shows up in
 * `git status` for every other tool the operator runs.
 */
const IGNORE_ENTRIES: readonly string[] = ["attempts.jsonl", "worktrees/", "runs/"];
/**
 * Any `.avo/.gitignore` opening with this is ours to extend. Matched by prefix, not equality: files
 * written before `avo run` existed say "written by avo commit", and they must still receive the
 * entry for a path added later — which is the bug this replaced. A file *without* the marker is the
 * operator's and is never touched.
 */
const IGNORE_MARKER = "# written by avo";
const IGNORE_HEADER = `${IGNORE_MARKER}: trajectory, not lineage`;
/**
 * Everything avo writes *by itself*. None of it may make the working tree read as a candidate
 * change: the trajectory log and the harness gitignore are ours, and so is the memory log, which
 * `avo commit` appends to *after* committing. Without this, the memory written for v1 would make
 * the next run see a change the agent never made — scoring an unchanged tree, refusing it as no
 * improvement, and remembering that refusal, which dirties the tree again.
 *
 * Unlike TRAJECTORY_PATHS these are not unstaged: `.avo/.gitignore` and `lineage/memory.jsonl`
 * belong in the repository, they are just not evidence of a variation.
 */
export const HARNESS_PATHS: readonly string[] = [...TRAJECTORY_PATHS, TRAJECTORY_IGNORE, MEMORY_PATH];
/** `git notes --ref=avo` carries the full attempt; trailers carry only what the comparator needs. */
export const NOTES_REF = "avo";
export const VERSION_TRAILER = "Avo-Version";
export const SCORE_TRAILER = "Avo-Score";

/** ASCII unit/record separators — safe in a commit message, unlike anything a human might type. */
const US = "\x1f";
const RS = "\x1e";

/** The compact score carried in the `Avo-Score` trailer: exactly what the comparator reads back. */
export interface VersionScore extends Scored {
  primary: number | null;
  unit: string;
  higher_is_better: boolean;
  scores: Record<string, number>;
}

export interface Version {
  version: number;
  sha: string;
  date: string;
  subject: string;
  /** The agent's rationale, from `avo commit --why`. */
  why: string | null;
  score: VersionScore;
}

export function isVersionScore(v: unknown): v is VersionScore {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    (typeof o["primary"] === "number" || o["primary"] === null) &&
    typeof o["unit"] === "string" &&
    typeof o["higher_is_better"] === "boolean" &&
    typeof o["scores"] === "object" &&
    o["scores"] !== null
  );
}

export function toVersionScore(a: Attempt): VersionScore {
  return {
    primary: a.primary,
    unit: a.unit,
    higher_is_better: a.higher_is_better,
    // Persist the vector the comparator will actually use, so a later version compares against the
    // same keys whether or not the scorer reported a `scores` object (PLAN §6 Q1).
    scores: Object.keys(a.scores).length > 0 ? a.scores : a.primary === null ? {} : { "*": a.primary },
  };
}

/** Reads the last `Trailer: value` line. Last wins: a rebase can prepend an older message body. */
function trailer(message: string, key: string): string | null {
  let found: string | null = null;
  for (const line of message.split("\n")) {
    const m = new RegExp(`^${key}:[ \\t]*(.*)$`).exec(line.trim());
    if (m !== null) found = (m[1] ?? "").trim();
  }
  return found;
}

/** The commit body with subject and avo trailers removed — what the agent actually wrote. */
export function extractWhy(message: string): string | null {
  const lines = message.split("\n");
  const body = lines
    .slice(1)
    .filter((l) => trailer(l, VERSION_TRAILER) === null && trailer(l, SCORE_TRAILER) === null)
    .join("\n")
    .trim();
  return body === "" ? null : body;
}

export interface Lineage {
  versions: Version[];
  warnings: string[];
}

export async function git(runner: Runner, cwd: string, args: readonly string[]): Promise<RunResult> {
  return await runner("git", args, { cwd, timeoutMs: 60_000 });
}

/** Drops what avo wrote itself, so a repo the agent did not touch still reads as clean. */
export function withoutTrajectory(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter((l) => l.trim() !== "")
    .filter((l) => {
      // porcelain v1: XY <path>, where a rename is "XY old -> new".
      const path = l.slice(3).split(" -> ").pop() ?? "";
      const clean = path.replace(/^"|"$/g, "");
      return !HARNESS_PATHS.some((t) => clean === t || clean.startsWith(`${t}/`));
    });
}

/**
 * Idempotent, and *additive*: a file we wrote gains any entry it is missing, so a repo that has been
 * running avo since before `.avo/runs/` existed still stops tracking it. Returning early on an
 * existing file — the original behaviour — meant a new trajectory path was ignored only in repos
 * created after it, which is the worst kind of divergence: it works on the machine that added it.
 *
 * A `.avo/.gitignore` without our marker belongs to the operator and is left exactly as it is.
 */
export function ensureTrajectoryIgnored(cwd: string): void {
  const path = join(cwd, TRAJECTORY_IGNORE);
  let existing: string | null;
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    existing = null;
  }
  try {
    if (existing === null) {
      mkdirSync(join(cwd, ".avo"), { recursive: true });
      writeFileSync(path, `${IGNORE_HEADER}\n${IGNORE_ENTRIES.join("\n")}\n`);
      return;
    }
    const lines = existing.split("\n").map((l) => l.trim());
    if (!lines.some((l) => l.startsWith(IGNORE_MARKER))) return;
    const missing = IGNORE_ENTRIES.filter((e) => !lines.includes(e));
    if (missing.length === 0) return;
    const body = existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
    writeFileSync(path, `${body}${missing.join("\n")}\n`);
  } catch {
    // A read-only .avo just means the paths get unstaged explicitly instead; not worth failing on.
  }
}

export async function isGitRepo(runner: Runner, cwd: string): Promise<boolean> {
  const r = await git(runner, cwd, ["rev-parse", "--git-dir"]);
  return r.code === 0 && r.spawnError === null;
}

/**
 * `P_t` — the committed lineage, read from git and nothing else. Attempts live in
 * `.avo/attempts.jsonl` and are trajectory, not population: a version exists iff a commit carries
 * the trailers, which is what makes `avo commit` the only writer (invariant 1).
 */
export async function readLineage(runner: Runner, cwd: string): Promise<Lineage> {
  const log = await git(runner, cwd, ["log", `--format=%H${US}%aI${US}%B${RS}`, "HEAD"]);
  if (log.code !== 0 || log.spawnError !== null) return { versions: [], warnings: [] };

  const warnings: string[] = [];
  const versions: Version[] = [];
  const seen = new Set<number>();
  for (const record of log.stdout.split(RS)) {
    const [sha, date, message] = record.replace(/^\n+/, "").split(US);
    if (sha === undefined || date === undefined || message === undefined) continue;
    const raw = trailer(message, VERSION_TRAILER);
    if (raw === null) continue;
    const version = Number(raw);
    if (!Number.isInteger(version) || version < 1) {
      warnings.push(`commit ${sha.slice(0, 7)} has an unreadable ${VERSION_TRAILER} trailer ('${raw}'); skipped`);
      continue;
    }
    const scoreRaw = trailer(message, SCORE_TRAILER);
    let score: unknown;
    try {
      score = JSON.parse(scoreRaw ?? "");
    } catch {
      score = null;
    }
    if (!isVersionScore(score)) {
      warnings.push(`commit ${sha.slice(0, 7)} (v${version}) has no readable ${SCORE_TRAILER} trailer; skipped`);
      continue;
    }
    // git log is newest-first, so the first sighting of a number is the surviving one after a
    // cherry-pick or a rebase that duplicated it.
    if (seen.has(version)) {
      warnings.push(`v${version} appears on more than one commit; using the most recent (${sha.slice(0, 7)})`);
      continue;
    }
    seen.add(version);
    versions.push({
      version,
      sha,
      date,
      subject: message.split("\n")[0]?.trim() ?? "",
      why: extractWhy(message),
      score,
    });
  }
  versions.sort((a, b) => a.version - b.version);
  return { versions, warnings };
}

/**
 * The best committed version is the highest-numbered one: the commit rule only admits a version
 * that did not regress against its predecessor, so the lineage is monotone by construction under
 * whatever reduction was in force.
 */
export function bestVersion(versions: readonly Version[]): Version | null {
  return versions.length === 0 ? null : (versions.reduce((a, b) => (b.version > a.version ? b : a)) as Version);
}

export interface CommitDecision {
  action: "committed" | "refused" | "noop" | "would-commit";
  version: number | null;
  sha: string | null;
  reason: string;
  comparison: Comparison | null;
  attempt: Attempt | null;
  best: { version: number; sha: string } | null;
  lineage_file: string | null;
  warnings: string[];
  errors: string[];
}

const fmt = (v: number | null, unit: string): string => (v === null ? "—" : `${v} ${unit}`.trim());

export function renderLineageFile(
  version: number,
  score: VersionScore,
  cmp: Comparison,
  why: string | null,
  diffstat: string,
  ts: string,
  best: Version | null,
): string {
  const dir = score.higher_is_better ? "higher is better" : "lower is better";
  const sign = score.higher_is_better ? 1 : -1;
  const lines = [
    `# v${version}`,
    "",
    `- **scored** ${fmt(score.primary, score.unit)} (${dir})`,
    `- **parent** ${best === null ? "— (first version)" : `v${best.version} \`${best.sha.slice(0, 7)}\``}`,
    `- **decision** ${cmp.decision} — ${cmp.reason}`,
    `- **committed** ${ts}`,
    "",
    "## scores",
    "",
  ];
  if (cmp.deltas.length > 0) {
    lines.push(
      `| config | v${best?.version ?? "—"} | v${version} | delta |`,
      "| --- | ---: | ---: | ---: |",
      ...cmp.deltas.map((d) => `| \`${d.config}\` | ${d.best * sign} | ${d.candidate * sign} | ${formatRel(d.rel)} |`),
    );
  } else {
    lines.push(
      "| config | value |",
      "| --- | ---: |",
      ...Object.entries(score.scores).map(([k, v]) => `| \`${k}\` | ${v} |`),
    );
  }
  if (cmp.added.length > 0) {
    lines.push("", `New configs in this version: ${cmp.added.map((c) => `\`${c}\``).join(", ")}.`);
  }
  lines.push(
    "",
    "## rationale",
    "",
    why ?? "_(none recorded — `avo commit --why` was not given)_",
    "",
    "## diff",
    "",
    "```",
    diffstat.trim() || "(no changes reported)",
    "```",
    "",
  );
  return lines.join("\n");
}

export function renderDecision(d: CommitDecision): string {
  const lines: string[] = ["avo commit", ""];
  for (const w of d.warnings) lines.push(`warning: ${w}`);
  for (const e of d.errors) lines.push(`error: ${e}`);
  if (d.warnings.length > 0 || d.errors.length > 0) lines.push("");
  if (d.attempt !== null) {
    const a = d.attempt;
    lines.push(`  scored       ${fmt(a.primary, a.unit)}${a.pass ? "" : "  (correctness gate: FAILED)"}`);
  }
  if (d.best !== null) lines.push(`  best         v${d.best.version} (${d.best.sha.slice(0, 7)})`);
  const sign = d.attempt?.higher_is_better === false ? -1 : 1;
  for (const delta of d.comparison?.deltas ?? []) {
    lines.push(
      `  ${delta.config.padEnd(12)} ${delta.best * sign} -> ${delta.candidate * sign}  ` +
        `${formatRel(delta.rel)}  ${delta.verdict}`,
    );
  }
  lines.push("");
  if (d.action === "committed") lines.push(`committed v${d.version} as ${d.sha?.slice(0, 7)} — ${d.reason}`);
  else if (d.action === "would-commit") lines.push(`would commit v${d.version} — ${d.reason}`);
  else if (d.action === "noop") lines.push(`no-op — ${d.reason}`);
  else lines.push(`refused — ${d.reason}`);
  return `${lines.join("\n")}\n`;
}

export interface CommitOptions extends ScoreOptions {
  why: string | null;
  dryRun: boolean;
}

export function parseCommitArgs(argv: readonly string[]): CommitOptions | { error: string } {
  const opts: CommitOptions = {
    json: false,
    parallel: false,
    timeoutS: 0,
    init: null,
    force: false,
    record: true,
    cwd: process.cwd(),
    why: null,
    dryRun: false,
  };
  const need = (i: number, flag: string): string | { error: string } => {
    const v = argv[i + 1];
    if (v === undefined) return { error: `avo commit: ${flag} needs a value` };
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      case "--parallel":
        opts.parallel = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--no-record":
        opts.record = false;
        break;
      case "--why": {
        const v = need(i, "--why");
        if (typeof v !== "string") return v;
        opts.why = v;
        i++;
        break;
      }
      case "--cwd": {
        const v = need(i, "--cwd");
        if (typeof v !== "string") return v;
        opts.cwd = v;
        i++;
        break;
      }
      case "--timeout": {
        const v = need(i, "--timeout");
        if (typeof v !== "string") return v;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) {
          return { error: `avo commit: --timeout needs a non-negative number, got '${v}'` };
        }
        opts.timeoutS = n;
        i++;
        break;
      }
      default:
        return { error: `avo commit: unknown option '${a}'` };
    }
  }
  return opts;
}

function refusal(reason: string, extra: Partial<CommitDecision> = {}): CommitDecision {
  return {
    action: "refused",
    version: null,
    sha: null,
    reason,
    comparison: null,
    attempt: null,
    best: null,
    lineage_file: null,
    warnings: [],
    errors: [],
    ...extra,
  };
}

/**
 * The commit rule (paper §3.2): persist a new version only when it passes correctness *and* beats
 * the best committed version. `avo commit` is the only writer of committed lineage (invariant 1),
 * and it always scores first — you cannot commit a version whose score you did not measure.
 */
export async function decideCommit(opts: CommitOptions, runner: Runner, now: () => Date): Promise<CommitDecision> {
  if (!(await isGitRepo(runner, opts.cwd))) {
    return refusal(`${opts.cwd} is not a git repository; the lineage lives in git`, {
      errors: ["not a git repository"],
    });
  }
  const head = await git(runner, opts.cwd, ["rev-parse", "HEAD"]);
  if (head.code !== 0) {
    return refusal("the repository has no commits yet; make an initial commit before evolving it", {
      errors: ["no HEAD"],
    });
  }

  // Idempotency (invariant 5): nothing changed means nothing to persist. Re-running must never
  // append a duplicate version — the lineage records variations, not invocations.
  ensureTrajectoryIgnored(opts.cwd);
  const status = await git(runner, opts.cwd, ["status", "--porcelain"]);
  if (withoutTrajectory(status.stdout).length === 0) {
    return {
      ...refusal("the working tree holds no change to score; there is nothing to commit"),
      action: "noop",
    };
  }

  const { config, warnings: configWarnings } = loadConfig(opts.cwd);
  const { attempt, error } = await runScore(opts, runner, now);
  if (attempt === null) {
    return refusal(error ?? "scoring failed", { errors: [error ?? "scoring failed"], warnings: configWarnings });
  }
  const warnings = [...configWarnings, ...attempt.warnings];

  const { versions, warnings: lineageWarnings } = await readLineage(runner, opts.cwd);
  warnings.push(...lineageWarnings);
  const best = bestVersion(versions);
  const bestRef = best === null ? null : { version: best.version, sha: best.sha };

  if (attempt.errors.length > 0) {
    return refusal("the scorer did not produce a usable result, so this candidate cannot be ranked", {
      attempt,
      best: bestRef,
      warnings,
      errors: attempt.errors,
    });
  }
  // Invariant 2: a failing `f` never yields a commit, whatever it measured.
  if (!attempt.pass) {
    return refusal(
      attempt.correct
        ? "the scorer reported ok:false, so the measurement is not trustworthy"
        : "the candidate failed correctness; a failing f never yields a commit",
      { attempt, best: bestRef, warnings },
    );
  }

  const candidate: Vector = scoreVector(attempt);
  const bestVec: Vector | null = best === null ? null : scoreVector(best.score);
  const cmp = compareVectors(candidate, bestVec, config, {
    candidateHigherIsBetter: attempt.higher_is_better,
    bestHigherIsBetter: best?.score.higher_is_better,
  });
  const common = { attempt, best: bestRef, comparison: cmp, warnings };

  if (!cmp.commit) return refusal(cmp.reason, common);
  if (opts.dryRun) {
    const would = `${cmp.reason} — would commit v${(best?.version ?? 0) + 1} (--dry-run, nothing written)`;
    return { ...refusal(would, common), action: "would-commit", version: (best?.version ?? 0) + 1 };
  }
  return await writeCommit(opts, runner, now, attempt, cmp, best, warnings);
}

/** Everything that touches the repository, split out so the decision above stays readable. */
async function writeCommit(
  opts: CommitOptions,
  runner: Runner,
  now: () => Date,
  attempt: Attempt,
  cmp: Comparison,
  best: Version | null,
  warnings: string[],
): Promise<CommitDecision> {
  const version = (best?.version ?? 0) + 1;
  const score = toVersionScore(attempt);
  const bestRef = best === null ? null : { version: best.version, sha: best.sha };
  const fail = (msg: string): CommitDecision =>
    refusal(msg, { attempt, comparison: cmp, best: bestRef, warnings, errors: [msg] });

  const add = await git(runner, opts.cwd, ["add", "-A"]);
  if (add.code !== 0) return fail(`git add failed: ${add.stderr.trim() || add.stdout.trim()}`);
  // .gitignore covers a fresh repo; this covers one where the attempt log was already tracked.
  await git(runner, opts.cwd, ["reset", "-q", "HEAD", "--", ...TRAJECTORY_PATHS]);

  // The diffstat comes from the index *before* the lineage file is written, so it describes the
  // change that was scored rather than the record of it.
  const stat = await git(runner, opts.cwd, ["diff", "--cached", "--stat", "HEAD"]);
  const diffstat = stat.code === 0 ? stat.stdout : "";

  const relPath = join(LINEAGE_DIR, `v${String(version).padStart(3, "0")}.md`);
  const absPath = join(opts.cwd, relPath);
  try {
    mkdirSync(join(opts.cwd, LINEAGE_DIR), { recursive: true });
    writeFileSync(absPath, renderLineageFile(version, score, cmp, opts.why, diffstat, now().toISOString(), best));
  } catch (e) {
    return fail(`could not write ${relPath} — ${(e as Error).message}`);
  }
  const addLineage = await git(runner, opts.cwd, ["add", "--", relPath]);
  if (addLineage.code !== 0) {
    rmSync(absPath, { force: true });
    return fail(`git add ${relPath} failed: ${addLineage.stderr.trim()}`);
  }

  const subject = `avo v${version}: ${fmt(score.primary, score.unit)}`;
  const why = opts.why !== null && opts.why.trim() !== "" ? [opts.why] : [];
  const trailers = `${VERSION_TRAILER}: ${version}\n${SCORE_TRAILER}: ${JSON.stringify(score)}`;
  const commit = await git(runner, opts.cwd, ["commit", "-m", subject, ...why.flatMap((w) => ["-m", w]), "-m", trailers]);
  if (commit.code !== 0) {
    // The index keeps what we staged, but the record of a version that does not exist must go.
    rmSync(absPath, { force: true });
    return fail(`git commit failed: ${(commit.stderr + commit.stdout).trim()}`);
  }

  const sha = (await git(runner, opts.cwd, ["rev-parse", "HEAD"])).stdout.trim();
  // `-f` keeps a re-attached note idempotent; a missing note is a warning, never a failed commit.
  const note = await git(runner, opts.cwd, [
    "notes",
    `--ref=${NOTES_REF}`,
    "add",
    "-f",
    "-m",
    JSON.stringify({ version, attempt, comparison: cmp, why: opts.why }),
    sha,
  ]);
  if (note.code !== 0) {
    warnings.push(`could not write git notes --ref=${NOTES_REF} for ${sha.slice(0, 7)}: ${note.stderr.trim()}`);
  }

  return {
    action: "committed",
    version,
    sha,
    reason: cmp.reason,
    comparison: cmp,
    attempt,
    best: bestRef,
    lineage_file: relPath,
    warnings,
    errors: [],
  };
}

/**
 * Mirrors the decision into memory (S3): a committed version becomes a bead linked to its parent,
 * a refused candidate becomes an insight so the agent stops re-trying that dead end across
 * sessions. Memory is a cache of *why*, never the source of truth — a failure here is a warning on
 * an otherwise good commit, never a failed commit.
 */
export async function recordDecisionMemory(
  opts: CommitOptions,
  d: CommitDecision,
  runner: Runner,
  now: () => Date,
): Promise<string[]> {
  // --no-record and --dry-run both mean "write nothing about this run"; a no-op ran no variation,
  // and a harness error (no attempt) taught us nothing about the candidate.
  if (!opts.record || opts.dryRun || d.attempt === null) return [];
  if (d.action !== "committed" && d.action !== "refused") return [];
  if (d.action === "refused" && d.errors.length > 0) return [];

  const backend = await resolveBackend(runner, opts.cwd);
  const a = d.attempt;
  const vector = Object.entries(a.scores)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

  let input: MemoryInput;
  if (d.action === "committed" && d.version !== null) {
    const detail = [`score ${fmt(a.primary, a.unit)}`, vector === "" ? "" : `scores ${vector}`, d.reason]
      .filter((s) => s !== "")
      .join("\n");
    input = {
      kind: "version",
      key: `avo-v${d.version}`,
      text: `avo v${d.version}: ${fmt(a.primary, a.unit)}`,
      version: d.version,
      detail,
      // The lineage is a chain: version N descends from the version it beat.
      parentVersion: d.best?.version ?? null,
    };
  } else {
    const from = d.best === null ? "the empty lineage" : `v${d.best.version}`;
    const detail = [`from ${from}`, vector === "" ? "" : `scores ${vector}`, opts.why ?? ""]
      .filter((s) => s !== "")
      .join("\n");
    input = {
      kind: "failure",
      // Keyed by content, so re-attempting the same dead end updates one record instead of piling
      // up — which is the whole point of remembering it.
      key: `avo-dead-end-${shortHash(`${d.reason}${vector}`)}`,
      text: `dead end from ${from}: ${d.reason}`,
      version: d.best?.version ?? null,
      detail,
    };
  }

  const w = await remember(runner, opts.cwd, backend, input, now);
  return [...backend.warnings, ...w.warnings, ...(w.error === null ? [] : [w.error])];
}

/** Exit codes mirror `avo score`: 0 committed or no-op, 1 refused, 2 harness error. */
export async function commitCommand(
  argv: readonly string[],
  io: Io,
  runner: Runner = spawnRunner,
  now: () => Date = () => new Date(),
): Promise<number> {
  const parsed = parseCommitArgs(argv);
  if ("error" in parsed) {
    io.err(`${parsed.error}\n`);
    return 2;
  }
  const decision = await decideCommit(parsed, runner, now);
  decision.warnings.push(...(await recordDecisionMemory(parsed, decision, runner, now)));
  io.out(parsed.json ? `${JSON.stringify(decision)}\n` : renderDecision(decision));
  if (decision.errors.length > 0) return 2;
  return decision.action === "refused" ? 1 : 0;
}

export interface LineageOptions {
  json: boolean;
  cwd: string;
  sub: "list" | "show" | "diff";
  args: string[];
}

export function parseLineageArgs(argv: readonly string[]): LineageOptions | { error: string } {
  const opts: LineageOptions = { json: false, cwd: process.cwd(), sub: "list", args: [] };
  let sawSub = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--json") opts.json = true;
    else if (a === "--cwd") {
      const v = argv[i + 1];
      if (v === undefined) return { error: "avo lineage: --cwd needs a value" };
      opts.cwd = v;
      i++;
    } else if (a.startsWith("-")) return { error: `avo lineage: unknown option '${a}'` };
    else if (!sawSub && (a === "show" || a === "diff")) {
      opts.sub = a;
      sawSub = true;
    } else opts.args.push(a);
  }
  if (opts.sub === "show" && opts.args.length !== 1) {
    return { error: "avo lineage show: needs exactly one version number, e.g. 'avo lineage show 3'" };
  }
  if (opts.sub === "diff" && opts.args.length !== 2) {
    return { error: "avo lineage diff: needs two version numbers, e.g. 'avo lineage diff 1 3'" };
  }
  if (opts.sub === "list" && opts.args.length > 0) {
    return { error: `avo lineage: unknown argument '${opts.args[0]}'; try 'show <n>' or 'diff <a> <b>'` };
  }
  return opts;
}

function findVersion(versions: readonly Version[], ref: string): Version | { error: string } {
  const n = Number(ref.replace(/^v/i, ""));
  if (!Number.isInteger(n)) return { error: `'${ref}' is not a version number` };
  const found = versions.find((v) => v.version === n);
  if (found === undefined) {
    const known = versions.map((v) => `v${v.version}`).join(", ") || "(none)";
    return { error: `no version v${n} in the lineage; known versions: ${known}` };
  }
  return found;
}

export function renderLineage(l: Lineage, cfg: AvoConfig): string {
  const lines: string[] = ["avo lineage", ""];
  for (const w of l.warnings) lines.push(`warning: ${w}`);
  if (l.warnings.length > 0) lines.push("");
  if (l.versions.length === 0) {
    lines.push("no committed versions yet — `avo commit` writes the first one", "");
    return `${lines.join("\n")}\n`;
  }
  const configs = [...new Set(l.versions.flatMap((v) => Object.keys(v.score.scores)))].sort();
  lines.push(`  ver  commit   ${"primary".padEnd(16)}${configs.map((c) => c.padStart(12)).join("")}`);
  for (const v of l.versions) {
    lines.push(
      `  v${String(v.version).padEnd(3)} ${v.sha.slice(0, 7)}  ${fmt(v.score.primary, v.score.unit).padEnd(16)}` +
        configs.map((c) => String(v.score.scores[c] ?? "—").padStart(12)).join(""),
    );
  }
  const best = bestVersion(l.versions);
  lines.push("", `best: v${best?.version} (${best?.sha.slice(0, 7)}); reduce: ${cfg.reduce}, floor: ${cfg.floor}`, "");
  return `${lines.join("\n")}\n`;
}

export function renderVersion(v: Version): string {
  const dir = v.score.higher_is_better ? "higher is better" : "lower is better";
  const lines = [
    `v${v.version}  ${v.sha}`,
    `  date     ${v.date}`,
    `  subject  ${v.subject}`,
    `  primary  ${fmt(v.score.primary, v.score.unit)} (${dir})`,
    ...Object.entries(v.score.scores).map(([k, s]) => `  ${k.padEnd(8)} ${s}`),
    "",
    v.why ?? "(no rationale recorded)",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export async function lineageCommand(argv: readonly string[], io: Io, runner: Runner = spawnRunner): Promise<number> {
  const parsed = parseLineageArgs(argv);
  if ("error" in parsed) {
    io.err(`${parsed.error}\n`);
    return 2;
  }
  const opts = parsed;
  const notRepo = (cmd: string): number => {
    const msg = `${opts.cwd} is not a git repository; the lineage lives in git`;
    if (opts.json) io.out(`${JSON.stringify({ error: msg })}\n`);
    else io.err(`${cmd}: ${msg}\n`);
    return 2;
  };
  if (!(await isGitRepo(runner, opts.cwd))) return notRepo("avo lineage");
  const lineage = await readLineage(runner, opts.cwd);

  if (opts.sub === "list") {
    const { config } = loadConfig(opts.cwd);
    io.out(opts.json ? `${JSON.stringify(lineage.versions)}\n` : renderLineage(lineage, config));
    return 0;
  }

  const refs = opts.args.map((a) => findVersion(lineage.versions, a));
  for (const r of refs) {
    if ("error" in r) {
      if (opts.json) io.out(`${JSON.stringify({ error: r.error })}\n`);
      else io.err(`avo lineage ${opts.sub}: ${r.error}\n`);
      return 2;
    }
  }

  if (opts.sub === "show") {
    const v = refs[0] as Version;
    io.out(opts.json ? `${JSON.stringify(v)}\n` : renderVersion(v));
    return 0;
  }

  const from = refs[0] as Version;
  const to = refs[1] as Version;
  const { config } = loadConfig(opts.cwd);
  const cmp = compareVectors(scoreVector(to.score), scoreVector(from.score), config, {
    candidateHigherIsBetter: to.score.higher_is_better,
    bestHigherIsBetter: from.score.higher_is_better,
  });
  const patch = await git(runner, opts.cwd, ["diff", `${from.sha}..${to.sha}`]);
  if (opts.json) {
    io.out(`${JSON.stringify({ from: from.version, to: to.version, comparison: cmp, patch: patch.stdout })}\n`);
    return 0;
  }
  const sign = to.score.higher_is_better ? 1 : -1;
  const lines = [`avo lineage diff v${from.version} -> v${to.version}`, ""];
  for (const d of cmp.deltas) {
    lines.push(`  ${d.config.padEnd(12)} ${d.best * sign} -> ${d.candidate * sign}  ${formatRel(d.rel)}  ${d.verdict}`);
  }
  lines.push("", cmp.reason, "", patch.stdout);
  io.out(`${lines.join("\n")}\n`);
  return 0;
}

/** `avo best` — the version every new candidate is ranked against. Exits 1 when there is none. */
export async function bestCommand(argv: readonly string[], io: Io, runner: Runner = spawnRunner): Promise<number> {
  const parsed = parseLineageArgs(argv);
  if ("error" in parsed) {
    io.err(`${parsed.error.replace("avo lineage", "avo best")}\n`);
    return 2;
  }
  const opts = parsed;
  if (!(await isGitRepo(runner, opts.cwd))) {
    const msg = `${opts.cwd} is not a git repository; the lineage lives in git`;
    if (opts.json) io.out(`${JSON.stringify({ error: msg })}\n`);
    else io.err(`avo best: ${msg}\n`);
    return 2;
  }
  const { versions } = await readLineage(runner, opts.cwd);
  const best = bestVersion(versions);
  if (best === null) {
    if (opts.json) io.out(`${JSON.stringify(null)}\n`);
    else io.out("no committed versions yet — `avo commit` writes the first one\n");
    return 1;
  }
  io.out(opts.json ? `${JSON.stringify(best)}\n` : renderVersion(best));
  return 0;
}
