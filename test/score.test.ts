import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bufferIo } from "../src/io.ts";
import {
  ATTEMPTS_PATH,
  concurrencyCap,
  initScorer,
  isParseFailure,
  listTemplates,
  mapLimit,
  normalize,
  parseConfigList,
  parseScoreArgs,
  parseScoreOutput,
  renderAttempt,
  scoreCommand,
  SCORER_PATH,
  spawnRunner,
  type Attempt,
  type ParseFailure,
  type ParseSuccess,
  type RunResult,
  type Runner,
} from "../src/score.ts";

const GOOD = { ok: true, correct: true, primary: 12.5, unit: "TFLOPS", higher_is_better: true };
const line = (o: unknown) => `${JSON.stringify(o)}\n`;

function ok(r: ParseSuccess | ParseFailure): ParseSuccess {
  assert.ok(!isParseFailure(r), `expected success, got ${JSON.stringify(r)}`);
  return r;
}
function bad(r: ParseSuccess | ParseFailure): ParseFailure {
  assert.ok(isParseFailure(r), `expected failure, got ${JSON.stringify(r)}`);
  return r;
}

// ---------------------------------------------------------------- validation

test("a minimal valid scorer line parses with no warnings", () => {
  const r = ok(parseScoreOutput(line(GOOD)));
  assert.equal(r.output.primary, 12.5);
  assert.deepEqual(r.warnings, []);
});

test("every missing required field is named in the error", () => {
  for (const field of ["ok", "correct", "primary", "unit", "higher_is_better"]) {
    const partial: Record<string, unknown> = { ...GOOD };
    delete partial[field];
    const r = bad(parseScoreOutput(line(partial)));
    assert.ok(
      r.errors.some((e) => e.includes(`field '${field}'`)),
      `${field}: not named in ${JSON.stringify(r.errors)}`,
    );
  }
});

test("a wrong type names the field, the expectation, and the value received", () => {
  const r = bad(parseScoreOutput(line({ ...GOOD, primary: "fast" })));
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0] ?? "", /field 'primary'/);
  assert.match(r.errors[0] ?? "", /expected/i);
  assert.match(r.errors[0] ?? "", /"fast"/);
});

test("a misspelled required key is diagnosed as both missing and unknown", () => {
  const { higher_is_better: _drop, ...rest } = GOOD;
  const r = bad(parseScoreOutput(line({ ...rest, higherIsBetter: true })));
  assert.ok(r.errors.some((e) => e.includes("field 'higher_is_better'")));
  // The unknown-key warning only surfaces once the schema passes, so check it separately.
  const r2 = ok(parseScoreOutput(line({ ...GOOD, higherIsBetter: true })));
  assert.deepEqual(r2.warnings, ["unknown field 'higherIsBetter' ignored"]);
});

test("an empty unit is rejected", () => {
  const r = bad(parseScoreOutput(line({ ...GOOD, unit: "" })));
  assert.match(r.errors[0] ?? "", /field 'unit'/);
});

test("a nested bad score names the config that broke", () => {
  const r = bad(parseScoreOutput(line({ ...GOOD, scores: { b1: 1, b2: "x" } })));
  assert.match(r.errors[0] ?? "", /field 'scores\.b2'/);
});

test("non-finite numbers are rejected even though JSON accepts 1e999", () => {
  assert.match(bad(parseScoreOutput(line({ ...GOOD, scores: { b1: 1e999 } }))).errors[0] ?? "", /scores\.b1/);
  assert.match(bad(parseScoreOutput(line({ ...GOOD, primary: 1e999 }))).errors[0] ?? "", /field 'primary'/);
});

test("primary may be null only when the candidate is not passing", () => {
  ok(parseScoreOutput(line({ ...GOOD, correct: false, primary: null })));
  ok(parseScoreOutput(line({ ...GOOD, ok: false, primary: null })));
  const r = bad(parseScoreOutput(line({ ...GOOD, primary: null })));
  assert.match(r.errors[0] ?? "", /field 'primary'.*finite/);
});

test("empty and non-JSON stdout produce actionable errors, not a crash", () => {
  assert.match(bad(parseScoreOutput("")).errors[0] ?? "", /printed nothing/);
  assert.match(bad(parseScoreOutput("   \n\n")).errors[0] ?? "", /printed nothing/);
  assert.match(bad(parseScoreOutput("Segmentation fault\n")).errors[0] ?? "", /not a JSON object/);
  // A JSON array is not an object.
  assert.match(bad(parseScoreOutput("[1,2]\n")).errors[0] ?? "", /not a JSON object/);
});

test("build noise before the JSON line is tolerated but warned about", () => {
  const r = ok(parseScoreOutput(`compiling…\nlinking\n${JSON.stringify(GOOD)}\n`));
  assert.equal(r.output.primary, 12.5);
  assert.match(r.warnings[0] ?? "", /3 non-empty stdout lines; used line 3/);
});

// ------------------------------------------------------------ config listing

test("parseConfigList accepts plain tokens, dedupes, and rejects anything else", () => {
  assert.deepEqual(parseConfigList("b1_s4096\nb8_s1024\n"), ["b1_s4096", "b8_s1024"]);
  assert.deepEqual(parseConfigList(" a \n a \n"), ["a"]);
  assert.equal(parseConfigList(""), null);
  assert.equal(parseConfigList("\n \n"), null);
  // A scorer with no --configs support prints its normal result line instead.
  assert.equal(parseConfigList(JSON.stringify(GOOD)), null);
  assert.equal(parseConfigList("has space\n"), null);
});

// -------------------------------------------------------------- normalization

const META = { ts: "2026-08-24T00:00:00.000Z", parallel: false, exitCode: 0, git: { head: null, dirty: false }, durationS: 1 };
const part = (config: string, o: unknown) => ({ config, result: parseScoreOutput(line(o)) });

test("a passing single run normalizes to pass with normalized == primary", () => {
  const a = normalize([part("*", GOOD)], META);
  assert.equal(a.pass, true);
  assert.equal(a.primary, 12.5);
  assert.equal(a.normalized, 12.5);
  assert.deepEqual(a.errors, []);
});

test("lower-is-better flips normalized so higher is always better", () => {
  const a = normalize([part("*", { ...GOOD, primary: 2.5, higher_is_better: false, unit: "s" })], META);
  assert.equal(a.primary, 2.5);
  assert.equal(a.normalized, -2.5);
});

test("a failing candidate gets the null sentinel regardless of the measured value", () => {
  for (const failing of [{ correct: false }, { ok: false }]) {
    const a = normalize([part("*", { ...GOOD, ...failing, primary: 9999 })], META);
    assert.equal(a.pass, false);
    assert.equal(a.primary, null, JSON.stringify(failing));
    assert.equal(a.normalized, null);
    // The direction and unit survive, so a consumer can still render the attempt.
    assert.equal(a.unit, "TFLOPS");
  }
});

test("harness errors make the attempt not-ok and carry the diagnosis", () => {
  const a = normalize([{ config: "*", result: { errors: ["boom"] } }], META);
  assert.equal(a.ok, false);
  assert.equal(a.pass, false);
  assert.deepEqual(a.errors, ["boom"]);
  assert.equal(a.primary, null);
});

test("across configs, scores merge and primary is their mean", () => {
  const a = normalize(
    [part("b1", { ...GOOD, primary: 10 }), part("b2", { ...GOOD, primary: 20 })],
    { ...META, parallel: true },
  );
  assert.deepEqual(a.scores, { b1: 10, b2: 20 });
  assert.equal(a.primary, 15);
  assert.deepEqual(a.configs, ["b1", "b2"]);
  assert.equal(a.parallel, true);
});

test("a scorer's own scores map wins over the per-config fallback", () => {
  const a = normalize([part("b1", { ...GOOD, scores: { inner: 3 } })], META);
  assert.deepEqual(a.scores, { inner: 3 });
});

test("one failing config fails the whole attempt", () => {
  const a = normalize([part("b1", GOOD), part("b2", { ...GOOD, correct: false, primary: null })], META);
  assert.equal(a.correct, false);
  assert.equal(a.pass, false);
  assert.equal(a.primary, null);
});

test("a single scorer's self-reported duration is preferred over our wall clock", () => {
  assert.equal(normalize([part("*", { ...GOOD, duration_s: 42.1 })], META).duration_s, 42.1);
  assert.equal(normalize([part("*", GOOD)], META).duration_s, 1);
  const many = normalize([part("b1", { ...GOOD, duration_s: 40 }), part("b2", { ...GOOD, duration_s: 40 })], META);
  assert.equal(many.duration_s, 1, "across configs only the wall clock describes the fan-out");
});

test("renderAttempt shows the direction, the sentinel, and the verdict", () => {
  const passing = renderAttempt(normalize([part("*", GOOD)], META));
  assert.match(passing, /higher is better/);
  assert.match(passing, /\npass\n/);
  const failing = renderAttempt(normalize([part("*", { ...GOOD, correct: false, primary: null })], META));
  assert.match(failing, /failing sentinel/);
  assert.match(failing, /\nfail\n/);
  const broken = renderAttempt(normalize([{ config: "*", result: { errors: ["nope"] } }], META));
  assert.match(broken, /error: nope/);
});

// -------------------------------------------------------------- concurrency

test("mapLimit preserves order and never exceeds the limit", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.ok(peak <= 3, `peak concurrency was ${peak}`);
  assert.ok(peak > 1, "nothing ran concurrently");
  assert.ok(concurrencyCap() >= 1);
});

// ---------------------------------------------------------------- arg parsing

test("parseScoreArgs handles flags, values, and rejects the rest", () => {
  const o = parseScoreArgs(["--json", "--parallel", "--timeout", "30", "--cwd", "/tmp", "--no-record"]);
  assert.ok(!("error" in o));
  assert.deepEqual(
    { json: o.json, parallel: o.parallel, timeoutS: o.timeoutS, cwd: o.cwd, record: o.record },
    { json: true, parallel: true, timeoutS: 30, cwd: "/tmp", record: false },
  );
  for (const argv of [["--nope"], ["--timeout"], ["--timeout", "-4"], ["--timeout", "abc"], ["--init"]]) {
    assert.ok("error" in parseScoreArgs(argv), `${argv.join(" ")} should be rejected`);
  }
});

// -------------------------------------------------------------------- --init

test("every shipped template is listed and scaffolds idempotently", () => {
  const templates = listTemplates();
  assert.deepEqual(templates, ["hyperfine", "pytest", "vitest"]);

  const dir = mkdtempSync(join(tmpdir(), "avo-init-"));
  try {
    const first = initScorer(dir, "hyperfine", false);
    assert.deepEqual({ ok: first.ok, action: first.action }, { ok: true, action: "created" });
    const body = readFileSync(join(dir, SCORER_PATH), "utf8");
    assert.match(body, /^#!\/usr\/bin\/env bash/);

    // Re-running is a no-op, not a duplicate or a rewrite (invariant 5).
    assert.deepEqual(initScorer(dir, "hyperfine", false).action, "unchanged");

    // A hand-edited scorer is never clobbered silently.
    writeFileSync(join(dir, SCORER_PATH), `${body}\n# my edit\n`);
    const refused = initScorer(dir, "hyperfine", false);
    assert.equal(refused.ok, false);
    assert.match(refused.error ?? "", /--force/);
    assert.equal(initScorer(dir, "hyperfine", true).action, "overwritten");

    const unknown = initScorer(dir, "nope", false);
    assert.equal(unknown.ok, false);
    assert.match(unknown.error ?? "", /unknown template 'nope'; available: hyperfine, pytest, vitest/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- scoreCommand

const R = (r: Partial<RunResult>): RunResult => ({
  code: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  spawnError: null,
  ...r,
});

interface Fake {
  runner: Runner;
  calls: { cmd: string; args: string[] }[];
}

/** A runner that answers scorer invocations from `score` and stubs git out. */
function fake(score: (args: readonly string[]) => Partial<RunResult>): Fake {
  const calls: { cmd: string; args: string[] }[] = [];
  const runner: Runner = (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    if (cmd === "git") {
      return Promise.resolve(R(args[0] === "rev-parse" ? { stdout: "deadbeef\n" } : { stdout: " M src/x.ts\n" }));
    }
    return Promise.resolve(R(score(args)));
  };
  return { runner, calls };
}

/** A temp repo with an executable stub scorer; the fake runner supplies its behavior. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "avo-score-"));
  mkdirSync(join(dir, ".avo"), { recursive: true });
  writeFileSync(join(dir, SCORER_PATH), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return dir;
}

const attemptsOf = (dir: string): Attempt[] =>
  readFileSync(join(dir, ATTEMPTS_PATH), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Attempt);

test("a passing scorer exits 0, emits one JSON line, and records the attempt", async () => {
  const dir = repo();
  try {
    const io = bufferIo();
    const f = fake(() => ({ stdout: line({ ...GOOD, duration_s: 3 }) }));
    assert.equal(await scoreCommand(["--json", "--cwd", dir], io, f.runner), 0);
    assert.equal(io.stdout.trimEnd().split("\n").length, 1);
    const a = JSON.parse(io.stdout) as Attempt;
    assert.equal(a.pass, true);
    assert.equal(a.normalized, 12.5);
    assert.deepEqual(a.git, { head: "deadbeef", dirty: true });
    assert.deepEqual(attemptsOf(dir), [a]);
    // The scorer is invoked with no arguments when not fanning out.
    assert.deepEqual(f.calls[0], { cmd: join(dir, SCORER_PATH), args: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing candidate exits 1 — a result, not an error", async () => {
  const dir = repo();
  try {
    const io = bufferIo();
    const f = fake(() => ({ stdout: line({ ...GOOD, correct: false, primary: null, log: "test_matmul failed" }) }));
    assert.equal(await scoreCommand(["--json", "--cwd", dir], io, f.runner), 1);
    const a = JSON.parse(io.stdout) as Attempt;
    assert.equal(a.correct, false);
    assert.equal(a.primary, null);
    assert.equal(a.log, "test_matmul failed");
    assert.deepEqual(a.errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed scorer output exits 2, names the field, and keeps the raw output for diagnosis", async () => {
  const dir = repo();
  try {
    const io = bufferIo();
    const f = fake(() => ({ code: 1, stdout: "boom: no such file\n" }));
    assert.equal(await scoreCommand(["--json", "--cwd", dir], io, f.runner), 2);
    const a = JSON.parse(io.stdout) as Attempt;
    assert.equal(a.ok, false);
    assert.match(a.errors[0] ?? "", /not a JSON object.*it also exited 1/s);
    assert.match(a.log ?? "", /boom: no such file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a timeout is reported as a harness error, not a hang", async () => {
  const dir = repo();
  try {
    const io = bufferIo();
    const f = fake(() => ({ timedOut: true, code: -1 }));
    assert.equal(await scoreCommand(["--json", "--cwd", dir], io, f.runner, () => new Date(0)), 2);
    assert.match((JSON.parse(io.stdout) as Attempt).errors[0] ?? "", /exceeded the timeout/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a scorer that cannot be executed is reported, not thrown", async () => {
  const dir = repo();
  try {
    const io = bufferIo();
    const f = fake(() => ({ spawnError: "EACCES", code: -1 }));
    assert.equal(await scoreCommand(["--json", "--cwd", dir], io, f.runner), 2);
    assert.match((JSON.parse(io.stdout) as Attempt).errors[0] ?? "", /could not execute .*EACCES/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--parallel discovers configs and scores each one", async () => {
  const dir = repo();
  try {
    const io = bufferIo();
    const f = fake((args) => {
      if (args[0] === "--configs") return { stdout: "b1\nb2\nb3\n" };
      const primary = { b1: 10, b2: 20, b3: 30 }[args[1] ?? ""] ?? 0;
      return { stdout: line({ ...GOOD, primary }) };
    });
    assert.equal(await scoreCommand(["--json", "--parallel", "--cwd", dir], io, f.runner), 0);
    const a = JSON.parse(io.stdout) as Attempt;
    assert.equal(a.parallel, true);
    assert.deepEqual(a.scores, { b1: 10, b2: 20, b3: 30 });
    assert.equal(a.primary, 20);
    assert.deepEqual(a.warnings, []);
    const scorer = join(dir, SCORER_PATH);
    assert.deepEqual(
      f.calls.filter((c) => c.cmd === scorer).map((c) => c.args),
      [["--configs"], ["--config", "b1"], ["--config", "b2"], ["--config", "b3"]],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--parallel degrades to a serial run with one warning when --configs is unsupported", async () => {
  const dir = repo();
  try {
    const io = bufferIo();
    const f = fake((args) => (args[0] === "--configs" ? { code: 2, stderr: "usage\n" } : { stdout: line(GOOD) }));
    assert.equal(await scoreCommand(["--json", "--parallel", "--cwd", dir], io, f.runner), 0);
    const a = JSON.parse(io.stdout) as Attempt;
    assert.equal(a.parallel, false);
    assert.deepEqual(a.configs, ["*"]);
    assert.match(a.warnings[0] ?? "", /--parallel requested but .* listed no usable config names/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attempts accumulate append-only, and --no-record writes nothing", async () => {
  const dir = repo();
  try {
    const f = fake(() => ({ stdout: line(GOOD) }));
    await scoreCommand(["--json", "--cwd", dir], bufferIo(), f.runner, () => new Date(1));
    await scoreCommand(["--json", "--cwd", dir], bufferIo(), f.runner, () => new Date(2));
    assert.equal(attemptsOf(dir).length, 2);
    await scoreCommand(["--json", "--cwd", dir, "--no-record"], bufferIo(), f.runner);
    assert.equal(attemptsOf(dir).length, 2, "--no-record still appended");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing or non-executable scorer exits 2 and says how to fix it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "avo-noscore-"));
  try {
    const io = bufferIo();
    const f = fake(() => ({}));
    assert.equal(await scoreCommand(["--cwd", dir], io, f.runner), 2);
    assert.match(io.stderr, /no executable \.avo\/score/);
    assert.match(io.stderr, /avo score --init <hyperfine\|pytest\|vitest>/);
    assert.equal(f.calls.length, 0, "the scorer must not be invoked when it is missing");

    // Present but not executable is the same class of error, with the chmod hint.
    mkdirSync(join(dir, ".avo"), { recursive: true });
    writeFileSync(join(dir, SCORER_PATH), "#!/bin/sh\n", { mode: 0o644 });
    chmodSync(join(dir, SCORER_PATH), 0o644);
    const io2 = bufferIo();
    assert.equal(await scoreCommand(["--json", "--cwd", dir], io2, f.runner), 2);
    const payload = JSON.parse(io2.stdout) as { ok: boolean; errors: string[] };
    assert.equal(payload.ok, false);
    assert.match(payload.errors[0] ?? "", /chmod \+x/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--init is reachable through scoreCommand and speaks --json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "avo-initcmd-"));
  try {
    const io = bufferIo();
    assert.equal(await scoreCommand(["--init", "vitest", "--cwd", dir, "--json"], io, fake(() => ({})).runner), 0);
    assert.deepEqual(JSON.parse(io.stdout), {
      ok: true,
      action: "created",
      template: "vitest",
      path: SCORER_PATH,
    });
    const io2 = bufferIo();
    assert.equal(await scoreCommand(["--init", "nope", "--cwd", dir], io2, fake(() => ({})).runner), 2);
    assert.match(io2.stderr, /unknown template/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the pretty renderer is used without --json", async () => {
  const dir = repo();
  try {
    const io = bufferIo();
    assert.equal(await scoreCommand(["--cwd", dir], io, fake(() => ({ stdout: line(GOOD) })).runner), 0);
    assert.match(io.stdout, /^avo score\n/);
    assert.match(io.stdout, /primary\s+12\.5 TFLOPS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- spawnRunner

test("spawnRunner captures stdout, stderr, and the exit code of a real process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "avo-spawn-"));
  try {
    const script = join(dir, "s.sh");
    writeFileSync(script, "#!/bin/sh\necho out\necho err >&2\nexit 7\n", { mode: 0o755 });
    const r = await spawnRunner(script, [], { cwd: dir, timeoutMs: 0 });
    assert.deepEqual(
      { code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut },
      { code: 7, stdout: "out\n", stderr: "err\n", timedOut: false },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a timeout kills the scorer's whole process group, not just the scorer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "avo-timeout-"));
  try {
    // The hazard: a scorer that backgrounds a benchmark. Killing only the scorer leaves the child
    // holding our stdio pipes, so we would block until the benchmark finished anyway.
    const script = join(dir, "s.sh");
    writeFileSync(script, "#!/bin/sh\nsleep 30 &\necho started\nwait\n", { mode: 0o755 });
    const started = Date.now();
    const r = await spawnRunner(script, [], { cwd: dir, timeoutMs: 300 });
    const elapsed = Date.now() - started;
    assert.equal(r.timedOut, true);
    assert.ok(elapsed < 5_000, `waited ${elapsed}ms for a 300ms timeout — the process group survived`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnRunner reports a missing binary as a spawn error instead of throwing", async () => {
  const r = await spawnRunner("/nonexistent/avo-scorer", [], { cwd: tmpdir(), timeoutMs: 0 });
  assert.ok(r.spawnError !== null);
  assert.match(r.spawnError, /ENOENT/);
});

test("spawnRunner sets PWD as well as cwd, so a child that trusts $PWD acts on the right repo", async () => {
  // qmd resolves its project root from $PWD, and `spawn` sets only the real working directory. Left
  // unset, `avo know init --cwd <other-repo>` wrote a qmd index into *avo's own* repo (S4).
  const dir = mkdtempSync(join(tmpdir(), "avo-pwd-"));
  try {
    const script = join(dir, "echo-pwd.sh");
    writeFileSync(script, '#!/bin/sh\nprintf "%s\\n%s\\n" "$PWD" "$(pwd -P)"\n', { mode: 0o755 });
    const r = await spawnRunner(script, [], { cwd: dir, timeoutMs: 10_000 });
    const [pwdVar, realCwd] = r.stdout.trim().split("\n");
    assert.equal(realpathSync(pwdVar ?? ""), realpathSync(dir), "$PWD is the target directory");
    assert.equal(realpathSync(realCwd ?? ""), realpathSync(dir), "and it agrees with the real cwd");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("declared configs skip the --configs probe entirely (issue #4)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "avo-cfg-"));
  mkdirSync(join(dir, ".avo"), { recursive: true });
  writeFileSync(join(dir, ".avo/score"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(dir, ".avo/config.json"), JSON.stringify({ configs: ["b1", "b8"] }));

  const calls: string[][] = [];
  const runner: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const config = args[1] ?? "?";
    return {
      code: 0,
      stdout: line({ ...GOOD, primary: 1, scores: { [config]: 1 } }),
      stderr: "",
      timedOut: false,
      spawnError: null,
    };
  };
  const io = bufferIo();
  await scoreCommand(["--cwd", dir, "--parallel", "--json", "--no-record"], io, runner);

  const scorerCalls = calls.filter((c) => c[0]?.endsWith(SCORER_PATH));
  assert.deepEqual(
    scorerCalls.map((c) => c.slice(1)),
    [
      ["--config", "b1"],
      ["--config", "b8"],
    ],
  );
  const attempt = JSON.parse(io.stdout) as Attempt;
  assert.deepEqual(attempt.configs, ["b1", "b8"]);
  rmSync(dir, { recursive: true, force: true });
});

test("with no declared configs the probe still runs, and its failure degrades to one serial pass", async () => {
  const dir = mkdtempSync(join(tmpdir(), "avo-cfg2-"));
  mkdirSync(join(dir, ".avo"), { recursive: true });
  writeFileSync(join(dir, ".avo/score"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const calls: string[][] = [];
  const runner: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const probing = args[0] === "--configs";
    return {
      code: 0,
      stdout: probing ? "usage: score [--config name]\n" : line(GOOD),
      stderr: "",
      timedOut: false,
      spawnError: null,
    };
  };
  const io = bufferIo();
  await scoreCommand(["--cwd", dir, "--parallel", "--json", "--no-record"], io, runner);
  assert.ok(calls.some((c) => c[1] === "--configs"));
  const attempt = JSON.parse(io.stdout) as Attempt;
  assert.deepEqual(attempt.configs, ["*"]);
  assert.match(attempt.warnings.join("\n"), /skip this probe/);
  rmSync(dir, { recursive: true, force: true });
});
