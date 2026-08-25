/**
 * The native Pi supervisor: S7's `avo supervise` running *inside* the session instead of between
 * processes.
 *
 * `avo run` supervises by polling — turn, `avo commit`, `avo supervise`, splice the directive into
 * the next prompt. That works for any agent (invariant 9) and costs a whole process per check.
 * Pi can do better: it emits `tool_result` the moment `avo_score` or `avo_commit` finishes, which
 * are the only two events that can change what `supervise()` reads, and `pi.sendMessage` puts a
 * directive into the conversation without restarting anything.
 *
 * Three rules this file exists to keep:
 *
 *  1. **It counts the same attempts `avo supervise` counts.** The state comes from `supervise()`
 *     reading `.avo/attempts.jsonl` and the git lineage — never from an in-session tally. An
 *     operator running `avo run` in one terminal and `pi` in another must not be steered twice for
 *     one stall, and two counters that drift are how that happens.
 *  2. **It re-implements nothing.** No commit rule, no threshold arithmetic, no directive
 *     rendering: `supervise()` owns all of it, exactly as the CLI does (invariant 1).
 *  3. **It steers once per episode, not once per attempt.** See `episodeKeys`.
 *
 * Split from `pi/extensions/avo/` rather than folded into it for the reason S7 split the detector
 * from the driver: the tools are testable with no session at all, while this needs a scripted
 * sequence of tool results. Two extensions also mean an operator can load the tools without the
 * supervisor — a Pi session that wants `avo_score` but does its own steering is a real workflow.
 *
 * Lives under `pi/` for the same reason `tools.ts` does: everything in `src/` must keep working in
 * a checkout that never installed Pi.
 */

import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { resolveBackend, remember, shortHash, type Backend } from "../../../src/mem.ts";
import { spawnRunner, type Runner } from "../../../src/score.ts";
import type { CommitDecision } from "../../../src/lineage.ts";
import {
  supervise,
  type Signal,
  type SignalKind,
  type SuperviseDeps,
  type SuperviseOptions,
  type SuperviseState,
  type Supervision,
} from "../../../src/supervise.ts";

/**
 * The tool results that can change what `supervise()` reads, and therefore the only ones worth a
 * check. `avo_score` appends to the attempt log; `avo_commit` scores *and* may add a version.
 * `avo_fan` is deliberately absent: it scores in disposable worktrees with `record: false`, so a
 * fan-out moves no counter in this repo (invariant 7).
 */
export const SUPERVISED_TOOLS: readonly string[] = ["avo_score", "avo_commit"];

/** The `customType` of every directive this extension injects. Also how it finds them again. */
export const SUPERVISOR_MESSAGE_TYPE = "avo-supervisor";

/** The footer slot. One key, so the line is replaced rather than accumulated. */
export const STATUS_KEY = "avo";

/** What an injected directive records about itself, so a reload can reconstruct the state. */
export interface SteerDetails {
  /** The episodes this directive answered. Reconstruction reads exactly this field. */
  episodes: string[];
  kinds: SignalKind[];
  signals: Signal[];
  state: SuperviseState;
  /** The memory record, when one could be written. */
  intervention: InterventionRecord | null;
}

export interface InterventionRecord {
  key: string;
  bead: string | null;
  backend: Backend["kind"];
  warnings: string[];
}

export interface SupervisorDeps {
  supervise: (opts: SuperviseOptions, deps: SuperviseDeps) => Promise<Supervision>;
  /** Writes the intervention down, as `avo run` does. Injected so the tests need no `bd`. */
  record: (cwd: string, key: string, signals: readonly Signal[], directive: string) => Promise<InterventionRecord>;
  runner: Runner;
  now: () => Date;
}

/**
 * Records the directive that was injected, so a Pi-driven trajectory audits the same way an
 * `avo run` one does. Keyed by the episode rather than by run-and-iteration, because a session has
 * no iteration number — and because the episode key is already the thing that is unique per
 * intervention, which makes re-recording idempotent (invariant 5).
 */
async function recordIntervention(
  runner: Runner,
  now: () => Date,
  cwd: string,
  key: string,
  signals: readonly Signal[],
  directive: string,
): Promise<InterventionRecord> {
  const backend = await resolveBackend(runner, cwd);
  const kinds = signals.map((s) => s.kind);
  const w = await remember(
    runner,
    cwd,
    backend,
    {
      kind: "intervention",
      key: `avo-intervention-${shortHash(key)}`,
      text: `pi session: steered on ${kinds.join("+")}`,
      detail: [`episode ${key}`, ...signals.map((s) => `${s.kind}: ${s.detail}`), "", directive].join("\n"),
    },
    now,
  );
  return {
    key: w.key,
    bead: w.bead,
    backend: w.backend,
    warnings: [...backend.warnings, ...w.warnings, ...(w.error === null ? [] : [w.error])],
  };
}

export function defaultSupervisorDeps(): SupervisorDeps {
  const now = () => new Date();
  return {
    supervise,
    record: (cwd, key, signals, directive) => recordIntervention(spawnRunner, now, cwd, key, signals, directive),
    runner: spawnRunner,
    now,
  };
}

/**
 * Names the *episode* a signal belongs to — the run of consecutive readings that are all the same
 * problem — so that one problem produces one directive.
 *
 * Why not steer on every trigger: the directive for "5 attempts since the best" and the one for
 * "6 attempts since the best" say the same thing, and re-injecting it every attempt is nagging that
 * costs context and teaches the model to skim it. Why not steer only once ever: a stall that ends
 * and then starts again is genuinely new, and so is a thrash that appears *during* a stall.
 *
 * The key is a pure function of the supervision state, which is the point — it needs no counter of
 * its own, so it cannot drift from what `avo supervise` would say (rule 1 above).
 *   - a **stall** ends only when a version is committed, so `best.sha` names it; the anchor is the
 *     attempt index the stall began at, which distinguishes two stalls under the same best version
 *     (possible when the agent commits outside the lineage and the count resets by clock).
 *   - a **thrash** ends when the streak breaks or the signature changes, so both name it.
 *
 * `analyzed`, not `attempts`, is the anchor's base: past `ANALYSIS_WINDOW` records the detector
 * only sees a window, and `attempts - since_best` would then creep upward once per attempt and
 * re-steer forever. `analyzed - since_best` is constant for as long as the episode lasts.
 */
export function episodeKeys(state: SuperviseState, signals: readonly Signal[]): string[] {
  return signals.map((s) =>
    s.kind === "stall"
      ? `stall@${state.best === null ? "none" : state.best.sha}@${state.analyzed - state.since_best}`
      : `thrash@${state.signature ?? ""}@${state.analyzed - state.failing_streak}`,
  );
}

/** The live footer: what is best, how far from it, and whether anything is firing. */
export function statusLine(s: Supervision): string {
  const b = s.state.best;
  const parts: string[] = [b === null ? "no version yet" : `v${b.version}`];
  if (b !== null && b.primary !== null) parts.push(`${b.primary}${b.unit === "" ? "" : ` ${b.unit}`}`);
  parts.push(`${s.state.since_best} since best`);
  if (s.triggered) parts.push(`! ${s.signals.map((x) => x.kind).join("+")}`);
  return parts.join(" · ");
}

/** True when this result is `avo_commit` reporting that a new version actually landed. */
function committed(event: ToolResultEvent): CommitDecision | null {
  if (event.toolName !== "avo_commit" || event.isError) return null;
  const d = event.details as CommitDecision | undefined;
  return d !== undefined && d !== null && d.action === "committed" ? d : null;
}

/**
 * Wires the supervisor onto a Pi session. Separate from `index.ts` so the tests can inject deps and
 * drive a fake `ExtensionAPI`; `index.ts` is only the entry point Pi discovers.
 */
export function installSupervisor(pi: ExtensionAPI, deps: SupervisorDeps = defaultSupervisorDeps()): void {
  /**
   * The episodes already answered. Session-local *cache* rather than state of record: everything
   * needed to rebuild it is in the injected messages themselves, which is what makes branching
   * work — a branch that never saw a directive does not inherit it.
   */
  let steered = new Set<string>();
  /** Set in `session_shutdown`. A tool result that lands during teardown must not steer. */
  let closed = false;

  pi.on("session_start", (_event, ctx) => {
    closed = false;
    steered = new Set();
    // getBranch(), not getEntries(): entries off the current branch belong to a path the model no
    // longer remembers, and treating those as answered would leave a real stall unsteered.
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom_message" || entry.customType !== SUPERVISOR_MESSAGE_TYPE) continue;
      for (const key of (entry.details as SteerDetails | undefined)?.episodes ?? []) steered.add(key);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    closed = true;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (closed || !SUPERVISED_TOOLS.includes(event.toolName)) return;

    const decision = committed(event);
    if (decision !== null) {
      ctx.ui.notify(`avo: v${decision.version} is the new best — ${decision.reason}`, "info");
    }

    let s: Supervision;
    try {
      // Thresholds stay null so `.avo/config.json` decides, exactly as `avo supervise` does with
      // no flags. A session that hard-coded 5 would disagree with the CLI in the same repo.
      s = await deps.supervise({ json: true, cwd: repoOf(ctx), stall: null, thrash: null }, { runner: deps.runner });
    } catch (e) {
      // Invariant 4. A supervisor that cannot read the log must not take the session down with it:
      // the tools still work, the agent still scores, it just stops being steered.
      ctx.ui.notify(`avo supervisor: ${(e as Error).message}`, "warning");
      return;
    }

    ctx.ui.setStatus(STATUS_KEY, statusLine(s));
    if (!s.triggered || s.directive === null) return;

    const keys = episodeKeys(s.state, s.signals);
    if (keys.every((k) => steered.has(k))) return;
    for (const k of keys) steered.add(k);

    let intervention: InterventionRecord | null = null;
    try {
      intervention = await deps.record(repoOf(ctx), keys.join("+"), s.signals, s.directive);
    } catch (e) {
      // A memory write that goes wrong is a warning on an otherwise good steer: the directive is
      // the thing that matters and it is already in the session file.
      ctx.ui.notify(`avo supervisor: could not record the intervention — ${(e as Error).message}`, "warning");
    }

    const details: SteerDetails = {
      episodes: keys,
      kinds: s.signals.map((x) => x.kind),
      signals: s.signals,
      state: s.state,
      intervention,
    };
    // "steer" is the default and the right one: the tool call that changed the score has just
    // finished, and the directive lands before the model's next decision rather than after it has
    // already chosen. `triggerTurn` is deliberately NOT set — the supervisor answers a turn the
    // agent started; it does not start turns of its own.
    pi.sendMessage({ customType: SUPERVISOR_MESSAGE_TYPE, content: s.directive, display: true, details }, { deliverAs: "steer" });
  });
}

/** `ctx.cwd` is the only source of the repo root — the same rule the tools keep, for the same reason. */
const repoOf = (ctx: ExtensionContext): string => ctx.cwd;
