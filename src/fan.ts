/**
 * Concurrency — `avo fan`. N variation directions explored at once, each in its own `git worktree`,
 * each by its own headless agent process. OS-level isolation and no shared state, the pattern
 * `mjakl/pi-subagent` validates (PLAN §2); the guards below are the same four it carries.
 *
 * Invariant 7 governs the whole file: **worktrees are disposable, `main` is not.** `avo fan` never
 * writes outside a worktree, and promoting a probe is a separate, explicit step.
 */

import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { loadConfig } from "./config.ts";
import { ensureTrajectoryIgnored, withoutTrajectory } from "./lineage.ts";
import type { Io } from "./io.ts";
import { parseAgentOutput, resolveTemplate, type AgentTemplate, type AgentTokens } from "./agents.ts";
import {
  concurrencyCap,
  mapLimit,
  runScore,
  spawnRunner,
  SCORER_PATH,
  type Attempt,
  type Runner,
} from "./score.ts";

/** Every run lives under here, which is gitignored *and* in TRAJECTORY_PATHS — trajectory, not lineage. */
export const WORKTREES_DIR = ".avo/worktrees";
export const MANIFEST_NAME = "manifest.json";

/** The four guards, as environment a probe inherits. A probe is an agent; it can call `avo fan` too. */
export const DEPTH_ENV = "AVO_FAN_DEPTH";
export const LEVEL_ENV = "AVO_FAN_LEVEL";
export const CHAIN_ENV = "AVO_FAN_CHAIN";
export const RUN_ENV = "AVO_FAN_RUN";
export const PROBE_ENV = "AVO_FAN_PROBE";
/** The small model probes run on (PLAN §3): only the winning direction is worth the big one. */
export const PROBE_MODEL_ENV = "AVO_PROBE_MODEL";
export const AGENT_ENV = "AVO_AGENT";

export const DEFAULT_DEPTH = 3;
export const DEFAULT_N = 3;
/** A headless agent with no limit is a process that never returns. 0 disables it, explicitly. */
export const DEFAULT_TIMEOUT_S = 900;

/** What `avo fan` returns per probe; anything larger goes to a file whose path we report. */
const SUMMARY_CAP_CHARS = 50_000;
const SUMMARY_CAP_LINES = 2_000;

const GIT_TIMEOUT_MS = 60_000;

export interface Diffstat {
  files: number;
  insertions: number;
  deletions: number;
  /** Paths the probe touched, so a human can see the shape of the change without reading the patch. */
  changed: string[];
}

/** The part of an `Attempt` a chooser actually compares. The full attempt stays in the worktree. */
export interface ProbeScore {
  pass: boolean;
  primary: number | null;
  normalized: number | null;
  unit: string;
  higher_is_better: boolean;
  scores: Record<string, number>;
  errors: string[];
}

export interface ProbeResult {
  /** 1-based, as `--promote <i>` takes it. */
  i: number;
  /** The agent process ran to completion and was not killed. Says nothing about the candidate. */
  ok: boolean;
  score: ProbeScore | null;
  diffstat: Diffstat;
  summary: string | null;
  /** Repo-relative, so the value is meaningful in a JSON line an agent reads from anywhere. */
  worktree: string;
  tokens: AgentTokens | null;
  wall_s: number;
  exit_code: number;
  timed_out: boolean;
  /** The agent's full stdout+stderr. Always written — a probe's reasoning is the evidence. */
  log_path: string;
  /** Set when the summary above was capped; the whole thing is in `log_path`. */
  truncated: boolean;
  error: string | null;
}

export interface FanResult {
  ok: boolean;
  run_id: string;
  cwd: string;
  agent: string;
  approval: string;
  model: string | null;
  n: number;
  baseline: string;
  concurrency: number;
  timeout_s: number;
  prompt_sha: string;
  results: ProbeResult[];
  /** Index of the best *passing* probe, or `null` when none scored. A hint, never a decision. */
  best: number | null;
  kept: string[];
  removed: string[];
  warnings: string[];
  errors: string[];
}

interface ManifestProbe {
  i: number;
  worktree: string;
  status: "pending" | "done";
  result: ProbeResult | null;
}

export interface Manifest {
  version: 1;
  run_id: string;
  started_at: string;
  finished_at: string | null;
  baseline: string;
  agent: string;
  model: string | null;
  timeout_s: number;
  prompt_sha: string;
  prompt: string;
  probes: ManifestProbe[];
}

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

export type FanMode = "run" | "promote" | "resume" | "list" | "clean";

export interface FanOptions {
  mode: FanMode;
  json: boolean;
  cwd: string;
  n: number;
  prompt: string | null;
  promptFile: string | null;
  agent: string | null;
  model: string | null;
  timeoutS: number;
  /** Keep every worktree, even the ones no probe changed. */
  keep: boolean;
  score: boolean;
  /** `--promote <i>`, `--resume <id>`, `--clean <id|all>` all land here. */
  target: string;
  runId: string | null;
}

export function parseFanArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): FanOptions | { error: string } {
  const opts: FanOptions = {
    mode: "run",
    json: false,
    cwd: process.cwd(),
    n: DEFAULT_N,
    prompt: null,
    promptFile: null,
    agent: env[AGENT_ENV] ?? null,
    model: env[PROBE_MODEL_ENV] ?? null,
    timeoutS: DEFAULT_TIMEOUT_S,
    keep: false,
    score: true,
    target: "",
    runId: null,
  };
  let sawMode = false;
  const value = (i: number, flag: string): string | { error: string } => {
    const v = argv[i + 1];
    if (v === undefined) return { error: `avo fan: ${flag} needs a value` };
    return v;
  };
  const setMode = (m: FanMode, flag: string): string | null => {
    if (sawMode) return `avo fan: ${flag} cannot be combined with another mode`;
    sawMode = true;
    opts.mode = m;
    return null;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--json") opts.json = true;
    else if (a === "--keep") opts.keep = true;
    else if (a === "--no-score") opts.score = false;
    else if (a === "--list") {
      const e = setMode("list", a);
      if (e !== null) return { error: e };
    } else {
      const v = value(i, a);
      if (typeof v !== "string") return v;
      switch (a) {
        case "--cwd":
          opts.cwd = v;
          break;
        case "--prompt":
          opts.prompt = v;
          break;
        case "--prompt-file":
          opts.promptFile = v;
          break;
        case "--agent":
          opts.agent = v;
          break;
        case "--model":
          opts.model = v;
          break;
        case "--run":
          opts.runId = v;
          break;
        case "-n":
        case "--n": {
          const n = Number(v);
          if (!Number.isInteger(n) || n < 1) return { error: `avo fan: --n needs a positive integer, got '${v}'` };
          opts.n = n;
          break;
        }
        case "--timeout": {
          const t = Number(v);
          if (!Number.isFinite(t) || t < 0) return { error: `avo fan: --timeout needs a non-negative number, got '${v}'` };
          opts.timeoutS = t;
          break;
        }
        case "--promote":
        case "--resume":
        case "--clean": {
          const e = setMode(a.slice(2) as FanMode, a);
          if (e !== null) return { error: e };
          opts.target = v;
          break;
        }
        default:
          return { error: `avo fan: unknown option '${a}'` };
      }
      i++;
    }
  }

  if (opts.mode === "run") {
    if (opts.prompt === null && opts.promptFile === null) {
      return { error: "avo fan: needs --prompt-file <f> or --prompt \"<text>\" — a probe with no task is not a probe" };
    }
    if (opts.prompt !== null && opts.promptFile !== null) {
      return { error: "avo fan: --prompt and --prompt-file are alternatives; pass one" };
    }
  }
  if (opts.mode === "promote") {
    const i = Number(opts.target);
    if (!Number.isInteger(i) || i < 1) return { error: `avo fan: --promote needs a probe number (1-based), got '${opts.target}'` };
  }
  return opts;
}

// ---------------------------------------------------------------------------
// the guards
// ---------------------------------------------------------------------------

export function promptSha(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 12);
}

export interface GuardsOk {
  ok: true;
  level: number;
  maxDepth: number;
  chain: string[];
  warnings: string[];
}

export interface GuardsRefused {
  ok: false;
  error: string;
}

/**
 * Depth and cycle prevention. Both matter because a probe *is* an agent: give it the avo skills and
 * it can call `avo fan` itself, and an unguarded fan-out of fan-outs is exponential in wall-clock
 * and in spend. The state travels in the environment because that is the only channel that survives
 * `spawn` into an arbitrary agent binary.
 */
export function checkGuards(env: NodeJS.ProcessEnv, sha: string): GuardsOk | GuardsRefused {
  const warnings: string[] = [];
  const parse = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      warnings.push(`${name}='${raw}' is not a non-negative integer; using ${fallback}`);
      return fallback;
    }
    return n;
  };
  const maxDepth = parse(DEPTH_ENV, DEFAULT_DEPTH);
  const level = parse(LEVEL_ENV, 0);
  const chain = (env[CHAIN_ENV] ?? "").split(",").filter((s) => s !== "");

  if (level >= maxDepth) {
    return {
      ok: false,
      error:
        `depth limit reached: this agent is ${level} level(s) deep and ${DEPTH_ENV} is ${maxDepth}. ` +
        `A probe at the limit must do the work itself, not fan out again (raise ${DEPTH_ENV} to change it).`,
    };
  }
  if (chain.includes(sha)) {
    return {
      ok: false,
      error:
        `cycle: this exact prompt (sha ${sha}) is already being explored higher in the fan-out chain ` +
        `(${chain.join(" -> ")}). Vary the prompt, or do the work here.`,
    };
  }
  return { ok: true, level, maxDepth, chain, warnings };
}

/** The environment a probe inherits: one level deeper, with this prompt added to the chain. */
export function probeEnv(g: GuardsOk, sha: string, runId: string, i: number): Record<string, string> {
  return {
    [DEPTH_ENV]: String(g.maxDepth),
    [LEVEL_ENV]: String(g.level + 1),
    [CHAIN_ENV]: [...g.chain, sha].join(","),
    [RUN_ENV]: runId,
    [PROBE_ENV]: String(i),
  };
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

interface Git {
  ok: boolean;
  out: string;
  err: string;
}

async function git(runner: Runner, cwd: string, args: readonly string[]): Promise<Git> {
  const r = await runner("git", args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
  return { ok: r.code === 0 && r.spawnError === null, out: r.stdout.trim(), err: (r.stderr || r.spawnError || "").trim() };
}

/**
 * `--numstat` against the baseline *commit* after `add -A -N`, which is the only combination that
 * sees all four states a probe can leave behind: committed, staged, unstaged, and untracked.
 * Ignored files (the attempt log, nested worktrees) stay out of it, which is what we want.
 */
export async function diffstatOf(runner: Runner, worktree: string, baseline: string): Promise<Diffstat> {
  await git(runner, worktree, ["add", "-A", "-N"]);
  const r = await git(runner, worktree, ["diff", "--numstat", baseline, "--"]);
  const stat: Diffstat = { files: 0, insertions: 0, deletions: 0, changed: [] };
  if (!r.ok) return stat;
  for (const line of r.out.split("\n")) {
    if (line.trim() === "") continue;
    const [add, del, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (path === "") continue;
    stat.files += 1;
    stat.insertions += Number(add) || 0; // "-" for binary files reads as 0, which is honest enough
    stat.deletions += Number(del) || 0;
    stat.changed.push(path);
  }
  return stat;
}

// ---------------------------------------------------------------------------
// run ids, manifests
// ---------------------------------------------------------------------------

/** Sortable, greppable, and derived from the prompt — two runs of the same prompt do not collide. */
export function makeRunId(now: Date, sha: string): string {
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${ts}-${sha.slice(0, 6)}`;
}

export function runDir(cwd: string, runId: string): string {
  return join(cwd, WORKTREES_DIR, runId);
}

export function readManifest(cwd: string, runId: string): Manifest | { error: string } {
  const path = join(runDir(cwd, runId), MANIFEST_NAME);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { error: `no run '${runId}' in ${WORKTREES_DIR} — list what survived with 'avo fan --list'` };
  }
  try {
    const m = JSON.parse(raw) as Manifest;
    if (m.version !== 1 || !Array.isArray(m.probes)) return { error: `${relative(cwd, path)} is not a v1 run manifest` };
    return m;
  } catch (e) {
    return { error: `${relative(cwd, path)} is corrupt (${(e as Error).message})` };
  }
}

/**
 * Rewritten after every probe, so a kill mid-fan-out leaves a manifest that names the worktrees and
 * the results already in hand — that is what `--resume` reattaches to.
 */
function writeManifest(cwd: string, m: Manifest): void {
  const dir = runDir(cwd, m.run_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MANIFEST_NAME), `${JSON.stringify(m, null, 2)}\n`);
}

export function listRuns(cwd: string): Manifest[] {
  let names: string[];
  try {
    names = readdirSync(join(cwd, WORKTREES_DIR));
  } catch {
    return [];
  }
  const runs: Manifest[] = [];
  for (const name of names.sort()) {
    const m = readManifest(cwd, name);
    if (!("error" in m)) runs.push(m);
  }
  return runs;
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

export interface Capped {
  text: string;
  truncated: boolean;
}

/** 50KB / 2000 lines, whichever comes first. The uncapped text is always on disk (`log_path`). */
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

// ---------------------------------------------------------------------------
// one probe
// ---------------------------------------------------------------------------

function toProbeScore(a: Attempt): ProbeScore {
  return {
    pass: a.pass,
    primary: a.primary,
    normalized: a.normalized,
    unit: a.unit,
    higher_is_better: a.higher_is_better,
    scores: a.scores,
    errors: a.errors,
  };
}

interface ProbeContext {
  cwd: string;
  runId: string;
  baseline: string;
  template: AgentTemplate;
  prompt: string;
  model: string | null;
  timeoutS: number;
  score: boolean;
  env: Record<string, string>;
  runner: Runner;
  now: () => Date;
}

async function runProbe(ctx: ProbeContext, probe: ManifestProbe): Promise<ProbeResult> {
  const worktree = join(ctx.cwd, probe.worktree);
  const logPath = join(WORKTREES_DIR, ctx.runId, "logs", `${probe.i}.log`);
  const started = ctx.now().getTime();

  const run = await ctx.runner(ctx.template.command, ctx.template.args({ prompt: ctx.prompt, model: ctx.model }), {
    cwd: worktree,
    timeoutMs: ctx.timeoutS * 1000,
    env: { ...ctx.env, [PROBE_ENV]: String(probe.i) },
  });
  const wallS = Math.round((ctx.now().getTime() - started) / 100) / 10;

  const raw = run.stderr === "" ? run.stdout : `${run.stdout}\n--- stderr ---\n${run.stderr}`;
  try {
    mkdirSync(dirname(join(ctx.cwd, logPath)), { recursive: true });
    writeFileSync(join(ctx.cwd, logPath), raw);
  } catch {
    // A log we cannot write must not lose the probe; the result below still carries the summary.
  }

  const parsed = parseAgentOutput(ctx.template.format, run.stdout);
  const capped = capOutput(parsed.summary ?? "");

  let error: string | null = null;
  if (run.spawnError !== null) {
    error = `could not execute '${ctx.template.command}' — ${run.spawnError}. Is it on PATH?`;
  } else if (run.timedOut) {
    error = `the agent exceeded --timeout ${ctx.timeoutS}s and its process group was killed`;
  } else if (run.code !== 0) {
    error = `the agent exited ${run.code}; its output is in ${logPath}`;
  }

  // Scored even when the agent failed: a half-finished edit that still passes `f` is a real result,
  // and one that no longer builds is exactly what the operator needs to see.
  let score: ProbeScore | null = null;
  if (ctx.score && run.spawnError === null && existsSync(join(worktree, SCORER_PATH))) {
    const { attempt } = await runScore(
      {
        json: true,
        parallel: false,
        timeoutS: ctx.timeoutS,
        init: null,
        force: false,
        record: false,
        cwd: worktree,
      },
      ctx.runner,
      ctx.now,
    );
    if (attempt !== null) score = toProbeScore(attempt);
  }

  return {
    i: probe.i,
    ok: error === null,
    score,
    diffstat: await diffstatOf(ctx.runner, worktree, ctx.baseline),
    summary: capped.text === "" ? null : capped.text,
    worktree: probe.worktree,
    tokens: parsed.tokens,
    wall_s: wallS,
    exit_code: run.code,
    timed_out: run.timedOut,
    log_path: logPath,
    truncated: capped.truncated,
    error,
  };
}

// ---------------------------------------------------------------------------
// the fan-out
// ---------------------------------------------------------------------------

/** Highest normalized score among probes that passed `f`. `null` when nothing scored or nothing passed. */
export function bestProbe(results: readonly ProbeResult[]): number | null {
  let best: ProbeResult | null = null;
  for (const r of results) {
    const n = r.score?.pass === true ? r.score.normalized : null;
    if (n === null) continue;
    const cur = best?.score?.normalized ?? null;
    if (cur === null || n > cur) best = r;
  }
  return best?.i ?? null;
}

export interface FanDeps {
  runner: Runner;
  now: () => Date;
  env: NodeJS.ProcessEnv;
}

export async function runFan(opts: FanOptions, deps: FanDeps): Promise<FanResult | { error: string }> {
  const { runner, now, env } = deps;

  let prompt: string;
  if (opts.promptFile !== null) {
    try {
      prompt = readFileSync(opts.promptFile, "utf8");
    } catch (e) {
      return { error: `cannot read --prompt-file ${opts.promptFile} — ${(e as Error).message}` };
    }
  } else {
    prompt = opts.prompt ?? "";
  }
  if (prompt.trim() === "") return { error: "the prompt is empty; a probe with no task is not a probe" };

  const sha = promptSha(prompt);
  const guards = checkGuards(env, sha);
  if (!guards.ok) return { error: guards.error };

  const warnings = [...guards.warnings];
  const loaded = loadConfig(opts.cwd);
  warnings.push(...loaded.warnings);

  // Which agent, and why — recorded in the result, because "it picked whatever was on PATH" is a
  // fact a reader of last week's fan-out needs and cannot recover otherwise.
  let agentName = opts.agent ?? loaded.config.agent?.name ?? null;
  if (agentName === null) {
    const found = firstOnPath(env, ["pi", "claude", "codex"]);
    if (found === null) {
      return {
        error:
          "no agent given and none of pi | claude | codex is on PATH — pass --agent <name>, set " +
          `${AGENT_ENV}, or declare one in .avo/config.json`,
      };
    }
    agentName = found;
    warnings.push(`no --agent given; used '${found}', the first of pi | claude | codex on PATH`);
  }
  const template = resolveTemplate(agentName, loaded.config.agent);
  if ("error" in template) return { error: template.error };

  const head = await git(runner, opts.cwd, ["rev-parse", "HEAD"]);
  if (!head.ok) {
    return { error: `${opts.cwd} has no commit to branch from (${head.err || "git rev-parse HEAD failed"})` };
  }
  const baseline = head.out;

  // We are about to create `.avo/worktrees/`, so the exclusion that keeps it out of the lineage has
  // to exist first — the same thing `avo commit` does for the attempt log.
  ensureTrajectoryIgnored(opts.cwd);

  // A worktree is created from HEAD, so uncommitted work in the root is invisible to every probe.
  // Silently exploring a different tree than the operator is looking at is the worst failure here.
  //
  // Filtered through withoutTrajectory: avo's own worktrees must not read as a variation. Without
  // it the *second* fan-out in a repo warns about `.avo/worktrees/` — a change the agent never made
  // — which is the same self-perturbation the memory log caused in S3.
  const status = await git(runner, opts.cwd, ["status", "--porcelain"]);
  const dirty = status.ok ? withoutTrajectory(status.out) : [];
  if (dirty.length > 0) {
    warnings.push(
      `the working tree has ${dirty.length} uncommitted change(s); probes branch from HEAD ` +
        `(${baseline.slice(0, 8)}) and will not see them`,
    );
  }

  const runId = uniqueRunId(opts.cwd, now(), sha);
  const probes: ManifestProbe[] = Array.from({ length: opts.n }, (_, k) => ({
    i: k + 1,
    worktree: join(WORKTREES_DIR, runId, String(k + 1)),
    status: "pending",
    result: null,
  }));
  const manifest: Manifest = {
    version: 1,
    run_id: runId,
    started_at: now().toISOString(),
    finished_at: null,
    baseline,
    agent: template.name,
    model: opts.model,
    timeout_s: opts.timeoutS,
    prompt_sha: sha,
    prompt,
    probes,
  };
  writeManifest(opts.cwd, manifest);

  const created = await addWorktrees(runner, opts.cwd, probes, baseline);
  if (created.length > 0) return { error: created.join("; ") };

  const cap = concurrencyCap();
  if (opts.n > cap) warnings.push(`--n ${opts.n} exceeds the concurrency cap of ${cap}; the rest queue`);

  return await executeProbes(opts, deps, manifest, template, warnings, cap, probeEnv(guards, sha, runId, 0));
}

/** Serial on purpose: concurrent `git worktree add` calls race on the same `.git/worktrees` lock. */
async function addWorktrees(
  runner: Runner,
  cwd: string,
  probes: readonly ManifestProbe[],
  baseline: string,
): Promise<string[]> {
  const errors: string[] = [];
  for (const p of probes) {
    if (existsSync(join(cwd, p.worktree))) continue;
    // --detach: a fan-out of 8 should not leave 8 branches behind, and promotion works off the
    // diff against the baseline commit rather than off a ref.
    const r = await git(runner, cwd, ["worktree", "add", "--detach", p.worktree, baseline]);
    if (!r.ok) errors.push(`could not create worktree ${p.worktree} — ${r.err || "git worktree add failed"}`);
  }
  return errors;
}

async function executeProbes(
  opts: FanOptions,
  deps: FanDeps,
  manifest: Manifest,
  template: AgentTemplate,
  warnings: string[],
  cap: number,
  childEnv: Record<string, string>,
): Promise<FanResult> {
  const { runner, now } = deps;
  const ctx: ProbeContext = {
    cwd: opts.cwd,
    runId: manifest.run_id,
    baseline: manifest.baseline,
    template,
    prompt: manifest.prompt,
    model: manifest.model,
    timeoutS: manifest.timeout_s,
    score: opts.score,
    env: childEnv,
    runner,
    now,
  };

  const todo = manifest.probes.filter((p) => p.status !== "done");
  await mapLimit(todo, cap, async (probe) => {
    const result = await runProbe(ctx, probe);
    probe.status = "done";
    probe.result = result;
    // After every probe, not just at the end: a kill here must leave the finished work recoverable.
    writeManifest(opts.cwd, manifest);
  });

  manifest.finished_at = now().toISOString();
  writeManifest(opts.cwd, manifest);

  const results = manifest.probes.map((p) => p.result).filter((r): r is ProbeResult => r !== null);
  const { kept, removed } = await cleanupUntouched(runner, opts, results);

  return {
    ok: results.some((r) => r.ok),
    run_id: manifest.run_id,
    cwd: opts.cwd,
    agent: template.name,
    approval: template.approval,
    model: manifest.model,
    n: manifest.probes.length,
    baseline: manifest.baseline,
    concurrency: Math.min(cap, manifest.probes.length),
    timeout_s: manifest.timeout_s,
    prompt_sha: manifest.prompt_sha,
    results,
    best: bestProbe(results),
    kept,
    removed,
    warnings,
    errors: results.flatMap((r) => (r.error === null ? [] : [`probe ${r.i}: ${r.error}`])),
  };
}

/**
 * A worktree the probe never changed holds nothing worth reading, and `git worktree list` filling up
 * with dead entries is how this feature becomes annoying enough to stop using. Changed worktrees
 * stay until `--clean`: they are the only copy of the work.
 */
async function cleanupUntouched(
  runner: Runner,
  opts: FanOptions,
  results: readonly ProbeResult[],
): Promise<{ kept: string[]; removed: string[] }> {
  const kept: string[] = [];
  const removed: string[] = [];
  for (const r of results) {
    if (opts.keep || r.diffstat.files > 0) {
      kept.push(r.worktree);
      continue;
    }
    const gone = await removeWorktree(runner, opts.cwd, r.worktree);
    (gone ? removed : kept).push(r.worktree);
  }
  if (removed.length > 0) await git(runner, opts.cwd, ["worktree", "prune"]);
  return { kept, removed };
}

async function removeWorktree(runner: Runner, cwd: string, path: string): Promise<boolean> {
  if (!existsSync(join(cwd, path))) return true;
  const r = await git(runner, cwd, ["worktree", "remove", "--force", path]);
  if (r.ok) return true;
  // A worktree git has lost track of (a killed run, a moved repo) is still just a directory.
  try {
    rmSync(join(cwd, path), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * A `$PATH` scan rather than `<agent> --version`: probing three agent binaries costs three node
 * startups before any work begins, and this answers the same question in microseconds.
 */
export function firstOnPath(env: NodeJS.ProcessEnv, names: readonly string[]): string | null {
  const dirs = (env["PATH"] ?? "").split(":").filter((d) => d !== "");
  for (const n of names) {
    for (const d of dirs) {
      try {
        accessSync(join(d, n), constants.X_OK);
        return n;
      } catch {
        // not here; keep looking
      }
    }
  }
  return null;
}

/** A second fan-out of the same prompt in the same second must not land in the first one's dir. */
function uniqueRunId(cwd: string, now: Date, sha: string): string {
  const base = makeRunId(now, sha);
  if (!existsSync(runDir(cwd, base))) return base;
  for (let k = 2; k < 100; k++) {
    if (!existsSync(runDir(cwd, `${base}-${k}`))) return `${base}-${k}`;
  }
  return `${base}-${process.pid}`;
}

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

export async function resumeFan(opts: FanOptions, deps: FanDeps): Promise<FanResult | { error: string }> {
  const manifest = readManifest(opts.cwd, opts.target);
  if ("error" in manifest) return manifest;

  // A resume re-runs agent processes, so it is a fan-out and the guards apply exactly as before.
  const guards = checkGuards(deps.env, manifest.prompt_sha);
  if (!guards.ok) return { error: guards.error };

  const loaded = loadConfig(opts.cwd);
  const template = resolveTemplate(manifest.agent, loaded.config.agent);
  if ("error" in template) return { error: `run '${manifest.run_id}' used ${template.error}` };

  const warnings = [...loaded.warnings];
  const pending = manifest.probes.filter((p) => p.status !== "done");
  if (pending.length === 0) warnings.push(`run '${manifest.run_id}' was already complete; nothing to re-run`);
  else warnings.push(`resuming ${pending.length} of ${manifest.probes.length} probe(s) that never finished`);

  // A killed run can leave a worktree half-created or removed entirely; re-adding is idempotent.
  const failed = await addWorktrees(deps.runner, opts.cwd, pending, manifest.baseline);
  if (failed.length > 0) return { error: failed.join("; ") };

  const resumed: FanOptions = { ...opts, n: manifest.probes.length, timeoutS: manifest.timeout_s };
  const childEnv = probeEnv(guards, manifest.prompt_sha, manifest.run_id, 0);
  return await executeProbes(resumed, deps, manifest, template, warnings, concurrencyCap(), childEnv);
}

// ---------------------------------------------------------------------------
// promote
// ---------------------------------------------------------------------------

export interface PromoteResult {
  ok: boolean;
  run_id: string;
  i: number;
  worktree: string;
  /** How the patch went in. `3way` means git had to fall back on blob context. */
  applied: "clean" | "3way" | null;
  files: string[];
  patch: string | null;
  warnings: string[];
  error: string | null;
}

/**
 * Brings one probe's work into the *root* working tree — and stops there. It does not score, does
 * not commit, and does not delete the other probes: `avo commit` is the only writer of a version
 * (invariant 1), and promotion is the explicit, separate step invariant 7 asks for.
 */
export async function promote(opts: FanOptions, deps: FanDeps): Promise<PromoteResult | { fatal: string }> {
  const { runner } = deps;
  const i = Number(opts.target);
  const runId = opts.runId ?? latestRunId(opts.cwd);
  if (runId === null) return { fatal: `no runs in ${WORKTREES_DIR} — 'avo fan --list' shows what survived` };

  const manifest = readManifest(opts.cwd, runId);
  if ("error" in manifest) return { fatal: manifest.error };

  const probe = manifest.probes.find((p) => p.i === i);
  if (probe === undefined) {
    return { fatal: `run '${runId}' has no probe ${i} (it has ${manifest.probes.map((p) => p.i).join(", ")})` };
  }
  const worktree = join(opts.cwd, probe.worktree);
  if (!existsSync(worktree)) {
    return { fatal: `probe ${i}'s worktree ${probe.worktree} is gone — it was empty and cleaned up, or already removed` };
  }

  const warnings: string[] = [];
  const head = await git(runner, opts.cwd, ["rev-parse", "HEAD"]);
  if (head.ok && head.out !== manifest.baseline) {
    warnings.push(
      `HEAD has moved since the fan-out (${manifest.baseline.slice(0, 8)} -> ${head.out.slice(0, 8)}); ` +
        "the patch may need the 3-way fallback",
    );
  }

  // Measured now rather than read off the manifest: the worktree may have been touched since the
  // probe finished, and what promotion moves is whatever is in it at this moment.
  const stat = await diffstatOf(runner, worktree, manifest.baseline);
  const diff = await runner("git", ["diff", "--binary", manifest.baseline, "--"], {
    cwd: worktree,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  const base: PromoteResult = {
    ok: false,
    run_id: runId,
    i,
    worktree: probe.worktree,
    applied: null,
    files: stat.changed,
    patch: null,
    warnings,
    error: null,
  };
  if (diff.code !== 0) return { ...base, error: `could not diff probe ${i} against the baseline — ${diff.stderr.trim()}` };
  if (diff.stdout.trim() === "") {
    return { ...base, ok: true, files: [], error: null, warnings: [...warnings, `probe ${i} changed nothing; nothing to promote`] };
  }

  // The patch is written before it is applied, so a rejected promotion still leaves the operator
  // something to inspect and apply by hand.
  const patchRel = join(WORKTREES_DIR, runId, `promote-${i}.patch`);
  try {
    writeFileSync(join(opts.cwd, patchRel), diff.stdout);
  } catch (e) {
    return { ...base, error: `could not write ${patchRel} — ${(e as Error).message}` };
  }

  const clean = await git(runner, opts.cwd, ["apply", patchRel]);
  if (clean.ok) return { ...base, ok: true, applied: "clean", patch: patchRel };

  const threeway = await git(runner, opts.cwd, ["apply", "--3way", patchRel]);
  if (threeway.ok) {
    return {
      ...base,
      ok: true,
      applied: "3way",
      patch: patchRel,
      warnings: [...warnings, "the patch needed a 3-way merge; check the tree for conflict markers before scoring"],
    };
  }
  return {
    ...base,
    patch: patchRel,
    error: `the patch did not apply (${threeway.err || clean.err}); it is kept at ${patchRel} for inspection`,
  };
}

function latestRunId(cwd: string): string | null {
  const runs = listRuns(cwd);
  return runs.length > 0 ? (runs.at(-1) as Manifest).run_id : null;
}

// ---------------------------------------------------------------------------
// clean
// ---------------------------------------------------------------------------

export interface CleanResult {
  ok: boolean;
  removed: string[];
  kept: string[];
  errors: string[];
}

export async function cleanRuns(opts: FanOptions, deps: FanDeps): Promise<CleanResult> {
  const targets = opts.target === "all" ? listRuns(opts.cwd).map((m) => m.run_id) : [opts.target];
  const out: CleanResult = { ok: true, removed: [], kept: [], errors: [] };
  for (const runId of targets) {
    const manifest = readManifest(opts.cwd, runId);
    if ("error" in manifest) {
      out.errors.push(manifest.error);
      out.ok = false;
      continue;
    }
    for (const p of manifest.probes) {
      if (await removeWorktree(deps.runner, opts.cwd, p.worktree)) out.removed.push(p.worktree);
      else {
        out.kept.push(p.worktree);
        out.ok = false;
      }
    }
    try {
      rmSync(runDir(opts.cwd, runId), { recursive: true, force: true });
    } catch (e) {
      out.errors.push(`could not remove ${join(WORKTREES_DIR, runId)} — ${(e as Error).message}`);
      out.ok = false;
    }
  }
  await git(deps.runner, opts.cwd, ["worktree", "prune"]);
  return out;
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function scoreCell(r: ProbeResult): string {
  if (r.score === null) return "—";
  if (!r.score.pass) return r.score.errors.length > 0 ? "error" : "fail";
  const dir = r.score.higher_is_better ? "↑" : "↓";
  return `${r.score.primary ?? "—"} ${r.score.unit} ${dir}`;
}

export function renderFan(f: FanResult): string {
  const lines = [`avo fan — ${f.n} probe(s), ${f.agent}${f.model === null ? "" : ` (${f.model})`}`, ""];
  lines.push(`  run       ${f.run_id}`);
  lines.push(`  baseline  ${f.baseline.slice(0, 12)}`);
  lines.push(`  approval  ${f.approval}`);
  lines.push("");
  for (const r of f.results) {
    const flag = r.ok ? "ok  " : "fail";
    const d = r.diffstat;
    lines.push(
      `  ${String(r.i).padEnd(3)} ${flag}  ${scoreCell(r).padEnd(20)} ` +
        `${d.files} file(s) +${d.insertions}/-${d.deletions}  ${r.wall_s}s${f.best === r.i ? "  <- best" : ""}`,
    );
    if (r.summary !== null) lines.push(`      ${r.summary.split("\n")[0]?.slice(0, 100) ?? ""}`);
    if (r.error !== null) lines.push(`      error: ${r.error}`);
    lines.push(`      ${r.worktree}`);
  }
  lines.push("");
  for (const w of f.warnings) lines.push(`warning: ${w}`);
  if (f.warnings.length > 0) lines.push("");
  if (f.removed.length > 0) lines.push(`removed ${f.removed.length} unchanged worktree(s)`);
  if (f.kept.length > 0) {
    lines.push(`kept ${f.kept.length} worktree(s); promote one with 'avo fan --promote <i> --run ${f.run_id}'`);
    lines.push(`clean up with 'avo fan --clean ${f.run_id}'`);
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------

/** Result codes: 0 = ran, 1 = refused (a guard, or every probe failed), 2 = harness error. */
export async function fanCommand(
  argv: readonly string[],
  io: Io,
  runner: Runner = spawnRunner,
  now: () => Date = () => new Date(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const parsed = parseFanArgs(argv, env);
  if ("error" in parsed) {
    io.err(`${parsed.error}\n`);
    return 2;
  }
  const opts = parsed;
  const deps: FanDeps = { runner, now, env };

  if (opts.mode === "list") {
    const runs = listRuns(opts.cwd).map((m) => ({
      run_id: m.run_id,
      started_at: m.started_at,
      finished_at: m.finished_at,
      agent: m.agent,
      probes: m.probes.length,
      pending: m.probes.filter((p) => p.status !== "done").length,
      worktrees: m.probes.filter((p) => existsSync(join(opts.cwd, p.worktree))).length,
    }));
    if (opts.json) io.out(`${JSON.stringify({ ok: true, runs })}\n`);
    else if (runs.length === 0) io.out(`no fan-out runs in ${WORKTREES_DIR}\n`);
    else {
      for (const r of runs) {
        io.out(
          `${r.run_id}  ${r.agent.padEnd(8)} ${r.probes} probe(s), ${r.worktrees} worktree(s)` +
            `${r.pending > 0 ? `, ${r.pending} unfinished — 'avo fan --resume ${r.run_id}'` : ""}\n`,
        );
      }
    }
    return 0;
  }

  if (opts.mode === "clean") {
    const r = await cleanRuns(opts, deps);
    if (opts.json) io.out(`${JSON.stringify(r)}\n`);
    else {
      io.out(`removed ${r.removed.length} worktree(s)\n`);
      for (const e of r.errors) io.err(`error: ${e}\n`);
    }
    return r.ok ? 0 : 2;
  }

  if (opts.mode === "promote") {
    const r = await promote(opts, deps);
    if ("fatal" in r) {
      if (opts.json) io.out(`${JSON.stringify({ ok: false, error: r.fatal })}\n`);
      else io.err(`avo fan --promote: ${r.fatal}\n`);
      return 2;
    }
    if (opts.json) io.out(`${JSON.stringify(r)}\n`);
    else {
      for (const w of r.warnings) io.err(`warning: ${w}\n`);
      if (r.error !== null) io.err(`avo fan --promote: ${r.error}\n`);
      else if (r.applied === null) io.out(`probe ${r.i}: nothing to promote\n`);
      else io.out(`promoted probe ${r.i} (${r.applied}) — ${r.files.length} file(s); score it, then 'avo commit'\n`);
    }
    return r.ok ? 0 : 1;
  }

  const result = opts.mode === "resume" ? await resumeFan(opts, deps) : await runFan(opts, deps);
  if ("error" in result) {
    if (opts.json) io.out(`${JSON.stringify({ ok: false, error: result.error })}\n`);
    else io.err(`avo fan: ${result.error}\n`);
    // A guard is a refusal, not a harness failure: the agent asked for something it may not have.
    return /^(depth limit|cycle)/.test(result.error) ? 1 : 2;
  }
  io.out(opts.json ? `${JSON.stringify(result)}\n` : renderFan(result));
  return result.ok ? 0 : 1;
}
