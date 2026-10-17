import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CHAIN_ENV, DEFAULT_TIMEOUT_S, DEPTH_ENV, LEVEL_ENV, promptSha } from "../src/fan.ts";
import { bufferIo } from "../src/io.ts";
import { commitCommand, ensureTrajectoryIgnored, parseCommitArgs, TRAJECTORY_PATHS } from "../src/lineage.ts";
import { hashFiles, parsePins, SCORER_ENV, scorerChanges, scorerPaths, spawnRunner, type Runner } from "../src/score.ts";
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

test("the run budgets are off by default and parse as numbers (#28)", () => {
  const d = parseRunArgs(["--prompt", "x"], {});
  assert.ok(!("error" in d));
  assert.deepEqual([d.maxCost, d.maxTokens, d.maxWallS], [null, null, null]);
  const o = parseRunArgs(["--prompt", "x", "--max-cost", "2.5", "--max-tokens", "100000", "--max-wall", "600"], {});
  assert.ok(!("error" in o));
  assert.deepEqual([o.maxCost, o.maxTokens, o.maxWallS], [2.5, 100000, 600]);
  for (const [flag, bad] of [["--max-cost", "0"], ["--max-cost", "free"], ["--max-tokens", "1.5"], ["--max-tokens", "-3"], ["--max-wall", "0"]]) {
    const e = parseRunArgs(["--prompt", "x", flag as string, bad as string], {});
    assert.ok("error" in e, `${flag} ${bad} should be refused`);
    assert.match(e.error, /positive/);
  }
});

test("a flag with no value is named rather than silently swallowing the next one", () => {
  const o = parseRunArgs(["--prompt"], {});
  assert.ok("error" in o);
  assert.match(o.error, /--prompt needs a value/);
});

test("--supervise defaults to on and takes on, off or detect", () => {
  const d = parseRunArgs(["--prompt", "x"], {});
  assert.ok(!("error" in d));
  assert.equal(d.supervise, "on");
  for (const m of ["on", "off", "detect"] as const) {
    const o = parseRunArgs(["--prompt", "x", "--supervise", m], {});
    assert.ok(!("error" in o));
    assert.equal(o.supervise, m);
  }
  const bad = parseRunArgs(["--prompt", "x", "--supervise", "maybe"], {});
  assert.ok("error" in bad);
  assert.match(bad.error, /on, off or detect/);
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
    cost_usd: null,
    wall_s: 1,
    exit_code: 0,
    timed_out: false,
    truncated: false,
    spawn_failed: false,
    approval_refused: false,
    error: null,
  },
  log_path: ".avo/runs/r/logs/1.log",
  decision: { action: "committed", version: 1, sha: "bbbbbbbb", reason: "improved", primary: 2, unit: "lines", pass: true },
  agent_versions: [],
  supervision: { triggered: false, signals: [], since_best: 0, variations_since_best: 0, repeat: 0 },
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
  # Edits f itself (#38).
  *tamper*)
    echo "line" >> kernel.txt
    echo "# tuned" >> .avo/score
    echo "I improved the scorer"
    exit 0 ;;
  *guarded*)
    echo "line" >> kernel.txt
    echo "edited" >> bench.txt
    echo "I edited a protected file"
    exit 0 ;;
  # Edits f, commits, then hides the edit.
  *cheatrestore*)
    echo "line" >> kernel.txt
    echo "# tuned" >> .avo/score
    "{{AVO}}" commit --why "scored by my scorer" > .git/avo-commit.out 2>&1
    git checkout -q -- .avo/score
    echo "I committed with my scorer, then put it back"
    exit 0 ;;
  *cheat*)
    echo "line" >> kernel.txt
    echo "# tuned" >> .avo/score
    "{{AVO}}" commit --why "scored by my scorer" > .git/avo-commit.out 2>&1
    echo "I committed with my scorer"
    exit 0 ;;
  *commitfirst*)
    echo "line" >> kernel.txt
    "{{AVO}}" commit --why "an honest version" >/dev/null 2>&1
    echo "# tuned" >> .avo/score
    echo "I committed, then edited the scorer"
    exit 0 ;;
  *nap*)   sleep 1 ;;
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
# As the avo-vary skill tells it.
case "$prompt" in
  *selfsup*) "{{AVO}}" supervise --stall 1 >> "$PWD/selfsup.txt" 2>&1 ;;
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
  writeFileSync(join(dir, ".gitignore"), ".avo/runs/\n.avo/worktrees/\n.avo/attempts.jsonl\nlast-prompt.txt\nall-prompts.txt\nselfsup.txt\n");
  writeFileSync(join(dir, "kernel.txt"), "baseline\n");
  writeFileSync(join(dir, "stub.sh"), STUB.replaceAll("{{AVO}}", AVO_BIN), { mode: 0o755 });
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

// #49. The stub speaks claude's stream-json and never emits a `result` event — a turn killed by
// --timeout looks exactly like this. Before the fix the last event on the wire became `--why`, and
// a `{"type":"system","subtype":"thinking_tokens",...}` object was written into the commit body,
// lineage/vNNN.md and memory.jsonl, permanently, to be replayed to later turns as a rationale.
const SILENT_STREAM_STUB = `#!/bin/sh
echo "a line the agent added" >> kernel.txt
echo '{"type":"system","subtype":"init","session_id":"s"}'
echo '{"type":"system","subtype":"thinking_tokens","estimated_tokens":3450,"session_id":"s"}'
`;

test("a turn that ends in a protocol event commits with no rationale, and says so (#49)", async () => {
  const f = fixture("runsilent");
  writeFileSync(join(f.dir, "silent.sh"), SILENT_STREAM_STUB, { mode: 0o755 });
  writeFileSync(
    join(f.dir, ".avo/config.json"),
    JSON.stringify({ agent: { name: "stub", command: join(f.dir, "silent.sh"), args: ["{prompt}"], format: "claude" } }),
  );
  f.git("add", "-A");
  f.git("commit", "-qm", "a stub that says nothing");

  const { json } = await run(f, ["--prompt", "make it longer", "--max-iters", "1"]);
  const it = json.iterations[0];
  assert.equal(it?.agent.summary, null, "a protocol event is not something the agent said");
  assert.equal(it?.decision?.action, "committed", "the turn still did real work and is still a version");

  const body = f.git("log", "-1", "--format=%B", "HEAD");
  assert.doesNotMatch(body, /thinking_tokens/, "nothing permanent may carry protocol noise");
  assert.doesNotMatch(readFileSync(join(f.dir, "lineage/memory.jsonl"), "utf8"), /thinking_tokens/);
  // Silence is recorded rather than papered over: an unexplained version is worth noticing.
  assert.ok(it?.warnings.some((w) => /no final message/.test(w)), `warnings were ${JSON.stringify(it?.warnings)}`);
  assert.match(renderRun(json), /no final message/);
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

const interventionsIn = (dir: string): number => {
  const p = join(dir, "lineage/memory.jsonl");
  if (!existsSync(p)) return 0;
  return readFileSync(p, "utf8").split("\n").filter((l) => l.includes('"kind":"intervention"')).length;
};

test("--supervise off never calls the supervisor and never steers", async () => {
  const f = fixture("runoff", { scorer: FAILING_SCORER });
  const { json } = await run(f, ["--prompt", "fix it", "--max-iters", "3", "--stall", "2", "--thrash", "2", "--supervise", "off"]);
  assert.equal(json.supervise, "off");
  assert.equal(json.interventions, 0);
  for (const it of json.iterations) {
    assert.equal(it.supervision, null, "off means no detector call");
    assert.equal(it.directive, null);
  }
  const prompts = readFileSync(join(f.dir, "all-prompts.txt"), "utf8");
  assert.doesNotMatch(prompts, /STEERING/);
  assert.doesNotMatch(prompts, /since the best version/, "no supervisor state leaks into the prompt");
  assert.equal(interventionsIn(f.dir), 0);
  const m = readRunManifest(f.dir, json.run_id);
  assert.ok(!("error" in m));
  assert.equal(m.supervise, "off");
});

test("--supervise detect records what would have fired, and injects nothing", async () => {
  const f = fixture("rundetect", { scorer: FAILING_SCORER });
  const { json } = await run(f, ["--prompt", "fix it selfsup", "--max-iters", "3", "--stall", "2", "--thrash", "2", "--supervise", "detect"]);
  assert.equal(json.supervise, "detect");
  assert.equal(json.interventions, 0, "nothing was injected, so nothing intervened");
  assert.ok((json.detections ?? 0) >= 1, "the stall is still visible in an unsteered arm");
  const fired = json.iterations.find((i) => i.supervision?.triggered === true);
  assert.ok(fired !== undefined);
  assert.match(fired.withheld ?? "", /STEERING \(avo supervise\)/, "the held-back directive is kept");
  assert.equal(fired.directive, null);
  assert.equal(fired.intervention, null);

  // The agent's view must match the off arm.
  const prompts = readFileSync(join(f.dir, "all-prompts.txt"), "utf8");
  assert.doesNotMatch(prompts, /STEERING/);
  assert.doesNotMatch(prompts, /since the best version/);
  assert.equal(interventionsIn(f.dir), 0, "no memory: the agent reads memory, so a record would leak");
  const own = readFileSync(join(f.dir, "selfsup.txt"), "utf8");
  assert.match(own, /off in this run \(--supervise detect\)/, "the agent's own avo supervise is off too");
  assert.doesNotMatch(own, /STEERING/);
  assert.match(renderRun(json), /detected only; nothing injected/);
  assert.match(renderRun(json), /detections\s+\d+/);
});

test("an agent binary that cannot be started stops the loop instead of burning the budget", async () => {
  const f = fixture("runmissing");
  writeFileSync(
    join(f.dir, ".avo/config.json"),
    JSON.stringify({ agent: { name: "stub", command: join(f.dir, "not-a-binary"), args: ["{prompt}"], format: "text" } }),
  );
  const { code, json } = await run(f, ["--prompt", "go", "--max-iters", "5", "--max-cost", "1", "--max-tokens", "10"]);
  assert.equal(code, 1);
  assert.equal(json.iterations.length, 1, "it does not try nine more times");
  assert.equal(json.stopped, "agent-unavailable");
  assert.match(json.stop_reason, /could not execute/);
  // A turn that never ran says nothing of usage.
  assert.deepEqual(json.budget.unenforced, []);
  assert.ok(!json.warnings.some((w) => /unenforced/.test(w)), JSON.stringify(json.warnings));
});

// #23: a managed setting can refuse bypassPermissions.
const REFUSED_STUB = `#!/bin/sh
echo '{"type":"system","subtype":"init","session_id":"s","permissionMode":"auto"}'
echo '{"type":"result","subtype":"success","result":"I need permission.","permission_denials":[{"tool_name":"Edit"}]}'
`;

test("a claude that refuses bypassPermissions stops the loop after one turn", async () => {
  const f = fixture("runrefused");
  const stub = join(f.dir, "claude-stub.sh");
  writeFileSync(stub, REFUSED_STUB, { mode: 0o755 });
  // PATH never reaches the spawn; swap the command.
  const runner: Runner = (cmd, args, o) => spawnRunner(cmd === "claude" ? stub : cmd, args, o);
  const io = bufferIo();
  const code = await runCommand(
    ["--prompt", "go", "--max-iters", "5", "--json", "--cwd", f.dir, "--agent", "claude"],
    io,
    runner,
  );
  const json = JSON.parse(io.stdout) as RunReport;
  assert.equal(code, 1);
  assert.equal(json.iterations.length, 1, "it does not spend four more turns");
  assert.equal(json.stopped, "approval-refused");
  assert.match(json.stop_reason, /ignored bypassPermissions and ran in mode 'auto'/);
  assert.equal(json.iterations[0]?.agent.ok, false);
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

// Speaks claude's stream-json: every turn reports usage and cost.
const PRICED_STUB = `#!/bin/sh
echo "a line" >> kernel.txt
echo '{"type":"result","result":"added a line","total_cost_usd":0.25,"usage":{"input_tokens":100,"output_tokens":900}}'
`;

function pricedFixture(name: string): Fixture {
  const f = fixture(name);
  writeFileSync(join(f.dir, "priced.sh"), PRICED_STUB, { mode: 0o755 });
  writeFileSync(
    join(f.dir, ".avo/config.json"),
    JSON.stringify({ agent: { name: "stub", command: join(f.dir, "priced.sh"), args: ["{prompt}"], format: "claude" } }),
  );
  f.git("add", "-A");
  f.git("commit", "-qm", "a stub that reports usage");
  return f;
}

test("--max-cost stops the loop before the turn after it is crossed (#28)", async () => {
  const f = pricedFixture("runcost");
  const { code, json } = await run(f, ["--prompt", "make it longer", "--max-iters", "10", "--max-cost", "0.5"]);
  assert.equal(code, 0, "a budget stop is a normal end, not a failure");
  assert.equal(json.iterations.length, 2, "$0.25 a turn: the second turn reaches $0.50");
  assert.equal(json.stopped, "budget");
  assert.match(json.stop_reason, /--max-cost \$0\.5 reached: \$0\.50 spent; stopped before iteration 3/);
  assert.deepEqual(json.budget.unenforced, []);
  assert.equal(json.budget.max_cost_usd, 0.5);
});

test("--max-tokens counts every token the turn reported (#28)", async () => {
  const f = pricedFixture("runtokens");
  const { json } = await run(f, ["--prompt", "make it longer", "--max-iters", "10", "--max-tokens", "2500"]);
  assert.equal(json.iterations.length, 3, "1000 tokens a turn: the third turn crosses 2500");
  assert.equal(json.stopped, "budget");
  assert.match(json.stop_reason, /--max-tokens 2500 reached: 3000 used/);
});

test("--max-wall stops the loop once the run is older than it (#28)", async () => {
  const f = fixture("runwall");
  // Each nap turn takes one second.
  const { code, json } = await run(f, ["--prompt", "nap, then make it longer", "--max-iters", "5", "--max-wall", "1"]);
  assert.equal(code, 0);
  assert.equal(json.iterations.length, 1);
  assert.equal(json.stopped, "budget");
  assert.match(json.stop_reason, /--max-wall 1s reached: \ds elapsed; stopped before iteration 2/);
});

test("an agent that reports no usage warns once and leaves its budgets unenforced (#28)", async () => {
  const f = fixture("rununenforced");
  const { json } = await run(f, ["--prompt", "make it longer", "--max-iters", "3", "--max-cost", "0.01", "--max-tokens", "10"]);
  assert.equal(json.iterations.length, 3, "nothing measured, so nothing stops the loop");
  assert.equal(json.stopped, "max-iters");
  assert.deepEqual(json.budget.unenforced, ["cost", "tokens"]);
  const said = json.warnings.filter((w) => /budget unenforced/.test(w));
  assert.equal(said.length, 1, `one warning, not one per turn: ${JSON.stringify(json.warnings)}`);
  assert.match(renderRun(json), /budget {7}\$0\.01, 10 tokens \(unenforced: cost, tokens\)/);
});

test("a budget the operator did not set is never called unenforced", async () => {
  const f = fixture("runnobudget");
  const { json } = await run(f, ["--prompt", "make it longer", "--max-iters", "1", "--max-wall", "3600"]);
  assert.deepEqual(json.budget.unenforced, [], "wall time is always measured");
  assert.ok(!json.warnings.some((w) => /unenforced/.test(w)));
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

// --------------------------------------------- the scorer is fixed for a run (#38)

test("the scorer's files are .avo/score plus the protected list and its paths", () => {
  const f = fixture("runpaths");
  assert.deepEqual(scorerPaths(f.dir), [".avo/score"], "no protected list: the scorer alone");
  writeFileSync(join(f.dir, ".avo/protected.txt"), "# comment\n\nbench.txt\n.avo/score\n  data/x.txt  \n");
  assert.deepEqual(scorerPaths(f.dir), [".avo/score", ".avo/protected.txt", "bench.txt", "data/x.txt"]);
});

test("a hash change, a new file and a deleted file all count as a change", () => {
  const f = fixture("runhash");
  writeFileSync(join(f.dir, "bench.txt"), "v1\n");
  const start = hashFiles(f.dir, [".avo/score", "bench.txt", "absent.txt"]);
  assert.match(start[".avo/score"] ?? "", /^[0-9a-f]{64}$/);
  assert.equal(start["absent.txt"], null);
  assert.deepEqual(scorerChanges(f.dir, start), []);
  writeFileSync(join(f.dir, "bench.txt"), "v2\n");
  writeFileSync(join(f.dir, "absent.txt"), "now here\n");
  assert.deepEqual(scorerChanges(f.dir, start), ["bench.txt", "absent.txt"]);
});

test("the manifest records the scorer's hash at start", async () => {
  const f = fixture("runhashman");
  const { json } = await run(f, ["--prompt", "make it longer", "--max-iters", "1"]);
  assert.deepEqual(Object.keys(json.scorer_hashes), [".avo/score"]);
  const m = readRunManifest(f.dir, json.run_id);
  assert.ok(!("error" in m));
  assert.deepEqual(m.scorer_hashes, json.scorer_hashes);
});

test("a turn that edits the scorer stops the run and commits nothing", async () => {
  const f = fixture("runtamper");
  const { code, json } = await run(f, ["--prompt", "tamper", "--max-iters", "5"]);
  assert.equal(code, 1, "a tampered run is an error");
  assert.equal(json.stopped, "scorer-changed");
  assert.equal(json.iterations.length, 1, "it stops at the first turn");
  assert.equal(json.iterations[0]?.decision, null, "avo commit never ran");
  assert.match(json.stop_reason, /\.avo\/score/);
  assert.deepEqual(json.committed, []);
  assert.equal(f.git("log", "--format=%s").trim(), "baseline", "nothing was committed");
  assert.equal(existsSync(join(f.dir, ".avo/attempts.jsonl")), false, "the edited f was never run");
});

test("a turn that edits a protected file stops the run too", async () => {
  const f = fixture("runprotect");
  writeFileSync(join(f.dir, "bench.txt"), "fixed\n");
  writeFileSync(join(f.dir, ".avo/protected.txt"), "bench.txt\n");
  f.git("add", "-A");
  f.git("commit", "-qm", "protect bench.txt");
  const { json } = await run(f, ["--prompt", "guarded", "--max-iters", "3"]);
  assert.equal(json.stopped, "scorer-changed");
  assert.match(json.stop_reason, /bench\.txt/);
  assert.deepEqual(json.committed, []);
});

test("avo commit inside a turn refuses an edited scorer", async () => {
  const f = fixture("runcheat");
  const { code, json } = await run(f, ["--prompt", "cheat", "--max-iters", "3"]);
  assert.equal(code, 1);
  assert.equal(json.stopped, "scorer-changed");
  assert.deepEqual(json.committed, []);
  assert.deepEqual(json.iterations[0]?.agent_versions, []);
  assert.equal(f.git("log", "--format=%s").trim(), "baseline", "the agent's own avo commit wrote nothing");
  assert.match(readFileSync(join(f.dir, ".git/avo-commit.out"), "utf8"), /refused — f changed since avo run started: \.avo\/score/);
});

test("an edit undone before the turn ends still never commits", async () => {
  const f = fixture("runcheatrestore");
  const { json } = await run(f, ["--prompt", "cheatrestore", "--max-iters", "1"]);
  // f is back, so the run goes on and scores with the real f.
  assert.equal(json.stopped, "max-iters");
  assert.deepEqual(json.iterations[0]?.agent_versions, [], "no version came from the edited f");
  assert.match(readFileSync(join(f.dir, ".git/avo-commit.out"), "utf8"), /refused — f changed/);
  assert.equal(json.iterations[0]?.decision?.action, "committed", "the real f judged the same change");
  assert.deepEqual(json.committed, [1]);
});

test("a version committed before the scorer edit is still listed", async () => {
  const f = fixture("runcommitfirst");
  const { json } = await run(f, ["--prompt", "commitfirst", "--max-iters", "3"]);
  assert.equal(json.stopped, "scorer-changed");
  assert.deepEqual(json.committed, [1], "the honest v1 is the run's output");
  assert.equal(json.iterations[0]?.agent_versions[0]?.version, 1);
  assert.match(json.stop_reason, /avo run committed nothing/);
});

test("avo commit reads the pins avo run hands its turns", () => {
  const pins = { ".avo/score": "a".repeat(64), "bench.txt": null };
  const o = parseCommitArgs([], { [SCORER_ENV]: JSON.stringify(pins) });
  assert.ok(!("error" in o));
  assert.deepEqual(o.pins, pins);
  const none = parseCommitArgs([], {});
  assert.ok(!("error" in none));
  assert.equal(none.pins, null, "outside avo run, nothing is pinned");
  for (const bad of ["", "not json", "[]", "{}", '{"x":1}']) assert.equal(parsePins(bad), null, bad);
});

test("avo commit with no pins keeps today's behavior", async () => {
  const f = fixture("commitnopins");
  writeFileSync(join(f.dir, "kernel.txt"), "a\nb\nc\nd\n");
  writeFileSync(join(f.dir, ".avo/score"), `${readFileSync(join(f.dir, ".avo/score"), "utf8")}# tuned\n`);
  const prev = process.env[SCORER_ENV];
  delete process.env[SCORER_ENV];
  try {
    const code = await commitCommand(["--cwd", f.dir, "--json", "--no-record"], bufferIo());
    assert.equal(code, 0, "a human may change f outside a run");
  } finally {
    if (prev !== undefined) process.env[SCORER_ENV] = prev;
  }
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
  assert.match(io.stdout, /budget {7}none/);

  const b = bufferIo();
  await runCommand(["--prompt", "go", "--max-cost", "5", "--max-wall", "600", "--dry-run", "--cwd", f.dir, "--agent", "stub"], b);
  assert.match(b.stdout, /budget {7}\$5, 600s wall/);
});

test("--dry-run shows the supervise mode and what it changes", async () => {
  const f = fixture("rundrymode");
  const plan = async (mode: string): Promise<string> => {
    const io = bufferIo();
    await runCommand(["--prompt", "x", "--dry-run", "--supervise", mode, "--cwd", f.dir, "--agent", "stub"], io);
    return io.stdout;
  };
  assert.match(await plan("on"), /supervise\s+on/);
  assert.match(await plan("on"), /record it as an intervention/);
  assert.match(await plan("off"), /no avo supervise \(--supervise off\)/);
  assert.match(await plan("detect"), /record that directive as withheld; inject nothing/);
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
    budget: { max_cost_usd: null, max_tokens: null, max_wall_s: null, unenforced: [] },
    prompt_sha: "abc",
    prompt: "go",
    baseline: "a".repeat(40),
    head: "a".repeat(40),
    started_at: "2026-08-24T00:00:00.000Z",
    finished_at: "2026-08-24T00:00:01.000Z",
    thresholds: { stall: 5, thrash: 3 },
    scorer_hashes: {},
    iterations: [],
    committed: [],
    interventions: 0,
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    cost_usd: null,
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
