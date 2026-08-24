import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONFIG_PATH, DEFAULT_STALL, DEFAULT_THRASH } from "../src/config.ts";
import { bufferIo } from "../src/io.ts";
import type { DocRef } from "../src/knowledge.ts";
import type { Version } from "../src/lineage.ts";
import type { Memory } from "../src/mem.ts";
import { ATTEMPTS_PATH, type Attempt, type RunOpts, type Runner, type RunResult } from "../src/score.ts";
import {
  ANALYSIS_WINDOW,
  citationsFor,
  detect,
  exploredCorpus,
  failureSignature,
  isExplored,
  normalizeSignature,
  parseSuperviseArgs,
  readAttempts,
  renderDirective,
  supervise,
  superviseCommand,
  unexplored,
} from "../src/supervise.ts";

// ---------------------------------------------------------------- fixtures

/** A passing attempt at `ts`, `primary` units. Everything else is what a real scorer reports. */
function attempt(ts: string, over: Partial<Attempt> = {}): Attempt {
  return {
    ts,
    ok: true,
    correct: true,
    pass: true,
    primary: 100,
    normalized: 100,
    unit: "tflops",
    higher_is_better: true,
    scores: {},
    duration_s: 1,
    configs: ["*"],
    parallel: false,
    errors: [],
    warnings: [],
    log: null,
    exit_code: 0,
    git: { head: "abc1234", dirty: false },
    ...over,
  };
}

const failed = (ts: string, over: Partial<Attempt> = {}): Attempt =>
  attempt(ts, { ok: true, correct: false, pass: false, primary: null, normalized: null, ...over });

function version(n: number, over: Partial<Version> = {}): Version {
  return {
    version: n,
    sha: `sha${n}`.padEnd(40, "0"),
    date: `2026-08-24T09:0${n}:00+00:00`,
    subject: `v${n}`,
    why: `direction ${n}`,
    score: { primary: 100 * n, unit: "tflops", higher_is_better: true, scores: { "*": 100 * n } },
    ...over,
  };
}

const base = { stall: DEFAULT_STALL, thrash: DEFAULT_THRASH };

// ---------------------------------------------------------------- the stall

test("no attempts and no versions is not a stall — a repo that has not started is not stuck", () => {
  const { state, signals } = detect({ versions: [], attempts: [], ...base });
  assert.deepEqual(signals, []);
  assert.equal(state.since_best, 0);
  assert.equal(state.best, null);
});

test("the stall fires at exactly N attempts since the best version, not before", () => {
  const versions = [version(1)];
  for (let n = 1; n <= DEFAULT_STALL + 1; n++) {
    const attempts = Array.from({ length: n }, (_, i) => attempt(`2026-08-24T10:${String(10 + i).padStart(2, "0")}:00.000Z`));
    const { state, signals } = detect({ versions, attempts, ...base });
    assert.equal(state.since_best, n);
    const fired = signals.some((s) => s.kind === "stall");
    assert.equal(fired, n >= DEFAULT_STALL, `${n} attempts since v1 should ${n >= DEFAULT_STALL ? "" : "not "}fire`);
  }
});

test("the stall counter resets on a committed improvement", () => {
  const attempts = Array.from({ length: 6 }, (_, i) => attempt(`2026-08-24T10:0${i}:00.000Z`));
  // v1 was committed at 09:01, before every attempt, so all six count against it.
  assert.equal(detect({ versions: [version(1)], attempts, ...base }).state.since_best, 6);
  // v2 is committed at 10:04, which leaves only the 10:05 attempt after it.
  const v2 = version(2, { date: "2026-08-24T10:04:00+00:00" });
  const after = detect({ versions: [version(1), v2], attempts, ...base });
  assert.equal(after.state.since_best, 1);
  assert.deepEqual(after.signals, []);
  assert.equal(after.state.best?.version, 2);
});

test("the attempt that became the version does not count as an attempt since it", () => {
  // git records author dates to the second; the attempt is scored moments *before* the commit. At
  // millisecond resolution this attempt would read as one made "since" v1 and the stall would fire
  // one attempt early, forever.
  const v1 = version(1, { date: "2026-08-24T10:00:00+00:00" });
  const scoring = attempt("2026-08-24T10:00:00.480Z");
  assert.equal(detect({ versions: [v1], attempts: [scoring], ...base }).state.since_best, 0);
  assert.equal(detect({ versions: [v1], attempts: [scoring, attempt("2026-08-24T10:00:01.000Z")], ...base }).state.since_best, 1);
});

test("an attempt scored on top of the best version counts, however close to the commit it lands", () => {
  // The head the attempt recorded, not its clock, is what says which side of the commit it is on:
  // with a fast scorer several real attempts land inside the commit's own second.
  const v1 = version(1, { date: "2026-08-24T10:00:00+00:00" });
  const onTop = Array.from({ length: 3 }, (_, i) =>
    attempt(`2026-08-24T10:00:00.${300 + i}Z`, { git: { head: v1.sha, dirty: true } }),
  );
  const committing = attempt("2026-08-24T10:00:00.100Z", { git: { head: "parent".padEnd(40, "0"), dirty: false } });
  const { state } = detect({ versions: [v1], attempts: [committing, ...onTop], stall: 3, thrash: 9 });
  assert.equal(state.since_best, 3, "the three scored on top of v1 count; the one that made it does not");
});

test("with no version at all, every attempt counts and the reason says so", () => {
  const attempts = Array.from({ length: DEFAULT_STALL }, (_, i) => failed(`2026-08-24T10:0${i}:00.000Z`));
  const { signals } = detect({ versions: [], attempts, ...base });
  const stall = signals.find((s) => s.kind === "stall");
  assert.ok(stall !== undefined);
  assert.match(stall.detail, /no version has ever been committed/);
});

test("a version whose date git could not give us degrades to counting everything, not to a crash", () => {
  const bad = version(1, { date: "not-a-date" });
  const attempts = [attempt("2026-08-24T10:00:00.000Z"), attempt("2026-08-24T10:01:00.000Z")];
  assert.equal(detect({ versions: [bad], attempts, ...base }).state.since_best, 2);
});

test("--stall 1 fires on the first attempt after the best version", () => {
  const v1 = version(1, { date: "2026-08-24T10:00:00+00:00" });
  const { signals } = detect({ versions: [v1], attempts: [attempt("2026-08-24T10:05:00.000Z")], stall: 1, thrash: 9 });
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.kind, "stall");
  assert.equal(signals[0]?.count, 1);
});

// --------------------------------------------------------------- the thrash

test("consecutive failures with the same signature fire the thrash at exactly K", () => {
  const err = { errors: ["build failed: undefined symbol foo"] };
  for (let n = 1; n <= DEFAULT_THRASH + 1; n++) {
    const attempts = Array.from({ length: n }, (_, i) => failed(`2026-08-24T10:0${i}:00.000Z`, err));
    const { state, signals } = detect({ versions: [version(1)], attempts, stall: 99, thrash: DEFAULT_THRASH });
    assert.equal(state.repeat, n);
    assert.equal(state.failing_streak, n);
    assert.equal(
      signals.some((s) => s.kind === "thrash"),
      n >= DEFAULT_THRASH,
    );
  }
});

test("failures that fail differently are a search, not a thrash", () => {
  const attempts = [
    failed("2026-08-24T10:00:00.000Z", { errors: ["undefined symbol foo"] }),
    failed("2026-08-24T10:01:00.000Z", { errors: ["type error in kernel.ts"] }),
    failed("2026-08-24T10:02:00.000Z", { errors: ["assertion failed: shape mismatch"] }),
  ];
  const { state, signals } = detect({ versions: [version(1)], attempts, stall: 99, thrash: 3 });
  assert.equal(state.failing_streak, 3, "all three failed");
  assert.equal(state.repeat, 1, "but only the last one carries the current signature");
  assert.deepEqual(signals, []);
});

test("a pass breaks the streak even when the same failure returns afterwards", () => {
  const err = { errors: ["undefined symbol foo"] };
  const attempts = [
    failed("2026-08-24T10:00:00.000Z", err),
    failed("2026-08-24T10:01:00.000Z", err),
    attempt("2026-08-24T10:02:00.000Z"),
    failed("2026-08-24T10:03:00.000Z", err),
  ];
  const { state } = detect({ versions: [version(1)], attempts, stall: 99, thrash: 3 });
  assert.equal(state.repeat, 1);
  assert.equal(state.failing_streak, 1);
  assert.equal(state.last_pass, "2026-08-24T10:02:00.000Z");
});

test("the same failure survives the noise that changes between two runs of it", () => {
  // A temp directory, a duration and a commit sha differ on every run. If any of them reached the
  // signature, an agent re-trying the identical broken edit would look like one exploring.
  const a = failureSignature(failed("t", { errors: ["/tmp/avo-a1b2/score: failed after 1.25s at commit deadbeef1234"] }));
  const b = failureSignature(failed("t", { errors: ["/tmp/avo-z9y8/score: failed after 3.10s at commit cafebabe5678"] }));
  assert.equal(a, b);
  assert.notEqual(a, failureSignature(failed("t", { errors: ["/tmp/avo-a1b2/score: a different failure"] })));
});

test("a passing attempt has no failure signature", () => {
  assert.equal(failureSignature(attempt("t")), null);
});

test("a failure with no errors falls back to the scorer's own first log line", () => {
  const sig = failureSignature(failed("t", { log: "\n\n  kernel.cu:42: error: no matching function\nmore noise\n" }));
  assert.equal(sig, "kernel.cu:N: error: no matching function");
});

test("a failure with nothing to say still gets a stable signature", () => {
  assert.equal(failureSignature(failed("t")), "f reported correct: false");
  assert.equal(failureSignature(failed("t", { ok: false })), "f reported ok: false");
});

test("the signature is bounded, so one runaway log line cannot become the comparison key", () => {
  assert.ok(normalizeSignature("x".repeat(5_000)).length <= 200);
});

test("both signals can fire at once and both are reported", () => {
  const err = { errors: ["same failure"] };
  const attempts = Array.from({ length: 5 }, (_, i) => failed(`2026-08-24T10:0${i}:00.000Z`, err));
  const { signals } = detect({ versions: [version(1)], attempts, stall: 5, thrash: 3 });
  assert.deepEqual(
    signals.map((s) => s.kind),
    ["stall", "thrash"],
  );
});

// ------------------------------------------------------------- the citations

test("the directive cites prior versions newest first, with their scores and rationales", () => {
  const versions = [version(1), version(2), version(3), version(4)];
  const cites = citationsFor(versions, [], []);
  assert.deepEqual(
    cites.map((c) => c.ref),
    ["v4", "v3", "v2"],
    "the newest three: the ones an agent is most likely to re-derive",
  );
  assert.match(cites[0]?.text ?? "", /400 tflops/);
  assert.match(cites[0]?.text ?? "", /direction 4/);
  assert.match(cites[0]?.text ?? "", /lineage\/v004\.md/);
});

test("dead ends are cited before general insights", () => {
  const mem = (kind: Memory["kind"], key: string): Memory => ({
    ts: "",
    kind,
    key,
    text: `${key} text`,
    version: null,
    bead: null,
    parent: null,
  });
  const cites = citationsFor([], [mem("insight", "i1"), mem("failure", "f1")], []);
  assert.deepEqual(
    cites.map((c) => c.kind),
    ["failure", "insight"],
  );
});

test("a doc every version already talks about is not offered as unexplored", () => {
  const docs: DocRef[] = [
    { file: "knowledge/warp-specialization.md", title: "Warp specialization and pingpong scheduling", collection: "knowledge" },
    { file: "knowledge/tma-descriptors.md", title: "TMA descriptors", collection: "knowledge" },
  ];
  const corpus = exploredCorpus([version(1, { why: "warp specialization with a pingpong schedule" })], []);
  assert.deepEqual(
    unexplored(docs, corpus).map((d) => d.file),
    ["knowledge/tma-descriptors.md"],
  );
});

test("a doc with no heading is judged by its filename", () => {
  const doc: DocRef = { file: "knowledge/persistent-kernels.md", title: null, collection: "knowledge" };
  assert.equal(isExplored(doc, "we tried persistent kernels already"), true);
  assert.equal(isExplored(doc, "nothing relevant here"), false);
});

test("memory counts as exploration too — a dead end is not an unexplored direction", () => {
  const docs: DocRef[] = [{ file: "knowledge/tma-descriptors.md", title: "TMA descriptors", collection: "knowledge" }];
  const corpus = exploredCorpus([], [
    { ts: "", kind: "failure", key: "tma", text: "TMA descriptors do not help here", version: null, bead: null, parent: null },
  ]);
  assert.deepEqual(unexplored(docs, corpus), []);
});

// -------------------------------------------------------------- the rendering

test("the directive names the signal, the version to beat and a next step that is a command", () => {
  const attempts = Array.from({ length: 5 }, (_, i) => attempt(`2026-08-24T11:0${i}:00.000Z`));
  const { state, signals } = detect({ versions: [version(3)], attempts, ...base });
  const cites = citationsFor([version(3)], [], [{ file: "knowledge/tma.md", title: "TMA", collection: "knowledge" }]);
  const text = renderDirective(state, signals, cites);
  assert.match(text, /STEERING \(avo supervise\)/);
  assert.match(text, /5 attempt\(s\) since v3/);
  assert.match(text, /avo lineage show 3/);
  assert.match(text, /knowledge\/tma\.md/);
  assert.match(text, /avo fan --n 4/, "a stalled agent is told how to explore, not just to explore");
});

test("a thrash directive says to read the failure, not to try harder", () => {
  const err = { errors: ["same failure"] };
  const attempts = Array.from({ length: 3 }, (_, i) => failed(`2026-08-24T11:0${i}:00.000Z`, err));
  const { state, signals } = detect({ versions: [version(1)], attempts, stall: 99, thrash: 3 });
  const text = renderDirective(state, signals, []);
  assert.match(text, /thrash/);
  assert.match(text, /Read the failure before editing again/);
  assert.doesNotMatch(text, /avo fan --n 4/);
});

test("the directive is capped, because it is injected into a prompt", () => {
  const many = Array.from({ length: 200 }, (_, i) =>
    version(i + 1, { why: `direction ${i} `.repeat(300) }),
  );
  const attempts = Array.from({ length: 9 }, (_, i) => attempt(`2026-08-24T12:0${i}:00.000Z`));
  const { state, signals } = detect({ versions: many, attempts, ...base });
  const text = renderDirective(state, signals, citationsFor(many, [], []));
  assert.ok(text.length <= 4_100, `the directive is ${text.length} chars`);
  assert.match(text, /directive truncated/);
});

// ------------------------------------------------------------- the attempt log

test("a repo that never scored has no attempt log and that is not a warning", () => {
  const cwd = mkdtempSync(join(tmpdir(), "avo-sup-"));
  try {
    assert.deepEqual(readAttempts(cwd), { attempts: [], total: 0, warnings: [] });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a truncated line costs that line and nothing else", () => {
  const cwd = mkdtempSync(join(tmpdir(), "avo-sup-"));
  try {
    mkdirSync(join(cwd, ".avo"), { recursive: true });
    const good = JSON.stringify(attempt("2026-08-24T10:00:00.000Z"));
    writeFileSync(join(cwd, ATTEMPTS_PATH), `${good}\n{"ts":"broken"\n{"not":"an attempt"}\n${good}\n`);
    const log = readAttempts(cwd);
    assert.equal(log.attempts.length, 2);
    assert.equal(log.total, 2);
    assert.equal(log.warnings.length, 1);
    assert.match(log.warnings[0] ?? "", /2 unreadable line/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("only the tail is examined, and the report says how much was left out", () => {
  const cwd = mkdtempSync(join(tmpdir(), "avo-sup-"));
  try {
    mkdirSync(join(cwd, ".avo"), { recursive: true });
    const lines = Array.from({ length: ANALYSIS_WINDOW + 5 }, (_, i) =>
      JSON.stringify(attempt(new Date(Date.UTC(2026, 7, 24, 0, 0, i)).toISOString())),
    );
    writeFileSync(join(cwd, ATTEMPTS_PATH), `${lines.join("\n")}\n`);
    const log = readAttempts(cwd);
    assert.equal(log.total, ANALYSIS_WINDOW + 5);
    assert.equal(log.attempts.length, ANALYSIS_WINDOW);
    assert.match(log.warnings.join(" "), new RegExp(`only the last ${ANALYSIS_WINDOW}`));
    // The tail, not the head: the newest attempt has to be the one the detector sees.
    assert.equal(log.attempts[log.attempts.length - 1]?.ts, JSON.parse(lines[lines.length - 1] as string).ts);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- arguments

test("avo supervise takes its thresholds from the config, and a flag beats the config", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "avo-sup-"));
  try {
    mkdirSync(join(cwd, ".avo"), { recursive: true });
    writeFileSync(join(cwd, CONFIG_PATH), JSON.stringify({ supervise: { stall: 2, thrash: 2 } }));
    const runner: Runner = async () => ({ code: 1, stdout: "", stderr: "", timedOut: false, spawnError: null });

    const fromConfig = await supervise({ json: true, cwd, stall: null, thrash: null }, { runner });
    assert.deepEqual(fromConfig.thresholds, { stall: 2, thrash: 2 });

    const fromFlag = await supervise({ json: true, cwd, stall: 7, thrash: null }, { runner });
    assert.deepEqual(fromFlag.thresholds, { stall: 7, thrash: 2 });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a threshold that cannot fire is refused at parse time", () => {
  for (const bad of ["0", "-1", "1.5", "lots"]) {
    assert.ok("error" in parseSuperviseArgs(["--stall", bad]), `--stall ${bad} should be refused`);
  }
  // A "repeat" of one is a single failure, which is not thrash by any reading.
  assert.ok("error" in parseSuperviseArgs(["--thrash", "1"]));
  assert.ok("error" in parseSuperviseArgs(["--stall"]));
  assert.ok("error" in parseSuperviseArgs(["--nope"]));
  const ok = parseSuperviseArgs(["--json", "--stall", "3", "--thrash", "2", "--cwd", "/tmp/x"]);
  assert.deepEqual(ok, { json: true, cwd: "/tmp/x", stall: 3, thrash: 2 });
});

// ----------------------------------------------------------------- the command

/** git says "not a repository"; bd and qmd are absent. The common path for a fresh directory. */
const noTools: Runner = async (cmd: string, _args: readonly string[], _opts: RunOpts): Promise<RunResult> => ({
  code: 128,
  stdout: "",
  stderr: cmd === "git" ? "fatal: not a git repository" : "",
  timedOut: false,
  spawnError: cmd === "git" ? null : "spawn ENOENT",
});

test("no lineage and no attempts exits 0 with nothing to steer", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "avo-sup-"));
  try {
    const io = bufferIo();
    assert.equal(await superviseCommand(["--cwd", cwd], io, noTools), 0);
    assert.match(io.stdout, /no intervention/);
    assert.match(io.stdout, /not a git repository/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a fired signal exits 1 and prints the directive, so a shell loop can branch on it", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "avo-sup-"));
  try {
    mkdirSync(join(cwd, ".avo"), { recursive: true });
    mkdirSync(join(cwd, "knowledge"), { recursive: true });
    writeFileSync(join(cwd, "knowledge/tma-descriptors.md"), "# TMA descriptors\n\nbulk async copy\n");
    const lines = Array.from({ length: 3 }, (_, i) =>
      JSON.stringify(failed(`2026-08-24T10:0${i}:00.000Z`, { errors: ["undefined symbol foo"] })),
    );
    writeFileSync(join(cwd, ATTEMPTS_PATH), `${lines.join("\n")}\n`);

    const io = bufferIo();
    assert.equal(await superviseCommand(["--cwd", cwd, "--stall", "3", "--thrash", "3"], io, noTools), 1);
    assert.match(io.stdout, /STEERING/);
    assert.match(io.stdout, /stall/);
    assert.match(io.stdout, /thrash/);
    assert.match(io.stdout, /knowledge\/tma-descriptors\.md/, "K is cited even with no lineage to compare against");

    const jsonIo = bufferIo();
    assert.equal(await superviseCommand(["--cwd", cwd, "--stall", "3", "--json"], jsonIo, noTools), 1);
    const parsed = JSON.parse(jsonIo.stdout) as { triggered: boolean; directive: string; state: { attempts: number } };
    assert.equal(parsed.triggered, true);
    assert.equal(parsed.state.attempts, 3);
    assert.match(parsed.directive, /STEERING/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("nothing fired means no directive at all — there is nothing to inject", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "avo-sup-"));
  try {
    mkdirSync(join(cwd, ".avo"), { recursive: true });
    writeFileSync(join(cwd, ATTEMPTS_PATH), `${JSON.stringify(attempt("2026-08-24T10:00:00.000Z"))}\n`);
    const io = bufferIo();
    assert.equal(await superviseCommand(["--cwd", cwd, "--json"], io, noTools), 0);
    const parsed = JSON.parse(io.stdout) as { directive: string | null; citations: unknown[] };
    assert.equal(parsed.directive, null);
    assert.deepEqual(parsed.citations, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a bad option is a harness error, not a silent default", async () => {
  const io = bufferIo();
  assert.equal(await superviseCommand(["--stall", "x"], io, noTools), 2);
  assert.match(io.stderr, /--stall/);
});
