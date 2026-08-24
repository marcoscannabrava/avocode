import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { bufferIo } from "../src/io.ts";
import {
  CHAIN_ENV,
  DEFAULT_N,
  DEFAULT_TIMEOUT_S,
  DEPTH_ENV,
  LEVEL_ENV,
  MANIFEST_NAME,
  WORKTREES_DIR,
  bestProbe,
  capOutput,
  checkGuards,
  fanCommand,
  firstOnPath,
  listRuns,
  makeRunId,
  parseFanArgs,
  probeEnv,
  promptSha,
  readManifest,
  type FanResult,
  type ProbeResult,
} from "../src/fan.ts";

// ------------------------------------------------------------------ arguments

test("avo fan defaults to three probes and a bounded timeout", () => {
  const o = parseFanArgs(["--prompt", "go"], {});
  assert.ok(!("error" in o));
  assert.equal(o.n, DEFAULT_N);
  assert.equal(o.timeoutS, DEFAULT_TIMEOUT_S);
  assert.equal(o.mode, "run");
  assert.equal(o.score, true);
});

test("the probe model and agent come from the environment when not given", () => {
  const o = parseFanArgs(["--prompt", "go"], { AVO_PROBE_MODEL: "groq/llama", AVO_AGENT: "pi" });
  assert.ok(!("error" in o));
  assert.equal(o.model, "groq/llama");
  assert.equal(o.agent, "pi");
});

test("an explicit flag beats the environment", () => {
  const o = parseFanArgs(["--prompt", "go", "--model", "haiku"], { AVO_PROBE_MODEL: "groq/llama" });
  assert.ok(!("error" in o) && o.model === "haiku");
});

test("a fan-out with no task is refused before anything is created", () => {
  const o = parseFanArgs([], {});
  assert.ok("error" in o);
  assert.match(o.error, /--prompt-file|--prompt/);
});

test("--prompt and --prompt-file are alternatives", () => {
  const o = parseFanArgs(["--prompt", "a", "--prompt-file", "b"], {});
  assert.ok("error" in o && /alternatives/.test(o.error));
});

test("--n must be a positive integer", () => {
  for (const bad of ["0", "-1", "2.5", "many"]) {
    const o = parseFanArgs(["--prompt", "p", "--n", bad], {});
    assert.ok("error" in o, `--n ${bad} should be refused`);
  }
  const ok = parseFanArgs(["--prompt", "p", "-n", "8"], {});
  assert.ok(!("error" in ok) && ok.n === 8);
});

test("two modes at once is a usage error, not a silent precedence rule", () => {
  const o = parseFanArgs(["--promote", "1", "--resume", "r"], {});
  assert.ok("error" in o && /cannot be combined/.test(o.error));
});

test("--promote takes a 1-based probe number", () => {
  assert.ok("error" in parseFanArgs(["--promote", "0"], {}));
  assert.ok("error" in parseFanArgs(["--promote", "first"], {}));
  const o = parseFanArgs(["--promote", "2"], {});
  assert.ok(!("error" in o) && o.mode === "promote" && o.target === "2");
});

test("a flag with no value is named rather than silently swallowing the next one", () => {
  const o = parseFanArgs(["--prompt"], {});
  assert.ok("error" in o && /--prompt needs a value/.test(o.error));
});

// --------------------------------------------------------------------- guards

const SHA = promptSha("explore register pressure");

test("the default depth allows three levels of nesting", () => {
  for (const level of [0, 1, 2]) {
    const g = checkGuards({ [LEVEL_ENV]: String(level) }, SHA);
    assert.ok(g.ok, `level ${level} should be allowed under the default depth of 3`);
  }
});

test("a probe at the depth limit must do the work itself", () => {
  const g = checkGuards({ [LEVEL_ENV]: "3" }, SHA);
  assert.ok(!g.ok);
  assert.match(g.error, /depth limit/);
  assert.match(g.error, new RegExp(DEPTH_ENV));
});

test("AVO_FAN_DEPTH=0 disables fanning out entirely", () => {
  assert.equal(checkGuards({ [DEPTH_ENV]: "0" }, SHA).ok, false);
});

test("the same prompt already in the chain is a cycle", () => {
  const g = checkGuards({ [CHAIN_ENV]: `abc,${SHA},def` }, SHA);
  assert.ok(!g.ok && /cycle/.test(g.error));
});

test("a different prompt in the chain is not a cycle", () => {
  assert.equal(checkGuards({ [CHAIN_ENV]: "abc,def" }, SHA).ok, true);
});

test("a nonsense depth warns and falls back rather than disabling the guard", () => {
  const g = checkGuards({ [DEPTH_ENV]: "lots" }, SHA);
  assert.ok(g.ok);
  assert.match(g.warnings.join(" "), /not a non-negative integer/);
  assert.equal(g.maxDepth, 3);
});

test("the environment a probe inherits is one level deeper, with this prompt on the chain", () => {
  const g = checkGuards({ [LEVEL_ENV]: "1", [CHAIN_ENV]: "abc" }, SHA);
  assert.ok(g.ok);
  const env = probeEnv(g, SHA, "run-1", 2);
  assert.equal(env[LEVEL_ENV], "2");
  assert.equal(env[CHAIN_ENV], `abc,${SHA}`);
  assert.equal(env[DEPTH_ENV], "3");
});

test("the guard state round-trips: a child of a child is refused at the third hop", () => {
  let env: Record<string, string> = {};
  const prompts = ["a", "b", "c", "d"];
  for (const [i, p] of prompts.entries()) {
    const g = checkGuards(env, promptSha(p));
    if (i < 3) {
      assert.ok(g.ok, `hop ${i} should be allowed`);
      env = probeEnv(g, promptSha(p), "r", 1);
    } else {
      assert.ok(!g.ok, "the fourth hop is three levels deep and must be refused");
    }
  }
});

// ------------------------------------------------------------------- plumbing

test("output is capped by lines and by bytes, and says which happened", () => {
  assert.deepEqual(capOutput("a\nb\nc", 100, 100), { text: "a\nb\nc", truncated: false });
  assert.deepEqual(capOutput("a\nb\nc", 100, 2), { text: "a\nb", truncated: true });
  assert.deepEqual(capOutput("abcdef", 3, 100), { text: "abc", truncated: true });
});

const probe = (i: number, pass: boolean, normalized: number | null): ProbeResult => ({
  i,
  ok: true,
  score:
    normalized === null
      ? null
      : { pass, primary: normalized, normalized, unit: "x", higher_is_better: true, scores: {}, errors: [] },
  diffstat: { files: 1, insertions: 1, deletions: 0, changed: ["a"] },
  summary: null,
  worktree: `${WORKTREES_DIR}/r/${i}`,
  tokens: null,
  wall_s: 1,
  exit_code: 0,
  timed_out: false,
  log_path: "l",
  truncated: false,
  error: null,
});

test("the best probe is the highest-scoring one that actually passed f", () => {
  assert.equal(bestProbe([probe(1, true, 5), probe(2, true, 9), probe(3, true, 7)]), 2);
  // A failing candidate with a huge number is not a winner; correctness gates everything.
  assert.equal(bestProbe([probe(1, true, 5), probe(2, false, 99)]), 1);
  assert.equal(bestProbe([probe(1, false, 99), probe(2, true, null)]), null);
  assert.equal(bestProbe([]), null);
});

test("a run id is sortable and derived from the prompt", () => {
  const id = makeRunId(new Date("2026-08-24T14:58:46.000Z"), "abcdef123456");
  assert.equal(id, "20260824T145846Z-abcdef");
});

test("firstOnPath only accepts an executable", () => {
  const dir = mkdtempSync(join(tmpdir(), "avo-path-"));
  writeFileSync(join(dir, "claude"), "#!/bin/sh\n", { mode: 0o644 });
  writeFileSync(join(dir, "codex"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(firstOnPath({ PATH: dir }, ["pi", "claude", "codex"]), "codex");
  assert.equal(firstOnPath({ PATH: "" }, ["codex"]), null);
  rmSync(dir, { recursive: true, force: true });
});

// -------------------------------------------------------------- config: agents

test("a custom agent shadowing a built-in name is refused, not merged", () => {
  const dir = mkdtempSync(join(tmpdir(), "avo-cfg-"));
  mkdirSync(join(dir, ".avo"));
  writeFileSync(
    join(dir, ".avo/config.json"),
    JSON.stringify({ agent: { name: "claude", command: "x", args: ["{prompt}"] } }),
  );
  const c = loadConfig(dir);
  assert.equal(c.config.agent, null);
  assert.match(c.warnings.join(" "), /may not shadow a built-in/);
  rmSync(dir, { recursive: true, force: true });
});

test("a custom agent whose args never mention {prompt} would get no task", () => {
  const dir = mkdtempSync(join(tmpdir(), "avo-cfg2-"));
  mkdirSync(join(dir, ".avo"));
  writeFileSync(join(dir, ".avo/config.json"), JSON.stringify({ agent: { name: "s", command: "x", args: ["-q"] } }));
  const c = loadConfig(dir);
  assert.equal(c.config.agent, null);
  assert.match(c.warnings.join(" "), /never mentions \{prompt\}/);
  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- integration
// Real git, real worktrees, a real child process — but a stub agent, never a real one. CI has no
// agent CLI and a real one would make the suite non-deterministic and expensive (PLAN §4, S6).

const STUB = `#!/usr/bin/env bash
# A stand-in for a headless coding agent: it edits a file and exits, which is all avo fan needs it
# to do. Its behaviour is chosen by the prompt so one stub covers every case.
prompt="$1"
case "$prompt" in
  *noop*)  echo "I considered it and changed nothing"; exit 0 ;;
  *slow*)  sleep 60; exit 0 ;;
  *crash*) echo "boom" >&2; exit 3 ;;
esac
# The probe index proves the guard environment reached the child, and makes each probe's diff — and
# so its score — different, which is what lets a test assert on 'best'.
for ((k = 0; k < \${AVO_FAN_PROBE:-1}; k++)); do echo "probe \${AVO_FAN_PROBE} line $k" >> kernel.txt; done
echo "appended \${AVO_FAN_PROBE} line(s) at depth \${AVO_FAN_LEVEL}"
`;

const SCORER = `#!/usr/bin/env bash
n=$(wc -l < kernel.txt | tr -d ' ')
printf '{"ok":true,"correct":true,"primary":%s,"unit":"lines","higher_is_better":true}\\n' "$n"
`;

interface Fixture {
  dir: string;
  git: (...args: string[]) => string;
  worktrees: () => number;
}

function fixture(name: string, opts: { scorer?: boolean } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), `avo-${name}-`));
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "avo@example.com");
  git("config", "user.name", "avo");
  mkdirSync(join(dir, ".avo"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ".avo/worktrees/\n.avo/attempts.jsonl\n");
  writeFileSync(join(dir, "kernel.txt"), "baseline\n");
  writeFileSync(join(dir, "stub.sh"), STUB, { mode: 0o755 });
  if (opts.scorer !== false) writeFileSync(join(dir, ".avo/score"), SCORER, { mode: 0o755 });
  writeFileSync(
    join(dir, ".avo/config.json"),
    JSON.stringify({ agent: { name: "stub", command: join(dir, "stub.sh"), args: ["{prompt}"], format: "text" } }),
  );
  git("add", "-A");
  git("commit", "-qm", "baseline");
  return {
    dir,
    git,
    worktrees: () => git("worktree", "list").trim().split("\n").length,
  };
}

async function fan(f: Fixture, argv: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; json: FanResult }> {
  const io = bufferIo();
  const code = await fanCommand([...argv, "--json", "--cwd", f.dir], io, undefined, undefined, {
    ...process.env,
    ...env,
  });
  return { code, json: JSON.parse(io.stdout) as FanResult };
}

test("three probes run in parallel worktrees, each scored and diffed", async () => {
  const f = fixture("fan3");
  const { code, json } = await fan(f, ["--prompt", "vary the kernel", "--n", "3"]);
  assert.equal(code, 0);
  assert.equal(json.results.length, 3);
  assert.equal(f.worktrees(), 4, "one worktree per probe, plus the repo itself");

  for (const r of json.results) {
    assert.equal(r.ok, true, `probe ${r.i}: ${r.error}`);
    assert.equal(r.diffstat.files, 1);
    assert.deepEqual(r.diffstat.changed, ["kernel.txt"]);
    assert.equal(r.diffstat.insertions, r.i, "each probe appends as many lines as its index");
    assert.equal(r.score?.pass, true);
    assert.equal(r.score?.primary, 1 + r.i);
    // The guard environment reached the agent process, which is what makes nesting bounded at all.
    assert.match(r.summary ?? "", new RegExp(`appended ${r.i} line\\(s\\) at depth 1`));
  }
  // Higher is better here, so the probe that changed the most wins. avo reports it; it decides nothing.
  assert.equal(json.best, 3);
  assert.equal(json.kept.length, 3);
  assert.equal(json.removed.length, 0);

  const m = readManifest(f.dir, json.run_id);
  assert.ok(!("error" in m));
  assert.equal(m.probes.filter((p) => p.status === "done").length, 3);
  assert.equal(m.baseline, f.git("rev-parse", "HEAD").trim());
  assert.ok(m.finished_at !== null);

  // The full agent output is on disk even though the summary is what came back.
  assert.match(readFileSync(join(f.dir, json.results[0]?.log_path ?? ""), "utf8"), /appended 1 line/);

  rmSync(f.dir, { recursive: true, force: true });
});

test("a worktree nothing changed is removed; git worktree list returns to baseline", async () => {
  const f = fixture("fannoop");
  const before = f.worktrees();
  const { json } = await fan(f, ["--prompt", "noop please", "--n", "2"]);
  assert.equal(json.removed.length, 2);
  assert.equal(json.kept.length, 0);
  assert.equal(f.worktrees(), before, "an empty probe leaves nothing behind");
  for (const r of json.results) assert.equal(r.diffstat.files, 0);
  rmSync(f.dir, { recursive: true, force: true });
});

test("--keep holds on to an unchanged worktree", async () => {
  const f = fixture("fankeep");
  const { json } = await fan(f, ["--prompt", "noop please", "--n", "1", "--keep"]);
  assert.equal(json.kept.length, 1);
  assert.equal(f.worktrees(), 2);
  rmSync(f.dir, { recursive: true, force: true });
});

test("--clean removes every worktree of a run and the run directory with it", async () => {
  const f = fixture("fanclean");
  const before = f.worktrees();
  const { json } = await fan(f, ["--prompt", "vary it", "--n", "2"]);
  assert.equal(f.worktrees(), before + 2);

  const io = bufferIo();
  const code = await fanCommand(["--clean", json.run_id, "--json", "--cwd", f.dir], io);
  assert.equal(code, 0);
  assert.equal(f.worktrees(), before, "git worktree list is back to baseline");
  assert.equal(existsSync(join(f.dir, WORKTREES_DIR, json.run_id)), false);
  assert.deepEqual(listRuns(f.dir), []);
  rmSync(f.dir, { recursive: true, force: true });
});

test("--promote applies one probe's work to the real tree and nothing else", async () => {
  const f = fixture("fanpromote");
  const { json } = await fan(f, ["--prompt", "vary it", "--n", "2"]);
  assert.equal(readFileSync(join(f.dir, "kernel.txt"), "utf8"), "baseline\n", "the fan-out did not touch main");

  const io = bufferIo();
  const code = await fanCommand(["--promote", "2", "--run", json.run_id, "--json", "--cwd", f.dir], io);
  assert.equal(code, 0);
  const out = JSON.parse(io.stdout) as { ok: boolean; applied: string; files: string[]; patch: string };
  assert.equal(out.ok, true);
  assert.equal(out.applied, "clean");
  assert.deepEqual(out.files, ["kernel.txt"]);

  const promoted = readFileSync(join(f.dir, "kernel.txt"), "utf8");
  assert.match(promoted, /probe 2 line 0/);
  assert.match(promoted, /probe 2 line 1/);
  assert.ok(!promoted.includes("probe 1"), "only the chosen probe's work came across");
  // Promotion is not a commit: invariant 1 says avo commit is the only writer of a version.
  assert.equal(f.git("log", "--oneline").trim().split("\n").length, 1);
  assert.ok(existsSync(join(f.dir, out.patch)), "the patch is kept as evidence");
  rmSync(f.dir, { recursive: true, force: true });
});

test("promoting a probe that changed nothing says so instead of writing an empty patch", async () => {
  const f = fixture("fanempty");
  const { json } = await fan(f, ["--prompt", "noop please", "--n", "1", "--keep"]);
  const io = bufferIo();
  const code = await fanCommand(["--promote", "1", "--run", json.run_id, "--json", "--cwd", f.dir], io);
  assert.equal(code, 0);
  const out = JSON.parse(io.stdout) as { ok: boolean; warnings: string[]; patch: string | null };
  assert.equal(out.patch, null);
  assert.match(out.warnings.join(" "), /changed nothing/);
  rmSync(f.dir, { recursive: true, force: true });
});

test("promoting a probe that does not exist names the ones that do", async () => {
  const f = fixture("fanmissing");
  const { json } = await fan(f, ["--prompt", "vary it", "--n", "2"]);
  const io = bufferIo();
  const code = await fanCommand(["--promote", "9", "--run", json.run_id, "--json", "--cwd", f.dir], io);
  assert.equal(code, 2);
  assert.match(io.stdout, /has no probe 9/);
  rmSync(f.dir, { recursive: true, force: true });
});

test("a probe that outruns --timeout is killed and reported, not waited out", async () => {
  const f = fixture("fantimeout");
  const started = Date.now();
  const { code, json } = await fan(f, ["--prompt", "go slow", "--n", "1", "--timeout", "1"]);
  assert.ok(Date.now() - started < 30_000, "the 60s stub must not have been waited out");
  assert.equal(code, 1, "every probe failed");
  assert.equal(json.results[0]?.timed_out, true);
  assert.equal(json.results[0]?.ok, false);
  assert.match(json.results[0]?.error ?? "", /exceeded --timeout 1s/);
  rmSync(f.dir, { recursive: true, force: true });
});

test("an agent that exits non-zero is a failed probe, not a failed fan-out", async () => {
  const f = fixture("fancrash");
  const { code, json } = await fan(f, ["--prompt", "crash now", "--n", "1"]);
  assert.equal(code, 1);
  assert.equal(json.results[0]?.ok, false);
  assert.match(json.results[0]?.error ?? "", /exited 3/);
  assert.match(readFileSync(join(f.dir, json.results[0]?.log_path ?? ""), "utf8"), /boom/);
  rmSync(f.dir, { recursive: true, force: true });
});

test("--resume re-runs only the probes an interrupted run never finished", async () => {
  const f = fixture("fanresume");
  const { json } = await fan(f, ["--prompt", "vary it", "--n", "2"]);

  // Simulate a kill between the two probes: probe 2's result is gone and so is its worktree, which
  // is exactly the state the manifest is written after every probe in order to survive.
  const path = join(f.dir, WORKTREES_DIR, json.run_id, MANIFEST_NAME);
  const m = JSON.parse(readFileSync(path, "utf8")) as { finished_at: string | null; probes: { i: number; status: string; result: unknown }[] };
  m.finished_at = null;
  const second = m.probes.find((p) => p.i === 2);
  if (second !== undefined) {
    second.status = "pending";
    second.result = null;
  }
  writeFileSync(path, JSON.stringify(m, null, 2));
  execFileSync("git", ["worktree", "remove", "--force", `${WORKTREES_DIR}/${json.run_id}/2`], { cwd: f.dir });

  const io = bufferIo();
  const code = await fanCommand(["--resume", json.run_id, "--json", "--cwd", f.dir], io);
  assert.equal(code, 0);
  const out = JSON.parse(io.stdout) as FanResult;
  assert.equal(out.results.length, 2, "the finished probe's result is kept, not recomputed");
  assert.match(out.warnings.join(" "), /resuming 1 of 2/);
  assert.equal(out.results.find((r) => r.i === 2)?.diffstat.insertions, 2);
  rmSync(f.dir, { recursive: true, force: true });
});

test("resuming a run that does not exist points at --list", async () => {
  const f = fixture("fanunknown");
  const io = bufferIo();
  const code = await fanCommand(["--resume", "nope", "--json", "--cwd", f.dir], io);
  assert.equal(code, 2);
  assert.match(io.stdout, /avo fan --list/);
  rmSync(f.dir, { recursive: true, force: true });
});

test("a depth-limited agent is refused before a single worktree is created", async () => {
  const f = fixture("fandepth");
  const before = f.worktrees();
  const { code, json } = await fan(f, ["--prompt", "vary it", "--n", "2"], { [LEVEL_ENV]: "3" });
  assert.equal(code, 1, "a guard is a refusal, not a harness error");
  assert.match((json as unknown as { error: string }).error, /depth limit/);
  assert.equal(f.worktrees(), before);
  assert.deepEqual(listRuns(f.dir), []);
  rmSync(f.dir, { recursive: true, force: true });
});

test("a prompt already on the chain is refused as a cycle", async () => {
  const f = fixture("fancycle");
  const { code, json } = await fan(f, ["--prompt", "vary it", "--n", "1"], {
    [CHAIN_ENV]: promptSha("vary it"),
  });
  assert.equal(code, 1);
  assert.match((json as unknown as { error: string }).error, /cycle/);
  rmSync(f.dir, { recursive: true, force: true });
});

test("uncommitted work in the root is warned about, because probes branch from HEAD", async () => {
  const f = fixture("fandirty");
  writeFileSync(join(f.dir, "kernel.txt"), "half a variation\n");
  const { json } = await fan(f, ["--prompt", "noop please", "--n", "1"]);
  assert.match(json.warnings.join(" "), /uncommitted change\(s\); probes branch from HEAD/);
  rmSync(f.dir, { recursive: true, force: true });
});

test("a repo with no scorer still fans out; the probes are simply unscored", async () => {
  const f = fixture("fanscoreless", { scorer: false });
  const { code, json } = await fan(f, ["--prompt", "vary it", "--n", "1"]);
  assert.equal(code, 0);
  assert.equal(json.results[0]?.score, null);
  assert.equal(json.results[0]?.diffstat.files, 1);
  assert.equal(json.best, null);
  rmSync(f.dir, { recursive: true, force: true });
});

test("--no-score skips f even when there is one", async () => {
  const f = fixture("fannoscore");
  const { json } = await fan(f, ["--prompt", "vary it", "--n", "1", "--no-score"]);
  assert.equal(json.results[0]?.score, null);
  rmSync(f.dir, { recursive: true, force: true });
});

test("--list reports a run and points at --resume while it is unfinished", async () => {
  const f = fixture("fanlist");
  const { json } = await fan(f, ["--prompt", "vary it", "--n", "1"]);
  const io = bufferIo();
  assert.equal(await fanCommand(["--list", "--json", "--cwd", f.dir], io), 0);
  const out = JSON.parse(io.stdout) as { runs: { run_id: string; pending: number; worktrees: number }[] };
  assert.equal(out.runs.length, 1);
  assert.equal(out.runs[0]?.run_id, json.run_id);
  assert.equal(out.runs[0]?.pending, 0);
  assert.equal(out.runs[0]?.worktrees, 1);
  rmSync(f.dir, { recursive: true, force: true });
});

test("a repo with no commit cannot be fanned out from, and says why", async () => {
  const dir = mkdtempSync(join(tmpdir(), "avo-fanbare-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const io = bufferIo();
  const code = await fanCommand(["--prompt", "p", "--agent", "claude", "--json", "--cwd", dir], io);
  assert.equal(code, 2);
  assert.match(io.stdout, /no commit to branch from/);
  rmSync(dir, { recursive: true, force: true });
});

test("no agent anywhere names the three built-ins and the two ways to choose one", async () => {
  const f = fixture("fannoagent");
  rmSync(join(f.dir, ".avo/config.json"));
  const io = bufferIo();
  const code = await fanCommand(["--prompt", "p", "--json", "--cwd", f.dir], io, undefined, undefined, { PATH: "" });
  assert.equal(code, 2);
  assert.match(io.stdout, /pi \| claude \| codex/);
  assert.match(io.stdout, /AVO_AGENT/);
  rmSync(f.dir, { recursive: true, force: true });
});

test("avo fan's own worktrees are not a variation: a second run warns about nothing", async () => {
  // The S3 bug in a new place — avo's writes must never read as work the agent did. This fixture
  // deliberately has no `.avo/worktrees/` exclusion, which is the state of any repo where `avo fan`
  // is the first avo command ever run.
  const f = fixture("fanself");
  rmSync(join(f.dir, ".gitignore"));
  f.git("rm", "-q", "--cached", ".gitignore");
  f.git("commit", "-qm", "drop the gitignore");

  const first = await fan(f, ["--prompt", "noop please", "--n", "1", "--keep"]);
  assert.equal(first.json.warnings.join(" ").includes("uncommitted"), false);
  // avo fan wrote the exclusion on the way in, exactly as avo commit does for the attempt log.
  assert.ok(existsSync(join(f.dir, ".avo/.gitignore")));

  const second = await fan(f, ["--prompt", "noop again", "--n", "1"]);
  assert.equal(
    second.json.warnings.join(" ").includes("uncommitted"),
    false,
    `the second run saw avo's own worktrees as a variation: ${second.json.warnings.join(" ")}`,
  );
  rmSync(f.dir, { recursive: true, force: true });
});
