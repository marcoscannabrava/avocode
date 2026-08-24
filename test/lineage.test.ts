import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { bufferIo } from "../src/io.ts";
import {
  bestCommand,
  bestVersion,
  commitCommand,
  ensureTrajectoryIgnored,
  extractWhy,
  isVersionScore,
  lineageCommand,
  parseCommitArgs,
  parseLineageArgs,
  readLineage,
  renderLineage,
  toVersionScore,
  withoutTrajectory,
  type Version,
} from "../src/lineage.ts";
import { spawnRunner, type Attempt } from "../src/score.ts";

// ---------------------------------------------------------------- pure helpers

const ATTEMPT: Attempt = {
  ts: "2026-08-24T00:00:00.000Z",
  ok: true,
  correct: true,
  pass: true,
  primary: 12,
  normalized: 12,
  unit: "TFLOPS",
  higher_is_better: true,
  scores: {},
  duration_s: 1,
  configs: ["*"],
  parallel: false,
  errors: [],
  warnings: [],
  log: null,
  exit_code: 0,
  git: { head: null, dirty: false },
};

test("toVersionScore persists the vector the comparator will read back, not the raw scores", () => {
  assert.deepEqual(toVersionScore(ATTEMPT).scores, { "*": 12 });
  assert.deepEqual(toVersionScore({ ...ATTEMPT, scores: { b1: 3 } }).scores, { b1: 3 });
  assert.deepEqual(toVersionScore({ ...ATTEMPT, primary: null }).scores, {});
});

test("isVersionScore rejects a trailer that is not a score", () => {
  assert.equal(isVersionScore({ primary: 1, unit: "s", higher_is_better: false, scores: {} }), true);
  assert.equal(isVersionScore({ primary: null, unit: "s", higher_is_better: false, scores: {} }), true);
  assert.equal(isVersionScore({ primary: 1, unit: "s", higher_is_better: false }), false);
  assert.equal(isVersionScore({ primary: "fast", unit: "s", higher_is_better: false, scores: {} }), false);
  assert.equal(isVersionScore(null), false);
});

test("extractWhy keeps the agent's rationale and drops subject and trailers", () => {
  const msg = "avo v2: 8 bytes\n\nremoved the padding\nbecause it was dead weight\n\nAvo-Version: 2\nAvo-Score: {}\n";
  assert.equal(extractWhy(msg), "removed the padding\nbecause it was dead weight");
  assert.equal(extractWhy("avo v1: 3 s\n\nAvo-Version: 1\nAvo-Score: {}\n"), null);
});

test("withoutTrajectory hides the attempt log so a scored-but-unedited tree still reads clean", () => {
  const porcelain = "?? .avo/attempts.jsonl\n M impl.sh\n?? .avo/worktrees/run1/a\n";
  assert.deepEqual(withoutTrajectory(porcelain), [" M impl.sh"]);
  assert.deepEqual(withoutTrajectory("?? .avo/attempts.jsonl\n"), []);
  assert.deepEqual(withoutTrajectory(""), []);
});

test("withoutTrajectory also hides what avo writes for itself: the gitignore and the memory log", () => {
  const porcelain = "?? .avo/.gitignore\n?? lineage/memory.jsonl\n M impl.sh\n";
  assert.deepEqual(withoutTrajectory(porcelain), [" M impl.sh"]);
});

test("withoutTrajectory does not mistake a look-alike path for the attempt log", () => {
  assert.deepEqual(withoutTrajectory("?? .avo/attempts.jsonl.bak\n"), ["?? .avo/attempts.jsonl.bak"]);
  assert.deepEqual(withoutTrajectory(" M src/.avo/attempts.jsonl\n"), [" M src/.avo/attempts.jsonl"]);
});

test("ensureTrajectoryIgnored is idempotent and never clobbers an existing ignore file", () => {
  const dir = mkdtempSync(join(tmpdir(), "avo-ign-"));
  ensureTrajectoryIgnored(dir);
  const first = readFileSync(join(dir, ".avo/.gitignore"), "utf8");
  assert.match(first, /attempts\.jsonl/);
  writeFileSync(join(dir, ".avo/.gitignore"), "hand written\n");
  ensureTrajectoryIgnored(dir);
  assert.equal(readFileSync(join(dir, ".avo/.gitignore"), "utf8"), "hand written\n");
  rmSync(dir, { recursive: true, force: true });
});

test("bestVersion is the highest number, not the last one read", () => {
  const v = (version: number): Version => ({
    version,
    sha: `sha${version}`,
    date: "",
    subject: "",
    why: null,
    score: { primary: version, unit: "s", higher_is_better: true, scores: {} },
  });
  assert.equal(bestVersion([v(1), v(3), v(2)])?.version, 3);
  assert.equal(bestVersion([]), null);
});

test("renderLineage says so plainly when there is no lineage yet", () => {
  const out = renderLineage({ versions: [], warnings: [] }, DEFAULT_CONFIG);
  assert.match(out, /no committed versions yet/);
});

// ---------------------------------------------------------------- argument parsing

test("avo commit rejects an unknown option instead of silently scoring", () => {
  const r = parseCommitArgs(["--wat"]);
  assert.ok("error" in r && r.error.includes("--wat"));
});

test("avo commit --why takes a value, even one that looks like a flag", () => {
  const r = parseCommitArgs(["--why", "--this is prose--"]);
  assert.ok(!("error" in r));
  assert.equal(r.why, "--this is prose--");
});

test("avo lineage parses its subcommands and their arity", () => {
  const list = parseLineageArgs(["--json"]);
  assert.ok(!("error" in list) && list.sub === "list" && list.json);
  const show = parseLineageArgs(["show", "3"]);
  assert.ok(!("error" in show) && show.sub === "show" && show.args[0] === "3");
  const diff = parseLineageArgs(["diff", "1", "2"]);
  assert.ok(!("error" in diff) && diff.sub === "diff");
  assert.ok("error" in parseLineageArgs(["show"]));
  assert.ok("error" in parseLineageArgs(["diff", "1"]));
  assert.ok("error" in parseLineageArgs(["bogus"]));
});

// ---------------------------------------------------------------- integration

/**
 * A throwaway repo whose candidate must print 42 and whose metric is code size (lower is better) —
 * a real scorer, real commits, real git plumbing. Everything below drives `avo commit` exactly the
 * way an agent does.
 */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "avo-lin-"));
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  g("init", "-q");
  g("config", "user.email", "avo@example.com");
  g("config", "user.name", "avo");
  g("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "impl.sh"), "echo 42\n# padding padding padding\n");
  g("add", "-A");
  g("commit", "-qm", "baseline");
  mkdirSync(join(dir, ".avo"), { recursive: true });
  writeFileSync(
    join(dir, ".avo/score"),
    `#!/usr/bin/env bash
out=$(bash impl.sh 2>&1)
size=$(wc -c < impl.sh | tr -d ' ')
if [[ "$out" == "42" ]]; then
  printf '{"ok":true,"correct":true,"primary":%s,"unit":"bytes","higher_is_better":false}\\n' "$size"
else
  printf '{"ok":true,"correct":false,"primary":null,"unit":"bytes","higher_is_better":false}\\n'
fi
`,
    { mode: 0o755 },
  );
  return dir;
}

const clock = () => new Date("2026-08-24T00:00:00.000Z");

async function commit(dir: string, extra: string[] = []): Promise<{ code: number; json: Record<string, unknown> }> {
  const io = bufferIo();
  const code = await commitCommand(["--cwd", dir, "--json", ...extra], io, spawnRunner, clock);
  return { code, json: JSON.parse(io.stdout) as Record<string, unknown> };
}

test("the full commit rule on a real repo: v1, refuse a regression, refuse a break, then v2", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

  // v1 — nothing to beat yet.
  const v1 = await commit(dir, ["--why", "baseline: adds the scorer"]);
  assert.equal(v1.code, 0);
  assert.equal(v1.json["action"], "committed");
  assert.equal(v1.json["version"], 1);
  assert.equal(v1.json["lineage_file"], "lineage/v001.md");

  // The commit carries the trailers, and the rationale survives in the body.
  const body = git("log", "-1", "--format=%B");
  assert.match(body, /^Avo-Version: 1$/m);
  assert.match(body, /^Avo-Score: \{.*"primary":34.*\}$/m);
  assert.match(body, /baseline: adds the scorer/);
  assert.match(git("notes", "--ref=avo", "show", "HEAD"), /"version":1/);

  // Idempotency (invariant 5): nothing changed, so nothing is committed.
  const again = await commit(dir);
  assert.equal(again.code, 0);
  assert.equal(again.json["action"], "noop");
  assert.equal(git("rev-list", "--count", "HEAD").trim(), "2");

  // A regression is refused — and leaves no commit behind.
  writeFileSync(join(dir, "impl.sh"), "echo 42\n# padding padding padding padding padding\n");
  const worse = await commit(dir);
  assert.equal(worse.code, 1);
  assert.equal(worse.json["action"], "refused");
  assert.match(String(worse.json["reason"]), /regressed/);
  assert.equal(git("rev-list", "--count", "HEAD").trim(), "2");

  // A faster but *wrong* candidate is refused by the correctness gate (invariant 2), not by score.
  writeFileSync(join(dir, "impl.sh"), "echo 41\n");
  const broken = await commit(dir);
  assert.equal(broken.code, 1);
  assert.match(String(broken.json["reason"]), /failed correctness/);
  assert.equal(git("rev-list", "--count", "HEAD").trim(), "2");

  // v2 — smaller and still correct.
  writeFileSync(join(dir, "impl.sh"), "echo 42\n");
  const v2 = await commit(dir, ["--why", "dropped the padding comment"]);
  assert.equal(v2.code, 0);
  assert.equal(v2.json["version"], 2);

  // The slice's stated acceptance case.
  const io = bufferIo();
  assert.equal(await lineageCommand(["--cwd", dir, "--json"], io, spawnRunner), 0);
  const versions = JSON.parse(io.stdout) as Version[];
  assert.equal(versions.length, 2);
  assert.deepEqual(
    versions.map((v) => v.version),
    [1, 2],
  );
  assert.equal(versions[1]?.why, "dropped the padding comment");
  assert.equal(versions[1]?.score.primary, 8);
});

test("a refused commit writes nothing at all — no lineage file, no staged index", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

  await commit(dir);
  writeFileSync(join(dir, "impl.sh"), "echo 41\n");
  const refused = await commit(dir);
  assert.equal(refused.json["action"], "refused");
  assert.equal(existsSync(join(dir, "lineage/v002.md")), false);
  assert.equal(git("diff", "--cached", "--name-only").trim(), "");
});

test("--dry-run reports the decision and leaves the repository untouched", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

  await commit(dir);
  const before = git("rev-parse", "HEAD").trim();
  writeFileSync(join(dir, "impl.sh"), "echo 42\n");
  const dry = await commit(dir, ["--dry-run"]);
  assert.equal(dry.code, 0);
  assert.equal(dry.json["action"], "would-commit");
  assert.equal(dry.json["version"], 2);
  assert.equal(dry.json["sha"], null);
  assert.equal(git("rev-parse", "HEAD").trim(), before);
  assert.equal(existsSync(join(dir, "lineage/v002.md")), false);
});

test("the attempt log is trajectory: it never enters a lineage commit", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

  await commit(dir);
  writeFileSync(join(dir, "impl.sh"), "echo 42\n");
  await commit(dir);
  const tracked = git("ls-files").trim().split("\n");
  assert.ok(!tracked.includes(".avo/attempts.jsonl"), `attempts.jsonl was committed: ${tracked.join(" ")}`);
  assert.ok(tracked.includes(".avo/.gitignore"));
  // and scoring alone must not make the tree look like it has a change to commit
  assert.equal((await commit(dir)).json["action"], "noop");
});

test("a version that measures fewer configs than the best one is refused", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // v1 reports two configs.
  writeFileSync(
    join(dir, ".avo/score"),
    `#!/usr/bin/env bash
printf '{"ok":true,"correct":true,"primary":10,"unit":"s","higher_is_better":true,"scores":{"a":10,"b":10}}\\n'
`,
    { mode: 0o755 },
  );
  assert.equal((await commit(dir)).json["version"], 1);

  // The candidate improves 'a' but stops measuring 'b'.
  writeFileSync(
    join(dir, ".avo/score"),
    `#!/usr/bin/env bash
printf '{"ok":true,"correct":true,"primary":99,"unit":"s","higher_is_better":true,"scores":{"a":99}}\\n'
`,
    { mode: 0o755 },
  );
  const r = await commit(dir);
  assert.equal(r.code, 1);
  assert.match(String(r.json["reason"]), /may not measure less/);
});

test("avo commit refuses to run outside a git repository", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "avo-nogit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = await commit(dir);
  assert.equal(r.code, 2);
  assert.match(String(r.json["reason"]), /not a git repository/);
});

test("avo commit reports a missing scorer as a harness error, not a refusal", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  rmSync(join(dir, ".avo/score"));
  writeFileSync(join(dir, "impl.sh"), "echo 42\n");
  const r = await commit(dir);
  assert.equal(r.code, 2);
  assert.match(String(r.json["reason"]), /no executable \.avo\/score/);
});

test("avo best names the version a candidate is ranked against, and exits 1 when there is none", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const empty = bufferIo();
  assert.equal(await bestCommand(["--cwd", dir, "--json"], empty, spawnRunner), 1);
  assert.equal(empty.stdout.trim(), "null");

  await commit(dir);
  const io = bufferIo();
  assert.equal(await bestCommand(["--cwd", dir, "--json"], io, spawnRunner), 0);
  assert.equal((JSON.parse(io.stdout) as Version).version, 1);
});

test("avo lineage show and diff name a version that does not exist instead of guessing", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await commit(dir);

  const show = bufferIo();
  assert.equal(await lineageCommand(["--cwd", dir, "show", "1"], show, spawnRunner), 0);
  assert.match(show.stdout, /^v1 {2}[0-9a-f]{40}/);

  const missing = bufferIo();
  assert.equal(await lineageCommand(["--cwd", dir, "show", "9"], missing, spawnRunner), 2);
  assert.match(missing.stderr, /known versions: v1/);
});

test("avo lineage diff reports both the score delta and the patch", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await commit(dir);
  writeFileSync(join(dir, "impl.sh"), "echo 42\n");
  await commit(dir);

  const io = bufferIo();
  assert.equal(await lineageCommand(["--cwd", dir, "diff", "1", "2", "--json"], io, spawnRunner), 0);
  const out = JSON.parse(io.stdout) as { from: number; to: number; comparison: { commit: boolean }; patch: string };
  assert.equal(out.from, 1);
  assert.equal(out.to, 2);
  assert.equal(out.comparison.commit, true);
  assert.match(out.patch, /impl\.sh/);
});

test("readLineage warns about a version whose score trailer is unreadable rather than trusting it", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

  writeFileSync(join(dir, "impl.sh"), "echo 42\n");
  git("add", "-A");
  git("commit", "-qm", "hand-made v1\n\nAvo-Version: 1\nAvo-Score: not-json");
  const { versions, warnings } = await readLineage(spawnRunner, dir);
  assert.deepEqual(versions, []);
  assert.match(warnings[0] as string, /no readable Avo-Score/);
});

test("the config file steers the commit rule: reduce:mean admits what dominate refuses", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scorer = (a: number, b: number) =>
    writeFileSync(
      join(dir, ".avo/score"),
      `#!/usr/bin/env bash\nprintf '{"ok":true,"correct":true,"primary":1,"unit":"s","higher_is_better":true,"scores":{"a":${a},"b":${b}}}\\n'\n`,
      { mode: 0o755 },
    );

  scorer(10, 10);
  assert.equal((await commit(dir)).json["version"], 1);

  // a big win on 'a' bought with a small loss on 'b': dominate refuses it...
  scorer(100, 9);
  const refused = await commit(dir);
  assert.equal(refused.json["action"], "refused");

  // ...and reduce:mean, opted into explicitly, admits it.
  writeFileSync(join(dir, ".avo/config.json"), JSON.stringify({ reduce: "mean" }));
  const accepted = await commit(dir);
  assert.equal(accepted.json["action"], "committed");
  assert.equal(accepted.json["version"], 2);
});
