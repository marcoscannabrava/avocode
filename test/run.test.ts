import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CHAIN_ENV, DEFAULT_TIMEOUT_S, DEPTH_ENV, LEVEL_ENV, promptSha } from "../src/fan.ts";
import { bufferIo } from "../src/io.ts";
import { ensureTrajectoryIgnored, TRAJECTORY_PATHS } from "../src/lineage.ts";
import {
  DEFAULT_MAX_ITERS,
  MAX_CONSECUTIVE_NOOPS,
  RUNS_DIR,
  RUN_MANIFEST,
  STOP_FILE,
  describeOutcome,
  listRuns,
  parseRunArgs,
  readRunManifest,
  renderRun,
  runCommand,
  turnPrompt,
  type Iteration,
  type RunReport,
} from "../src/run.ts";

// ------------------------------------------------------------------ arguments

test("avo run defaults to ten iterations and a bounded per-turn timeout", () => {
  const o = parseRunArgs(["--prompt", "go"], {});
  assert.ok(!("error" in o));
  assert.equal(o.maxIters, DEFAULT_MAX_ITERS);
  assert.equal(o.timeoutS, DEFAULT_TIMEOUT_S);
  assert.equal(o.dryRun, false);
  assert.equal(o.stall, null, "the threshold comes from .avo/config.json unless a flag overrides");
});

test("the agent comes from the environment, but the model does not", () => {
  const o = parseRunArgs(["--prompt", "go"], { AVO_AGENT: "codex", AVO_PROBE_MODEL: "haiku" });
  assert.ok(!("error" in o));
  assert.equal(o.agent, "codex");
  // Probes explore on a small model; `avo run` is the exploitation path and must not inherit it.
  assert.equal(o.model, null);
});

test("a loop with no task is refused before anything is created", () => {
  const o = parseRunArgs(["--max-iters", "3"], {});
  assert.ok("error" in o);
  assert.match(o.error, /a loop with no task is not a loop/);
});

test("--prompt and --prompt-file are alternatives", () => {
  const o = parseRunArgs(["--prompt", "a", "--prompt-file", "b"], {});
  assert.ok("error" in o);
  assert.match(o.error, /alternatives/);
});

test("--max-iters must be a positive integer", () => {
  for (const bad of ["0", "-1", "2.5", "many"]) {
    const o = parseRunArgs(["--prompt", "x", "--max-iters", bad], {});
    assert.ok("error" in o, `--max-iters ${bad} should be refused`);
    assert.match(o.error, /positive integer/);
  }
  const ok = parseRunArgs(["--prompt", "x", "-n", "4"], {});
  assert.ok(!("error" in ok));
  assert.equal(ok.maxIters, 4);
});

test("the supervisor thresholds are overridable per run and keep supervise's own bounds", () => {
  const o = parseRunArgs(["--prompt", "x", "--stall", "2", "--thrash", "2"], {});
  assert.ok(!("error" in o));
  assert.equal(o.stall, 2);
  assert.equal(o.thrash, 2);
  // thrash < 2 cannot mean "repeated", so it is refused here exactly as `avo supervise` refuses it.
  assert.ok("error" in parseRunArgs(["--prompt", "x", "--thrash", "1"], {}));
  assert.ok("error" in parseRunArgs(["--prompt", "x", "--stall", "0"], {}));
});

test("a flag with no value is named rather than silently swallowing the next one", () => {
  const o = parseRunArgs(["--prompt"], {});
  assert.ok("error" in o);
  assert.match(o.error, /--prompt needs a value/);
});

test("an unknown option is a usage error, not a prompt", () => {
  const o = parseRunArgs(["--prompt", "x", "--probes", "4"], {});
  assert.ok("error" in o);
  assert.match(o.error, /unknown option '--probes'/);
});

// --------------------------------------------------------------- turn prompts

const iteration = (over: Partial<Iteration> = {}): Iteration => ({
  iter: 1,
  started_at: "2026-08-24T00:00:00.000Z",
  head_before: "aaaaaaaa",
  head_after: "aaaaaaaa",
  agent: {
    ok: true,
    summary: "did a thing",
    tokens: null,
    wall_s: 1,
    exit_code: 0,
    timed_out: false,
    truncated: false,
    spawn_failed: false,
    error: null,
  },
  log_path: ".avo/runs/r/logs/1.log",
  decision: { action: "committed", version: 1, sha: "bbbbbbbb", reason: "improved", primary: 2, unit: "lines", pass: true },
  agent_versions: [],
  supervision: { triggered: false, signals: [], since_best: 0, repeat: 0 },
  directive: null,
  intervention: null,
  warnings: [],
  ...over,
});

test("the first turn gets the operator's prompt verbatim", () => {
  assert.equal(turnPrompt("optimize the kernel", 1, 5, null, null), "optimize the kernel");
});

test("a later turn carries the previous outcome, because the process running it has no memory", () => {
  const p = turnPrompt("optimize the kernel", 2, 5, iteration(), null);
  assert.match(p, /^optimize the kernel/);
  assert.match(p, /iteration 2 of 5/);
  assert.match(p, /committed v1 at 2 lines/);
  assert.match(p, /fresh process/);
  assert.match(p, /avo lineage/, "it must point the agent at the past it cannot remember");
});

test("a directive is appended to the turn prompt, not substituted for it", () => {
  const p = turnPrompt("optimize the kernel", 3, 5, iteration(), "STEERING (avo supervise)\n- stall: 5 attempts");
  assert.match(p, /optimize the kernel/, "the task survives the intervention");
  assert.match(p, /STEERING \(avo supervise\)/);
  assert.ok(p.indexOf("STEERING") > p.indexOf("optimize the kernel"), "the directive comes after the task");
});

test("an agent that committed for itself is reported as progress, not as a no-op", () => {
  const self = iteration({
    head_before: "aaaaaaaa",
    head_after: "cccccccc",
    decision: { action: "noop", version: null, sha: null, reason: "no change to score", primary: null, unit: "", pass: null },
  });
  assert.match(describeOutcome(self), /committed for itself/);
  const idle = iteration({
    decision: { action: "noop", version: null, sha: null, reason: "no change to score", primary: null, unit: "", pass: null },
  });
  assert.match(describeOutcome(idle), /nothing changed/);
});

test("a version the agent committed itself is named in the next turn's prompt, not just its sha (#42)", () => {
  const own = iteration({
    head_before: "aaaaaaaa",
    head_after: "cccccccc",
    decision: { action: "noop", version: null, sha: null, reason: "no change to score", primary: null, unit: "", pass: null },
    agent_versions: [{ version: 3, sha: "cccccccc", primary: 0.408, unit: "ms", why: "pigeonhole index" }],
  });
  const out = describeOutcome(own);
  assert.match(out, /the agent committed v3 at 0\.408 ms itself/);
  assert.doesNotMatch(out, /nothing changed/, "a turn that moved the lineage must not read as an empty one");
  // Both can happen in one turn: the agent commits, then leaves more for the harness to score.
  const both = iteration({ agent_versions: [{ version: 3, sha: "cccccccc", primary: 3, unit: "lines", why: null }] });
  assert.match(describeOutcome(both), /the agent committed v3 at 3 lines itself, and then the harness committed v1/);
});

test("a refusal with no measurement does not print a placeholder as if it were one", () => {
  const refused = iteration({
    decision: {
      action: "refused",
      version: null,
      sha: null,
      reason: "the candidate failed correctness",
      primary: null,
      unit: "lines",
      pass: false,
    },
  });
  const line = describeOutcome(refused);
  assert.match(line, /^refused — the candidate failed correctness/);
  assert.doesNotMatch(line, /— —/, "a null primary is not a score");
});

test("an agent that failed is described by its own failure, not by the commit decision", () => {
  const crashed = iteration({
    agent: { ...iteration().agent, ok: false, error: "the agent exited 3; its output is in .avo/runs/r/logs/1.log" },
  });
  assert.match(describeOutcome(crashed), /the agent itself failed/);
});

// ------------------------------------------------- the gitignore this slice fixed

test("a trajectory path added later reaches a repo that already had a .avo/.gitignore", () => {
  const dir = mkdtempSync(join(tmpdir(), "avo-ignore-"));
  mkdirSync(join(dir, ".avo"), { recursive: true });
  // Exactly what avo wrote before `.avo/runs/` existed. Returning early on this file — the original
  // behaviour — left every pre-S7b repo tracking its own run logs.
  writeFileSync(join(dir, ".avo/.gitignore"), "# written by avo commit: trajectory, not lineage\nattempts.jsonl\nworktrees/\n");
  ensureTrajectoryIgnored(dir);
  const body = readFileSync(join(dir, ".avo/.gitignore"), "utf8");
  assert.match(body, /^# written by avo commit/, "the header we did not write is left alone");
  assert.match(body, /^runs\/$/m, "the missing entry is appended");
  assert.equal(body.match(/worktrees\//g)?.length, 1, "an entry already there is not duplicated");

  const again = readFileSync(join(dir, ".avo/.gitignore"), "utf8");
  ensureTrajectoryIgnored(dir);
  assert.equal(readFileSync(join(dir, ".avo/.gitignore"), "utf8"), again, "re-running changes nothing");
});

test("a .avo/.gitignore avo did not write belongs to the operator", () => {
  const dir = mkdtempSync(join(tmpdir(), "avo-ignore2-"));
  mkdirSync(join(dir, ".avo"), { recursive: true });
  writeFileSync(join(dir, ".avo/.gitignore"), "secrets.env\n");
  ensureTrajectoryIgnored(dir);
  assert.equal(readFileSync(join(dir, ".avo/.gitignore"), "utf8"), "secrets.env\n");
});

test("every trajectory path has a gitignore entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "avo-ignore3-"));
  ensureTrajectoryIgnored(dir);
  const entries = readFileSync(join(dir, ".avo/.gitignore"), "utf8").split("\n").map((l) => l.trim());
  for (const p of TRAJECTORY_PATHS) {
    const name = p.replace(/^\.avo\//, "");
    assert.ok(
      entries.includes(name) || entries.includes(`${name}/`),
      `${p} is unstaged by avo commit but never ignored, so every other tool still sees it`,
    );
  }
});

// ------------------------------------------------------------- integration
// Real git, a real scorer and a real child process — but a stub agent, never a real agent CLI: CI
// has none, and a real one would make this suite non-deterministic and expensive (PLAN §4, S6).

const STUB = `#!/usr/bin/env bash
# A stand-in for a headless coding agent. Its behaviour is chosen by the prompt, so one stub covers
# every case the loop has to handle.
prompt="$1"
printf '%s' "$prompt" > "$PWD/last-prompt.txt"
printf '%s\\n' "$prompt" >> "$PWD/all-prompts.txt"
case "$prompt" in
  *noop*)  echo "I considered it and changed nothing"; exit 0 ;;
  *crash*) echo "boom" >&2; exit 3 ;;
  *slow*)  sleep 60; exit 0 ;;
  *selfcommit*)
    echo "own commit" >> kernel.txt
    git add -A >/dev/null 2>&1
    git commit -qm "the agent's own commit" >/dev/null 2>&1
    echo "I committed it myself"
    exit 0 ;;
  # What the avo-vary skill actually tells an agent to do: edit, then commit through avo, so the
  # tree is already clean when the loop's own step 2 looks at it.
  *avocommit*)
    echo "own commit" >> kernel.txt
    "{{AVO}}" commit --why "I measured it and committed this myself" >/dev/null 2>&1
    echo "I ran avo commit myself"
    exit 0 ;;
esac
echo "line at iteration \${AVO_FAN_PROBE:-?}" >> kernel.txt
echo "appended one line at depth \${AVO_FAN_LEVEL:-?}"
`;

const SCORER = `#!/usr/bin/env bash
n=$(wc -l < kernel.txt | tr -d ' ')
printf '{"ok":true,"correct":true,"primary":%s,"unit":"lines","higher_is_better":true}\\n' "$n"
`;

/** Always fails the same way, so the thrash signature is stable across iterations. */
const FAILING_SCORER = `#!/usr/bin/env bash
printf '{"ok":true,"correct":false,"primary":null,"unit":"lines","higher_is_better":true,"log":"assertion failed at kernel.txt:3"}\\n'
`;

/** The real CLI, so the stub commits exactly the way the avo-vary skill has an agent commit. */
const AVO_BIN = fileURLToPath(new URL("../bin/avo", import.meta.url));

interface Fixture {
  dir: string;
  git: (...args: string[]) => string;
}

function fixture(name: string, opts: { scorer?: string | false } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), `avo-${name}-`));
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "avo@example.com");
  git("config", "user.name", "avo");
  mkdirSync(join(dir, ".avo"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ".avo/runs/\n.avo/worktrees/\n.avo/attempts.jsonl\nlast-prompt.txt\nall-prompts.txt\n");
  writeFileSync(join(dir, "kernel.txt"), "baseline\n");
  writeFileSync(join(dir, "stub.sh"), STUB.replace("{{AVO}}", AVO_BIN), { mode: 0o755 });
  if (opts.scorer !== false) writeFileSync(join(dir, ".avo/score"), opts.scorer ?? SCORER, { mode: 0o755 });
  writeFileSync(
    join(dir, ".avo/config.json"),
    JSON.stringify({ agent: { name: "stub", command: join(dir, "stub.sh"), args: ["{prompt}"], format: "text" } }),
  );
  git("add", "-A");
  git("commit", "-qm", "baseline");
  return { dir, git };
}

async function run(f: Fixture, argv: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; json: RunReport }> {
  const io = bufferIo();
  const code = await runCommand([...argv, "--json", "--cwd", f.dir, "--agent", "stub"], io, undefined, undefined, {
    ...process.env,
    ...env,
  });
  return { code, json: JSON.parse(io.stdout) as RunReport };
}

test("the loop turns, commits and turns again — each version beating the last", async () => {
  const f = fixture("run3");
  const { code, json } = await run(f, ["--prompt", "make it longer", "--max-iters", "3"]);
  assert.equal(code, 0);
  assert.equal(json.iterations.length, 3);
  assert.deepEqual(json.committed, [1, 2, 3], "one committed version per productive turn");
  assert.equal(json.stopped, "max-iters");
  assert.equal(json.interventions, 0, "a loop that is making progress is never steered");

  for (const it of json.iterations) {
    assert.equal(it.agent.ok, true, `iteration ${it.iter}: ${it.agent.error}`);
    assert.equal(it.decision?.action, "committed");
    assert.equal(it.supervision?.triggered, false);
  }
  // The versions really are in git, written by the one writer that may write them (invariant 1).
  const log = f.git("log", "--format=%s");
  assert.match(log, /avo v3: 4 lines/);
  assert.match(f.git("log", "-1", "--format=%B", "HEAD"), /Avo-Version: 3/);
});

test("the agent's own final message becomes the commit rationale", async () => {
  const f = fixture("runwhy");
  await run(f, ["--prompt", "make it longer", "--max-iters", "1"]);
  assert.match(f.git("log", "-1", "--format=%B", "HEAD"), /appended one line at depth/);
});

test("each iteration is told what the previous one did", async () => {
  const f = fixture("runprompt");
  await run(f, ["--prompt", "make it longer", "--max-iters", "2"]);
  const last = readFileSync(join(f.dir, "last-prompt.txt"), "utf8");
  assert.match(last, /make it longer/, "the task survives every turn");
  assert.match(last, /iteration 2 of 2/);
  assert.match(last, /committed v1 at 2 lines/);
});

test("the manifest is rewritten after every iteration, not at the end", async () => {
  const f = fixture("runmanifest");
  const { json } = await run(f, ["--prompt", "make it longer", "--max-iters", "2"]);
  const m = readRunManifest(f.dir, json.run_id);
  assert.ok(!("error" in m));
  assert.equal(m.iterations.length, 2);
  assert.equal(m.run_id, json.run_id);
  assert.deepEqual(m.committed, [1, 2]);
  assert.ok(existsSync(join(f.dir, RUNS_DIR, json.run_id, RUN_MANIFEST)));
  assert.ok(existsSync(join(f.dir, RUNS_DIR, json.run_id, "logs", "1.log")), "each turn's raw output is on disk");
  assert.equal(listRuns(f.dir).length, 1);
});

test("the run log is trajectory: it never dirties the tree the next commit reasons about", async () => {
  const f = fixture("runclean");
  await run(f, ["--prompt", "make it longer", "--max-iters", "2"]);
  // .avo/runs/ must be excluded exactly the way .avo/worktrees/ is, or the second iteration would
  // score a "change" that is only the record of the first — the S3/S6 self-perturbation bug.
  assert.doesNotMatch(f.git("status", "--porcelain"), /\.avo\/runs/);
  assert.doesNotMatch(f.git("show", "--stat", "--format=", "HEAD"), /\.avo\/runs/);
});

test("a stalling loop is steered, and the directive lands in the next turn's prompt", async () => {
  const f = fixture("runsteer", { scorer: FAILING_SCORER });
  writeFileSync(join(f.dir, "kernel.txt"), "baseline\n");
  const { json } = await run(f, ["--prompt", "fix it", "--max-iters", "3", "--stall", "2", "--thrash", "2"]);

  assert.deepEqual(json.committed, [], "a failing f never yields a commit (invariant 2)");
  assert.ok(json.interventions >= 1, "two identical failures past the threshold must steer");
  const steered = json.iterations.find((i) => i.intervention !== null);
  assert.ok(steered !== undefined);
  assert.deepEqual(steered.intervention?.kinds.sort(), ["stall", "thrash"]);
  assert.match(steered.directive ?? "", /STEERING \(avo supervise\)/);

  const last = readFileSync(join(f.dir, "last-prompt.txt"), "utf8");
  assert.match(last, /STEERING \(avo supervise\)/, "the directive is injected, not merely reported");
  assert.equal(
    last.match(/STEERING \(avo supervise\)/g)?.length,
    1,
    "a directive must not quote the previous directive: interventions are trajectory, not citations",
  );
  assert.doesNotMatch(last, /avo-intervention-/, "the supervisor does not cite itself");
});

test("an intervention is recorded so the trajectory can be read afterwards", async () => {
  const f = fixture("runrecord", { scorer: FAILING_SCORER });
  const { json } = await run(f, ["--prompt", "fix it", "--max-iters", "2", "--stall", "2", "--thrash", "2"]);
  const steered = json.iterations.find((i) => i.intervention !== null);
  assert.ok(steered !== undefined);
  const memories = readFileSync(join(f.dir, "lineage/memory.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as { kind: string; key: string; text: string });
  const rec = memories.find((m) => m.key === steered.intervention?.key);
  assert.ok(rec !== undefined, "the injected directive is written down");
  assert.equal(rec.kind, "intervention", "not an insight: an insight would prime every future session");
  assert.match(rec.text, /steered on/);
});

test("an agent binary that cannot be started stops the loop instead of burning the budget", async () => {
  const f = fixture("runmissing");
  writeFileSync(
    join(f.dir, ".avo/config.json"),
    JSON.stringify({ agent: { name: "stub", command: join(f.dir, "not-a-binary"), args: ["{prompt}"], format: "text" } }),
  );
  const { code, json } = await run(f, ["--prompt", "go", "--max-iters", "5"]);
  assert.equal(code, 1);
  assert.equal(json.iterations.length, 1, "it does not try nine more times");
  assert.equal(json.stopped, "agent-unavailable");
  assert.match(json.stop_reason, /could not execute/);
});

test("an agent that changes nothing stops the loop, because the supervisor cannot see it", async () => {
  const f = fixture("runnoop");
  const { json } = await run(f, ["--prompt", "noop please", "--max-iters", "8"]);
  assert.equal(json.stopped, "no-progress");
  assert.equal(json.iterations.length, MAX_CONSECUTIVE_NOOPS);
  assert.deepEqual(json.committed, []);
  for (const it of json.iterations) assert.equal(it.decision?.action, "noop");
  // An unchanged tree is never scored, so nothing reaches the attempt log to stall on.
  assert.equal(existsSync(join(f.dir, ".avo/attempts.jsonl")), false);
});

test("an agent that commits for itself is not idle, so the loop keeps going", async () => {
  const f = fixture("runself");
  const { json } = await run(f, ["--prompt", "selfcommit", "--max-iters", "4"]);
  assert.equal(json.stopped, "max-iters", "HEAD moved every turn; that is not a no-op");
  assert.equal(json.iterations.length, 4);
  for (const it of json.iterations) {
    assert.equal(it.decision?.action, "noop", "the tree is clean after the agent's own commit");
    assert.notEqual(it.head_after, it.head_before, "but HEAD moved");
    assert.deepEqual(it.agent_versions, [], "a commit without the trailers is a commit, not a version");
  }
  assert.deepEqual(json.committed, [], "and it never becomes one by moving HEAD");
});

test("versions the agent commits itself are the run's output too (#42)", async () => {
  const f = fixture("runagentcommit");
  const { json } = await run(f, ["--prompt", "avocommit", "--max-iters", "3"]);
  assert.equal(json.stopped, "max-iters");
  assert.equal(json.iterations.length, 3);
  // The bug: every iteration is a `noop` — correctly — and the run still produced three versions.
  // Reading only the decision, this run is flat; reading agent_versions, it is the curve it was.
  assert.deepEqual(json.committed, [1, 2, 3], "the manifest must not under-report a well-behaved agent");
  for (const it of json.iterations) {
    assert.equal(it.decision?.action, "noop", "avo commit found a clean tree — the agent got there first");
    assert.equal(it.agent_versions.length, 1, `iteration ${it.iter} committed one version`);
    const v = it.agent_versions[0];
    assert.equal(v?.version, it.iter);
    assert.equal(v?.unit, "lines");
    assert.match(v?.why ?? "", /committed this myself/, "the rationale that landed is the agent's own");
  }
  assert.deepEqual(
    json.iterations.map((it) => it.agent_versions[0]?.sha),
    json.iterations.map((it) => it.head_after),
    "each version is the head the turn left behind",
  );
  // The same thing the loop tells the next turn, and the same thing a human reads at the end.
  assert.match(describeOutcome(json.iterations[1] as Iteration), /the agent committed v2 at 3 lines itself/);
  assert.match(renderRun(json), /committed {4}v1, v2, v3 \(3 by the agent itself\)/);
});

test(".avo/STOP halts the loop before the next turn", async () => {
  const f = fixture("runstop");
  writeFileSync(join(f.dir, STOP_FILE), "operator said so\n");
  const { code, json } = await run(f, ["--prompt", "make it longer", "--max-iters", "5"]);
  assert.equal(json.iterations.length, 0, "the sentinel is checked before the agent is spawned");
  assert.equal(json.stopped, "stop-file");
  assert.equal(code, 1, "a loop that never ran a turn did not get anywhere");
  assert.equal(f.git("log", "--format=%s").trim(), "baseline", "nothing was committed");
});

test("a turn that exceeds its timeout is killed and the loop carries on", async () => {
  const f = fixture("runslow");
  const { json } = await run(f, ["--prompt", "slow", "--max-iters", "1", "--timeout", "2"]);
  assert.equal(json.iterations.length, 1);
  const it = json.iterations[0];
  assert.equal(it?.agent.timed_out, true);
  assert.equal(it?.agent.ok, false);
  assert.match(it?.agent.error ?? "", /exceeded --timeout 2s/);
});

test("--dry-run resolves everything and writes nothing", async () => {
  const f = fixture("rundry");
  const before = f.git("status", "--porcelain");
  const { code, json } = await run(f, ["--prompt", "make it longer", "--max-iters", "3", "--dry-run"]);
  assert.equal(code, 0);
  assert.equal(json.stopped, "dry-run");
  assert.equal(json.iterations.length, 0);
  assert.equal(json.max_iters, 3);
  assert.match(json.command, /stub\.sh <prompt>/, "the resolved command line, prompt elided");
  assert.equal(existsSync(join(f.dir, RUNS_DIR)), false, "not even a run directory");
  assert.equal(f.git("status", "--porcelain"), before);
  assert.equal(existsSync(join(f.dir, "last-prompt.txt")), false, "nothing was spawned");

  const io = bufferIo();
  await runCommand(["--prompt", "make it longer", "--max-iters", "3", "--dry-run", "--cwd", f.dir, "--agent", "stub"], io);
  assert.match(io.stdout, /nothing is spawned, nothing is committed/);
  assert.match(io.stdout, /up to 3/);
  assert.match(io.stdout, /avo supervise/);
  assert.match(io.stdout, /turn prompt \(iteration 1\)/);
  assert.match(io.stdout, /make it longer/);
});

test("a repo with no scorer is warned once, not --max-iters times", async () => {
  const f = fixture("runnoscore", { scorer: false });
  const { json } = await run(f, ["--prompt", "make it longer", "--max-iters", "1", "--dry-run"]);
  assert.ok(json.warnings.some((w) => /\.avo\/score does not exist/.test(w)));
});

test("the same guards as avo fan: a loop inside a loop is bounded", async () => {
  const f = fixture("runguard");
  // A refusal writes to stderr and prints no report, so this cannot go through the JSON helper.
  const deepIo = bufferIo();
  const deep = await runCommand(["--prompt", "go", "--cwd", f.dir, "--agent", "stub"], deepIo, undefined, undefined, {
    ...process.env,
    [LEVEL_ENV]: "3",
    [DEPTH_ENV]: "3",
  });
  assert.equal(deep, 1);
  assert.match(deepIo.stderr, /depth limit reached/);
  assert.equal(existsSync(join(f.dir, RUNS_DIR)), false, "a refused run creates nothing");

  const io = bufferIo();
  const code = await runCommand(["--prompt", "go", "--cwd", f.dir, "--agent", "stub"], io, undefined, undefined, {
    ...process.env,
    [CHAIN_ENV]: promptSha("go"),
  });
  assert.equal(code, 1);
  assert.match(io.stderr, /cycle/, "the same prompt already being run higher up is a cycle");
});

test("the guard state reaches the agent, so a turn knows how deep it is", async () => {
  const f = fixture("runenv");
  await run(f, ["--prompt", "make it longer", "--max-iters", "1"]);
  assert.match(readFileSync(join(f.dir, "kernel.txt"), "utf8"), /line at iteration 1/);
  assert.match(f.git("log", "-1", "--format=%B", "HEAD"), /at depth 1/, "one level deeper than its parent");
});

test("a run outside a git repository is refused, since the lineage lives in git", async () => {
  const dir = mkdtempSync(join(tmpdir(), "avo-nogit-"));
  const io = bufferIo();
  const code = await runCommand(["--prompt", "go", "--cwd", dir, "--agent", "pi"], io);
  assert.equal(code, 1);
  assert.match(io.stderr, /not a git repository/);
});

test("an unknown agent names the ones that exist", async () => {
  const f = fixture("runagent");
  const io = bufferIo();
  const code = await runCommand(["--prompt", "go", "--cwd", f.dir, "--agent", "nope"], io);
  assert.equal(code, 1);
  assert.match(io.stderr, /unknown agent 'nope'/);
  assert.match(io.stderr, /stub/, "including the one this repo declared");
});

test("the human rendering names every iteration, its verdict and where the record is", async () => {
  const f = fixture("runrender");
  const io = bufferIo();
  const code = await runCommand(["--prompt", "make it longer", "--max-iters", "2", "--cwd", f.dir, "--agent", "stub"], io);
  assert.equal(code, 0);
  assert.match(io.stdout, /committed v1 2 lines/);
  assert.match(io.stdout, /committed v2 3 lines/);
  assert.match(io.stdout, /committed {4}v1, v2/);
  assert.match(io.stdout, /stopped: max-iters/);
  assert.match(io.stdout, new RegExp(RUN_MANIFEST));
});

test("a report with no iterations still renders", () => {
  const empty: RunReport = {
    version: 1,
    ok: false,
    run_id: "r",
    cwd: "/tmp/x",
    agent: "pi",
    approval: "--approve",
    command: "pi --print",
    model: null,
    max_iters: 3,
    timeout_s: 900,
    prompt_sha: "abc",
    prompt: "go",
    baseline: "a".repeat(40),
    head: "a".repeat(40),
    started_at: "2026-08-24T00:00:00.000Z",
    finished_at: "2026-08-24T00:00:01.000Z",
    thresholds: { stall: 5, thrash: 3 },
    iterations: [],
    committed: [],
    interventions: 0,
    tokens: { input: 0, output: 0 },
    stopped: "stop-file",
    stop_reason: "someone said so",
    warnings: [],
    errors: [],
  };
  assert.match(renderRun(empty), /stopped: stop-file — someone said so/);
  assert.match(renderRun(empty), /committed {4}nothing/);
});

test("a manifest that is not ours is reported rather than parsed as one", () => {
  const dir = mkdtempSync(join(tmpdir(), "avo-badmanifest-"));
  mkdirSync(join(dir, RUNS_DIR, "r"), { recursive: true });
  writeFileSync(join(dir, RUNS_DIR, "r", RUN_MANIFEST), JSON.stringify({ version: 9 }));
  const m = readRunManifest(dir, "r");
  assert.ok("error" in m);
  assert.equal(listRuns(dir).length, 0, "an unreadable run is skipped, not fatal");
  assert.ok("error" in readRunManifest(dir, "nope"));
  assert.deepEqual(listRuns(mkdtempSync(join(tmpdir(), "avo-noruns-"))), []);
});
