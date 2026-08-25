/**
 * The continuous driver — `avo run`. One prompt, N iterations of
 * *agent turn → `avo commit` → `avo supervise` → inject the directive*, until the budget runs out
 * or something says stop.
 *
 * This is `avo fan`'s probe loop with the worktree taken away: the agent works in the root tree,
 * because that is the case where uncommitted work is the point rather than a hazard (#21). Nothing
 * here re-implements a step — `agents.ts` starts the agent, `lineage.ts` decides the commit,
 * `supervise.ts` decides whether to steer. What is genuinely new is the *between*: what a fresh
 * agent process is told about the turn before it, and what gets written down so a run that took
 * three days can still be read afterwards.
 *
 * The last part matters more than it looks. Every iteration is a *new process* with no memory of
 * the last one, so the turn prompt is the only continuity there is.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  capOutput,
  driveAgent,
  resolveTemplate,
  type AgentTemplate,
  type AgentTokens,
  type AgentTurn,
} from "./agents.ts";
import { loadConfig } from "./config.ts";
import {
  AGENT_ENV,
  checkGuards,
  DEFAULT_TIMEOUT_S,
  firstOnPath,
  makeRunId,
  probeEnv,
  promptSha,
} from "./fan.ts";
import type { Io } from "./io.ts";
import {
  decideCommit,
  ensureTrajectoryIgnored,
  git,
  isGitRepo,
  readLineage,
  recordDecisionMemory,
  type CommitDecision,
  type CommitOptions,
} from "./lineage.ts";
import { remember, resolveBackend, shortHash, type Backend } from "./mem.ts";
import { SCORER_PATH, spawnRunner, type Runner } from "./score.ts";
import { supervise, type Signal, type SignalKind } from "./supervise.ts";

/** Every run lives here. In TRAJECTORY_PATHS and gitignored: trajectory, not lineage. */
export const RUNS_DIR = ".avo/runs";
export const RUN_MANIFEST = "manifest.json";
/**
 * The sentinel that stops a running loop from outside it. `avo run` is the one command meant to go
 * for days, so it needs a brake that does not require finding and signalling the process — and one
 * an *agent* can reach, since a turn that concludes the task is finished should be able to say so.
 */
export const STOP_FILE = ".avo/STOP";
export const DEFAULT_MAX_ITERS = 10;
/**
 * Consecutive iterations that changed nothing before the loop gives up. An agent that edits nothing
 * records no attempt (`avo commit` returns before it scores an unchanged tree), so the stall
 * detector never sees it and never fires — the loop would spend its whole budget on an agent that
 * is not working. This is the one stop condition the supervisor cannot express.
 */
export const MAX_CONSECUTIVE_NOOPS = 3;
/** How much of the agent's own words become the commit rationale. A commit body is not a log. */
const WHY_CAP_CHARS = 2_000;

// ---------------------------------------------------------------------------
// what a run records
// ---------------------------------------------------------------------------

/** The commit decision, compacted: the full one is in `git notes --ref=avo` on the commit itself. */
export interface TurnDecision {
  action: CommitDecision["action"];
  version: number | null;
  sha: string | null;
  reason: string;
  primary: number | null;
  unit: string;
  /** `null` when the tree held nothing to score, so no attempt was made. */
  pass: boolean | null;
}

/**
 * A version the *agent* committed during its own turn, read back from the trailers in
 * `head_before..head_after`. The `avo-vary` skill has the agent run `avo commit` itself, so this is
 * the normal case and not the exception: without it the tree is clean by the time the harness looks,
 * every iteration records `noop`, and a run that produced a curve reads as a flat one (#42).
 */
export interface AgentVersion {
  version: number;
  sha: string;
  primary: number | null;
  unit: string;
  /** The agent's own `--why`, which is the rationale that actually landed. */
  why: string | null;
}

export interface TurnSupervision {
  triggered: boolean;
  signals: Signal[];
  since_best: number;
  repeat: number;
}

/** One steering directive, as it was written down. */
export interface Intervention {
  kinds: SignalKind[];
  key: string;
  bead: string | null;
  backend: Backend["kind"];
  warnings: string[];
}

export interface Iteration {
  iter: number;
  started_at: string;
  /** HEAD before and after the turn: an agent may commit for itself, and that is not a no-op. */
  head_before: string;
  head_after: string;
  agent: AgentTurn;
  log_path: string;
  decision: TurnDecision | null;
  /** Versions committed by the agent itself this turn — `decision`'s own is not among them. */
  agent_versions: AgentVersion[];
  supervision: TurnSupervision | null;
  /** The directive this iteration produced, injected into the *next* turn. */
  directive: string | null;
  intervention: Intervention | null;
  warnings: string[];
}

export type StopReason = "max-iters" | "stop-file" | "no-progress" | "agent-unavailable" | "dry-run";

/**
 * The whole run — also the on-disk manifest, rewritten after every iteration. One shape rather than
 * two: a manifest that can drift from what `--json` reports is a manifest nobody trusts after a
 * crash, and after a crash is the only time anybody reads it.
 */
export interface RunReport {
  version: 1;
  ok: boolean;
  run_id: string;
  cwd: string;
  agent: string;
  approval: string;
  /** The resolved command line, prompt elided — what actually gets spawned each turn. */
  command: string;
  model: string | null;
  max_iters: number;
  timeout_s: number;
  prompt_sha: string;
  prompt: string;
  baseline: string;
  head: string;
  started_at: string;
  finished_at: string | null;
  thresholds: { stall: number; thrash: number };
  iterations: Iteration[];
  /** Version numbers this run committed, in order. The run's actual output. */
  committed: number[];
  interventions: number;
  /** Summed over every iteration. Disjoint by construction — see `AgentTokens`. */
  tokens: AgentTokens;
  /**
   * USD over the whole run, summed from what each agent reported, or `null` when no iteration
   * reported one (codex, or a stub). `null` and `0` mean different things: nothing measured versus
   * nothing spent, and a cost budget (#28) must refuse to run against the first.
   */
  cost_usd: number | null;
  stopped: StopReason;
  stop_reason: string;
  warnings: string[];
  errors: string[];
}

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

export interface RunOptions {
  json: boolean;
  cwd: string;
  prompt: string | null;
  promptFile: string | null;
  agent: string | null;
  model: string | null;
  maxIters: number;
  timeoutS: number;
  dryRun: boolean;
  /** `null` = take it from `.avo/config.json`, then the default. As for `avo supervise`. */
  stall: number | null;
  thrash: number | null;
}

export function parseRunArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): RunOptions | { error: string } {
  const opts: RunOptions = {
    json: false,
    cwd: process.cwd(),
    prompt: null,
    promptFile: null,
    // Deliberately not AVO_PROBE_MODEL: probes explore on a small model, `avo run` is the
    // exploitation path and takes the agent's own default unless told otherwise (PLAN §3).
    agent: env[AGENT_ENV] ?? null,
    model: null,
    maxIters: DEFAULT_MAX_ITERS,
    timeoutS: DEFAULT_TIMEOUT_S,
    dryRun: false,
    stall: null,
    thrash: null,
  };
  const value = (i: number, flag: string): string | { error: string } => {
    const v = argv[i + 1];
    if (v === undefined) return { error: `avo run: ${flag} needs a value` };
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--json") opts.json = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else {
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
        case "-n":
        case "--max-iters": {
          const n = Number(v);
          if (!Number.isInteger(n) || n < 1) return { error: `avo run: --max-iters needs a positive integer, got '${v}'` };
          opts.maxIters = n;
          break;
        }
        case "--timeout": {
          const t = Number(v);
          if (!Number.isFinite(t) || t < 0) return { error: `avo run: --timeout needs a non-negative number, got '${v}'` };
          opts.timeoutS = t;
          break;
        }
        case "--stall": {
          const n = Number(v);
          if (!Number.isInteger(n) || n < 1) return { error: `avo run: --stall needs an integer >= 1` };
          opts.stall = n;
          break;
        }
        case "--thrash": {
          const n = Number(v);
          if (!Number.isInteger(n) || n < 2) return { error: `avo run: --thrash needs an integer >= 2` };
          opts.thrash = n;
          break;
        }
        default:
          return { error: `avo run: unknown option '${a}'` };
      }
      i++;
    }
  }

  if (opts.prompt === null && opts.promptFile === null) {
    return { error: 'avo run: needs --prompt-file <f> or --prompt "<text>" — a loop with no task is not a loop' };
  }
  if (opts.prompt !== null && opts.promptFile !== null) {
    return { error: "avo run: --prompt and --prompt-file are alternatives; pass one" };
  }
  return opts;
}

// ---------------------------------------------------------------------------
// the turn prompt
// ---------------------------------------------------------------------------

const fmtScore = (primary: number | null, unit: string): string => (primary === null ? "—" : `${primary} ${unit}`.trim());
/**
 * A refusal usually has no number: `f` forces `primary` to null when correctness fails, so printing
 * the placeholder as if it were a measurement gives "refused — — the candidate failed correctness".
 */
const atScore = (primary: number | null, unit: string): string => (primary === null ? "" : ` at ${fmtScore(primary, unit)}`);

/** `v3 at 0.408 ms, v4 at 0.345 ms` — the agent's own versions, named rather than counted. */
const listVersions = (vs: readonly AgentVersion[]): string =>
  vs.map((v) => `v${v.version}${atScore(v.primary, v.unit)}`).join(", ");

/** One line an agent that was not there can act on. */
export function describeOutcome(prev: Iteration): string {
  if (prev.agent.error !== null) return `the agent itself failed — ${prev.agent.error}`;
  const d = prev.decision;
  if (d === null) return "no commit decision was reached";
  // Named first, because a turn that committed for itself already moved the lineage, and telling
  // the next turn only that the harness saw a clean tree is the false negative #42 is about.
  const byAgent = prev.agent_versions ?? [];
  const own = byAgent.length === 0 ? "" : `the agent committed ${listVersions(byAgent)} itself`;
  switch (d.action) {
    case "committed": {
      const line = `committed v${d.version} at ${fmtScore(d.primary, d.unit)} — ${d.reason}`;
      return own === "" ? line : `${own}, and then the harness ${line}`;
    }
    case "noop":
      if (own !== "") return `${own}; the tree was clean afterwards, so there was nothing left to score`;
      return prev.head_after !== prev.head_before
        ? `the agent committed for itself (${prev.head_after.slice(0, 8)}); the tree was clean afterwards`
        : "nothing changed in the working tree, so there was nothing to score";
    default: {
      const line = `refused${atScore(d.primary, d.unit)} — ${d.reason}`;
      return own === "" ? line : `${own}, but a later change was ${line}`;
    }
  }
}

/**
 * What the agent is actually given. Iteration 1 gets the operator's prompt verbatim; every later
 * one gets it plus the state of the loop, because the process running this turn has no memory of
 * the last one and would otherwise re-derive the same candidate forever.
 */
export function turnPrompt(
  base: string,
  iter: number,
  maxIters: number,
  prev: Iteration | null,
  directive: string | null,
): string {
  if (prev === null && directive === null) return base;
  const lines = [base.trimEnd(), "", "---", `# avo run — iteration ${iter} of ${maxIters}`, ""];
  if (prev !== null) {
    lines.push(`Previous iteration: ${describeOutcome(prev)}`);
    const s = prev.supervision;
    if (s !== null) lines.push(`State: ${s.since_best} attempt(s) since the best version.`);
    lines.push(
      "",
      "You are a fresh process: nothing from the previous turn is in your context. Read what is",
      "already known before editing — `avo lineage`, `avo best`, `avo mem prime`.",
    );
  }
  if (directive !== null) lines.push("", directive.trimEnd());
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// the manifest
// ---------------------------------------------------------------------------

export function runDir(cwd: string, runId: string): string {
  return join(cwd, RUNS_DIR, runId);
}

/**
 * Rewritten after every iteration, never at the end. A loop meant to run for days will be killed at
 * some point, and the difference between a manifest written per-iteration and one written at exit
 * is the difference between a recoverable record and nothing at all — the same rule `avo fan`
 * follows for its probes.
 */
export function writeRunManifest(cwd: string, report: RunReport): void {
  try {
    mkdirSync(runDir(cwd, report.run_id), { recursive: true });
    writeFileSync(join(runDir(cwd, report.run_id), RUN_MANIFEST), `${JSON.stringify(report, null, 2)}\n`);
  } catch {
    // A manifest we cannot write must not stop the loop; the run still reports in full at the end.
  }
}

export function readRunManifest(cwd: string, runId: string): RunReport | { error: string } {
  try {
    const m = JSON.parse(readFileSync(join(runDir(cwd, runId), RUN_MANIFEST), "utf8")) as RunReport;
    if (m.version !== 1 || !Array.isArray(m.iterations)) return { error: `${runId}'s manifest is not a v1 run manifest` };
    return m;
  } catch {
    return { error: `no run '${runId}' in ${RUNS_DIR}` };
  }
}

/** A run id already on disk means two runs started in the same second; the second gets a suffix. */
function uniqueRunId(cwd: string, now: Date, sha: string): string {
  const base = makeRunId(now, sha);
  let id = base;
  for (let k = 2; existsSync(runDir(cwd, id)); k++) id = `${base}-${k}`;
  return id;
}

export function listRuns(cwd: string): RunReport[] {
  let names: string[];
  try {
    names = readdirSync(join(cwd, RUNS_DIR));
  } catch {
    return [];
  }
  const runs: RunReport[] = [];
  for (const name of names.sort()) {
    const m = readRunManifest(cwd, name);
    if (!("error" in m)) runs.push(m);
  }
  return runs;
}

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

export interface RunDeps {
  runner: Runner;
  now: () => Date;
  env: NodeJS.ProcessEnv;
}

const compact = (d: CommitDecision): TurnDecision => ({
  action: d.action,
  version: d.version,
  sha: d.sha,
  reason: d.reason,
  primary: d.attempt?.primary ?? null,
  unit: d.attempt?.unit ?? "",
  pass: d.attempt?.pass ?? null,
});

/** Records the directive that was injected, so the trajectory can be audited after the fact. */
async function recordIntervention(
  deps: RunDeps,
  cwd: string,
  runId: string,
  iter: number,
  signals: readonly Signal[],
  directive: string,
): Promise<Intervention> {
  const backend = await resolveBackend(deps.runner, cwd);
  const kinds = signals.map((s) => s.kind);
  const detail = [`run ${runId}, iteration ${iter}`, ...signals.map((s) => `${s.kind}: ${s.detail}`), "", directive].join("\n");
  const input = {
    kind: "intervention" as const,
    // Keyed by run and iteration: re-recording the same intervention updates one record, and two
    // runs that stall the same way stay distinguishable.
    key: `avo-intervention-${shortHash(`${runId}:${iter}`)}`,
    text: `avo run ${runId} it${iter}: steered on ${kinds.join("+")}`,
    detail,
  };
  const w = await remember(deps.runner, cwd, backend, input, deps.now);
  return {
    kinds,
    key: w.key,
    bead: w.bead,
    backend: w.backend,
    warnings: [...backend.warnings, ...w.warnings, ...(w.error === null ? [] : [w.error])],
  };
}

async function head(runner: Runner, cwd: string): Promise<string> {
  const r = await git(runner, cwd, ["rev-parse", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : "";
}

/**
 * Versions that appeared between the head before the turn and the head after `avo commit`, minus
 * the one this iteration's own decision produced. Whatever is left, the agent committed itself —
 * which is exactly what the `avo-vary` skill tells it to do, so it is the run's output as much as a
 * harness commit is (#42). Reading the trailers rather than trusting "HEAD moved" is what keeps
 * invariant 1 intact: a commit without them is a commit, not a version.
 */
async function agentVersions(
  runner: Runner,
  cwd: string,
  before: string,
  after: string,
  ownVersion: number | null,
): Promise<{ versions: AgentVersion[]; warnings: string[] }> {
  if (after === before || before === "" || after === "") return { versions: [], warnings: [] };
  const l = await readLineage(runner, cwd, `${before}..${after}`);
  return {
    versions: l.versions
      .filter((v) => v.version !== ownVersion)
      .map((v) => ({ version: v.version, sha: v.sha, primary: v.score.primary, unit: v.score.unit, why: v.why })),
    warnings: l.warnings,
  };
}

export async function runLoop(opts: RunOptions, deps: RunDeps): Promise<RunReport | { error: string }> {
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
  if (prompt.trim() === "") return { error: "the prompt is empty; a loop with no task is not a loop" };

  // The same four guards `avo fan` carries, and deliberately the same budget: an agent inside a run
  // can call `avo run`, and nesting a loop inside a loop is the same exponential hazard as nesting
  // a fan-out inside one. The state travels in the environment because that is the only channel
  // that survives `spawn` into an arbitrary agent binary.
  const sha = promptSha(prompt);
  const guards = checkGuards(env, sha);
  if (!guards.ok) return { error: guards.error };

  const warnings = [...guards.warnings];
  const loaded = loadConfig(opts.cwd);
  warnings.push(...loaded.warnings);
  const thresholds = {
    stall: opts.stall ?? loaded.config.supervise.stall,
    thrash: opts.thrash ?? loaded.config.supervise.thrash,
  };

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

  if (!(await isGitRepo(runner, opts.cwd))) {
    return { error: `${opts.cwd} is not a git repository; the lineage lives in git` };
  }
  const baseline = await head(runner, opts.cwd);
  if (baseline === "") {
    return { error: "the repository has no commits yet; make an initial commit before evolving it" };
  }
  // A loop with no `f` refuses every iteration in exactly the same way — worth one warning up
  // front rather than `--max-iters` identical harness errors.
  if (!existsSync(join(opts.cwd, SCORER_PATH))) {
    warnings.push(`${SCORER_PATH} does not exist, so every iteration will refuse; 'avo score --init <template>' scaffolds one`);
  }

  const runId = uniqueRunId(opts.cwd, now(), sha);
  const report: RunReport = {
    version: 1,
    ok: true,
    run_id: runId,
    cwd: opts.cwd,
    agent: template.name,
    approval: template.approval,
    command: [template.command, ...template.args({ prompt: "<prompt>", model: opts.model })].join(" "),
    model: opts.model,
    max_iters: opts.maxIters,
    timeout_s: opts.timeoutS,
    prompt_sha: sha,
    prompt,
    baseline,
    head: baseline,
    started_at: now().toISOString(),
    finished_at: null,
    thresholds,
    iterations: [],
    committed: [],
    interventions: 0,
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    cost_usd: null,
    stopped: "max-iters",
    stop_reason: "",
    warnings,
    errors: [],
  };

  if (opts.dryRun) {
    report.stopped = "dry-run";
    report.stop_reason = "--dry-run: nothing was spawned, nothing was committed and nothing was written";
    report.finished_at = now().toISOString();
    return report;
  }

  // Everything above this line is read-only, which is what makes `--dry-run` above honest: it
  // returns before the first write, including the gitignore.
  //
  // We are about to write under `.avo/runs/`, so the exclusion that keeps it out of the lineage has
  // to exist first — and, since S7b, that means *appending* it to a gitignore avo wrote earlier.
  ensureTrajectoryIgnored(opts.cwd);
  writeRunManifest(opts.cwd, report);
  return await iterate(opts, deps, report, template, prompt);
}

async function iterate(
  opts: RunOptions,
  deps: RunDeps,
  report: RunReport,
  template: AgentTemplate,
  base: string,
): Promise<RunReport> {
  const { runner, now } = deps;
  const guards = checkGuards(deps.env, report.prompt_sha);
  const childEnv = guards.ok ? probeEnv(guards, report.prompt_sha, report.run_id, 0) : {};

  let directive: string | null = null;
  let prev: Iteration | null = null;
  let noops = 0;

  for (let iter = 1; iter <= opts.maxIters; iter++) {
    if (existsSync(join(opts.cwd, STOP_FILE))) {
      report.stopped = "stop-file";
      report.stop_reason = `${STOP_FILE} exists; the loop stopped before iteration ${iter}`;
      break;
    }

    const logPath = join(RUNS_DIR, report.run_id, "logs", `${iter}.log`);
    const headBefore = await head(runner, opts.cwd);
    const turn = await driveAgent(
      runner,
      template,
      { prompt: turnPrompt(base, iter, opts.maxIters, prev, directive), model: opts.model },
      {
        cwd: opts.cwd,
        logPath,
        logFile: join(opts.cwd, logPath),
        timeoutS: opts.timeoutS,
        env: { ...childEnv, AVO_FAN_PROBE: String(iter) },
      },
      now,
    );

    const it: Iteration = {
      iter,
      started_at: now().toISOString(),
      head_before: headBefore,
      head_after: headBefore,
      agent: turn,
      log_path: logPath,
      decision: null,
      agent_versions: [],
      supervision: null,
      directive: null,
      intervention: null,
      warnings: [],
    };
    report.iterations.push(it);
    // Summed across iterations even though each turn's own usage is cumulative *within* the turn:
    // `avo run` starts a fresh agent process per iteration, so the totals never overlap.
    report.tokens = {
      input: report.tokens.input + (turn.tokens?.input ?? 0),
      output: report.tokens.output + (turn.tokens?.output ?? 0),
      cache_read: report.tokens.cache_read + (turn.tokens?.cache_read ?? 0),
      cache_write: report.tokens.cache_write + (turn.tokens?.cache_write ?? 0),
    };
    if (turn.cost_usd !== null) report.cost_usd = (report.cost_usd ?? 0) + turn.cost_usd;

    // A command that cannot be started will not start on the next iteration either. Burning the
    // whole budget on it is precisely the spinning this loop must not do.
    if (turn.spawn_failed) {
      report.stopped = "agent-unavailable";
      report.stop_reason = turn.error ?? `could not execute '${template.command}'`;
      report.errors.push(report.stop_reason);
      writeRunManifest(opts.cwd, report);
      break;
    }

    // `avo commit` — the only writer of a version (invariant 1), reached through the same
    // `decideCommit` the command itself calls, so the rule cannot differ between them. The agent's
    // own final message is the rationale, which is what `--why` is for.
    const why = capOutput(turn.summary ?? "", WHY_CAP_CHARS, 40).text.trim();
    const commitOpts: CommitOptions = {
      json: true,
      parallel: false,
      timeoutS: opts.timeoutS,
      init: null,
      force: false,
      record: true,
      cwd: opts.cwd,
      why: why === "" ? null : why,
      dryRun: false,
    };
    const decision = await decideCommit(commitOpts, runner, now);
    it.warnings.push(...(await recordDecisionMemory(commitOpts, decision, runner, now)));
    it.decision = compact(decision);
    it.head_after = await head(runner, opts.cwd);
    report.head = it.head_after;
    const own = await agentVersions(runner, opts.cwd, it.head_before, it.head_after, decision.version);
    it.agent_versions = own.versions;
    it.warnings.push(...own.warnings);
    // The agent's own commits come first: they are already in history by the time step 2 runs.
    for (const v of own.versions) report.committed.push(v.version);
    if (decision.action === "committed" && decision.version !== null) report.committed.push(decision.version);

    // A no-op only counts as one when HEAD did not move: an agent that ran `avo commit` itself
    // leaves a clean tree, and calling that "nothing happened" would stop a loop that is working.
    const idle = decision.action === "noop" && it.head_after === it.head_before;
    noops = idle ? noops + 1 : 0;

    const s = await supervise({ json: true, cwd: opts.cwd, stall: opts.stall, thrash: opts.thrash }, { runner });
    it.warnings.push(...s.warnings);
    it.supervision = { triggered: s.triggered, signals: s.signals, since_best: s.state.since_best, repeat: s.state.repeat };

    // The directive is injected into the NEXT turn — this one is already over. Recorded here, not
    // there, because the intervention belongs to the state that produced it.
    directive = s.directive;
    it.directive = s.directive;
    if (s.triggered && s.directive !== null) {
      it.intervention = await recordIntervention(deps, opts.cwd, report.run_id, iter, s.signals, s.directive);
      it.warnings.push(...it.intervention.warnings);
      report.interventions++;
    }

    prev = it;
    writeRunManifest(opts.cwd, report);

    if (noops >= MAX_CONSECUTIVE_NOOPS) {
      report.stopped = "no-progress";
      report.stop_reason =
        `the agent changed nothing for ${noops} iterations in a row; an unchanged tree records no ` +
        "attempt, so the supervisor cannot see it and the loop would spin";
      break;
    }
  }

  if (report.stop_reason === "") {
    report.stop_reason = `--max-iters ${opts.maxIters} reached`;
  }
  report.ok = report.errors.length === 0 && report.iterations.some((i) => i.agent.ok);
  report.finished_at = deps.now().toISOString();
  writeRunManifest(opts.cwd, report);
  return report;
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

/** The plan `--dry-run` prints: everything resolved, and the sequence each iteration will follow. */
export function renderPlan(r: RunReport): string {
  const lines = ["avo run (--dry-run: nothing is spawned, nothing is committed)", ""];
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  if (r.warnings.length > 0) lines.push("");
  lines.push(
    `  agent        ${r.agent}`,
    `  command      ${r.command}`,
    `  approval     ${r.approval}`,
    `  model        ${r.model ?? "— (the agent's own default)"}`,
    `  iterations   up to ${r.max_iters}`,
    `  timeout      ${r.timeout_s === 0 ? "none" : `${r.timeout_s}s per turn`}`,
    `  thresholds   stall ${r.thresholds.stall}, thrash ${r.thresholds.thrash}`,
    `  baseline     ${r.baseline.slice(0, 8)}`,
    `  run dir      ${join(RUNS_DIR, r.run_id)} (not created)`,
    `  stop file    ${STOP_FILE} (${existsSync(join(r.cwd, STOP_FILE)) ? "present — a real run would stop at once" : "absent"})`,
    "",
    "each iteration:",
    `  1. spawn the agent in ${r.cwd} with the turn prompt`,
    "  2. avo commit — score the tree, compare against the best version, persist only if it wins",
    "     (a turn that ran avo commit itself leaves nothing here; its version is still recorded)",
    `  3. avo supervise — ${r.thresholds.stall} attempts with no improvement, or ${r.thresholds.thrash} failures`,
    "     with the same signature, emits a steering directive that cites P_t and K",
    "  4. inject that directive into the next turn's prompt and record it as an intervention",
    "",
    `stops on: --max-iters ${r.max_iters}, ${STOP_FILE}, ${MAX_CONSECUTIVE_NOOPS} unchanged iterations in a row,`,
    "          or an agent binary that cannot be started",
    "",
    "turn prompt (iteration 1):",
    "",
    ...r.prompt.trimEnd().split("\n").map((l) => `  ${l}`),
    "",
  );
  return `${lines.join("\n")}\n`;
}

export function renderRun(r: RunReport): string {
  if (r.stopped === "dry-run") return renderPlan(r);
  const lines = [`avo run ${r.run_id}`, ""];
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  for (const e of r.errors) lines.push(`error: ${e}`);
  if (r.warnings.length > 0 || r.errors.length > 0) lines.push("");

  for (const it of r.iterations) {
    const d = it.decision;
    const own = it.agent_versions ?? [];
    const verdict =
      it.agent.error !== null
        ? `agent failed — ${it.agent.error}`
        : d === null
          ? "no decision"
          : d.action === "committed"
            ? `committed v${d.version} ${fmtScore(d.primary, d.unit)}`
            : d.action === "noop"
              ? own.length > 0
                ? `agent committed ${listVersions(own)}`
                : it.head_after === it.head_before
                  ? "no change"
                  : `agent committed ${it.head_after.slice(0, 8)}`
              : `refused${atScore(d.primary, d.unit)} — ${d.reason}`;
    lines.push(`  ${String(it.iter).padStart(3)}  ${`${it.agent.wall_s}s`.padStart(7)}  ${verdict}`);
    // A turn can do both: commit for itself and then leave more for the harness to score.
    if (own.length > 0 && d?.action !== "noop") {
      lines.push(`       ${" ".repeat(7)}  ↳ the agent also committed ${listVersions(own)} itself`);
    }
    for (const s of it.supervision?.signals ?? []) lines.push(`       ${" ".repeat(7)}  ↳ ${s.kind}: ${s.detail}`);
    if (it.intervention !== null) lines.push(`       ${" ".repeat(7)}  ↳ steered; recorded as ${it.intervention.key}`);
  }
  lines.push("");

  const t = r.tokens;
  // Cached input is shown next to the uncached rather than added to it, because it is the ratio
  // between the two that says whether a long loop over one repo is affordable.
  const cached = (t.cache_read ?? 0) + (t.cache_write ?? 0);
  const tok = t.input + t.output + cached;
  const tokenLine = `  tokens       ${t.input} in / ${t.output} out${cached === 0 ? "" : ` / ${t.cache_read ?? 0} cache read + ${t.cache_write ?? 0} cache write`}`;
  const byAgent = r.iterations.reduce((n, it) => n + (it.agent_versions ?? []).length, 0);
  lines.push(
    `  iterations   ${r.iterations.length} of ${r.max_iters}`,
    `  committed    ${r.committed.length === 0 ? "nothing" : r.committed.map((v) => `v${v}`).join(", ")}${byAgent === 0 ? "" : ` (${byAgent} by the agent itself)`}`,
    `  interventions ${r.interventions}`,
    ...(tok > 0 ? [tokenLine] : []),
    ...(r.cost_usd === null || r.cost_usd === undefined ? [] : [`  cost         $${r.cost_usd.toFixed(2)} (as the agent reported it)`]),
    `  manifest     ${join(RUNS_DIR, r.run_id, RUN_MANIFEST)}`,
    "",
    `stopped: ${r.stopped} — ${r.stop_reason}`,
    "",
  );
  return `${lines.join("\n")}\n`;
}

/** 0 = the loop ran, 1 = a guard refused or no iteration got anywhere, 2 = harness error. */
export async function runCommand(
  argv: readonly string[],
  io: Io,
  runner: Runner = spawnRunner,
  now: () => Date = () => new Date(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const opts = parseRunArgs(argv, env);
  if ("error" in opts) {
    io.err(`${opts.error}\n`);
    return 2;
  }
  const result = await runLoop(opts, { runner, now, env });
  if ("error" in result) {
    io.err(`avo run: ${result.error}\n`);
    return 1;
  }
  io.out(opts.json ? `${JSON.stringify(result)}\n` : renderRun(result));
  return result.ok || result.stopped === "dry-run" ? 0 : 1;
}
