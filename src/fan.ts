/**
 * `avo fan` — N variation directions at once, each in its own `git worktree` and headless agent
 * process. OS-level isolation, no shared state: `mjakl/pi-subagent`'s pattern (PLAN §2), and its
 * same four guards.
 *
 * Invariant 7 governs the file: **worktrees are disposable, `main` is not.** Nothing writes outside
 * a worktree, and promoting a probe is a separate, explicit step.
 */

import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { loadConfig } from "./config.ts";
import { ensureTrajectoryIgnored, withoutTrajectory } from "./lineage.ts";
import type { Io } from "./io.ts";
import { capOutput, driveAgent, resolveTemplate, type AgentTemplate, type AgentTokens, type Capped } from "./agents.ts";
import {
  concurrencyCap,
  mapLimit,
  runScore,
  spawnRunner,
  SCORER_PATH,
  type Attempt,
  type Runner,
} from "./score.ts";

/** Every run lives here: gitignored and in TRAJECTORY_PATHS — trajectory, not lineage. */
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

const GIT_TIMEOUT_MS = 60_000;

export interface Diffstat {
  files: number;
  insertions: number;
  deletions: number;
  /** Paths touched, so the shape of the change is visible without the patch. */
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
  /** Repo-relative, so the JSON means the same read from anywhere. */
  worktree: string;
  tokens: AgentTokens | null;
  /** USD as the agent reported it — what #35 is priced in. */
  cost_usd: number | null;
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
 * Depth and cycle prevention. A probe *is* an agent and can call `avo fan` itself; unguarded, that
 * is exponential in wall-clock and spend. The state travels in the environment because that is the
 * only channel surviving `spawn` into an arbitrary agent binary.
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
 * `--numstat` against the baseline *commit* after `add -A -N` — the only combination seeing all four
 * states a probe can leave: committed, staged, unstaged, untracked. Ignored files stay out.
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
 * Rewritten after every probe, so a kill mid-fan-out leaves a manifest naming the worktrees and the
 * results in hand. That is what `--resume` reattaches to.
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

/**
 * Re-exported: the cap lives in `agents.ts` because `avo run` truncates by the same rule, and two
 * copies of it is how two commands start disagreeing.
 */
export { capOutput, type Capped };

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

  const turn = await driveAgent(
    ctx.runner,
    ctx.template,
    { prompt: ctx.prompt, model: ctx.model },
    {
      cwd: worktree,
      logPath,
      logFile: join(ctx.cwd, logPath),
      timeoutS: ctx.timeoutS,
      env: { ...ctx.env, [PROBE_ENV]: String(probe.i) },
    },
    ctx.now,
  );

  // Scored even when the agent failed: a half-finished edit passing `f` is a real result.
  let score: ProbeScore | null = null;
  if (ctx.score && !turn.spawn_failed && existsSync(join(worktree, SCORER_PATH))) {
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
    ok: turn.ok,
    score,
    diffstat: await diffstatOf(ctx.runner, worktree, ctx.baseline),
    summary: turn.summary,
    worktree: probe.worktree,
    tokens: turn.tokens,
    cost_usd: turn.cost_usd,
    wall_s: turn.wall_s,
    exit_code: turn.exit_code,
    timed_out: turn.timed_out,
    log_path: logPath,
    truncated: turn.truncated,
    error: turn.error,
  };
}

// ---------------------------------------------------------------------------
// the fan-out
// ---------------------------------------------------------------------------

/** Best normalized score among passing probes; `null` when none scored or passed. */
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

  // Which agent and why: unrecoverable later, so it goes in the result.
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

  // `.avo/worktrees/` is about to exist, so its lineage exclusion must come first.
  ensureTrajectoryIgnored(opts.cwd);

  // Worktrees branch from HEAD, so uncommitted root work is invisible to every probe — silently
  // exploring a different tree than the operator sees is the worst failure here.
  //
  // Filtered through withoutTrajectory: avo's own worktrees must not read as a variation, or the
  // second fan-out warns about `.avo/worktrees/`. Same self-perturbation as S3's memory log.
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
    // --detach: 8 probes should not leave 8 branches, and promotion diffs the baseline commit.
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
    // After every probe: a kill must leave finished work recoverable.
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
 * An unchanged worktree holds nothing worth reading, and `git worktree list` filling with dead
 * entries is how this feature stops being used. Changed ones stay until `--clean`: only copy.
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
  // A worktree git lost track of is still just a directory.
  try {
    rmSync(join(cwd, path), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** A `$PATH` scan, not `<agent> --version`: three node startups before any work begins. */
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

/** Two runs of one prompt in the same second must not share a directory. */
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

  // A resume re-runs agent processes, so the guards apply unchanged.
  const guards = checkGuards(deps.env, manifest.prompt_sha);
  if (!guards.ok) return { error: guards.error };

  const loaded = loadConfig(opts.cwd);
  const template = resolveTemplate(manifest.agent, loaded.config.agent);
  if ("error" in template) return { error: `run '${manifest.run_id}' used ${template.error}` };

  const warnings = [...loaded.warnings];
  const pending = manifest.probes.filter((p) => p.status !== "done");
  if (pending.length === 0) warnings.push(`run '${manifest.run_id}' was already complete; nothing to re-run`);
  else warnings.push(`resuming ${pending.length} of ${manifest.probes.length} probe(s) that never finished`);

  // A killed run leaves worktrees half-created or gone; re-adding is idempotent.
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
 * Brings one probe's work into the *root* tree and stops. No score, no commit, no deletion of the
 * others: `avo commit` is the only writer (invariant 1), promotion the separate step (invariant 7).
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

  // Measured now, not read off the manifest: the worktree may have moved since.
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

  // Written before it is applied, so a rejected promotion leaves something to inspect.
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
    // A guard is a refusal, not a harness failure.
    return /^(depth limit|cycle)/.test(result.error) ? 1 : 2;
  }
  io.out(opts.json ? `${JSON.stringify(result)}\n` : renderFan(result));
  return result.ok ? 0 : 1;
}
