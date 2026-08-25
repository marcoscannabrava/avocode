/**
 * The six native Pi tools. Every test drives `execute` exactly the way Pi does — five positional
 * arguments, a context whose only meaningful field is `cwd` — against a REAL repo with a REAL
 * scorer, because the whole claim of `pi/extensions/avo/tools.ts` is that it adds no behaviour of
 * its own. A test that mocked `src/` would prove only that the wrapper calls something.
 *
 * The two invariants worth stating, because they are the ones a future edit will break silently:
 *   1. A refusal is NOT an error. Pi marks a tool result failed only when `execute` throws, so a
 *      thrown refusal would teach the model that a losing candidate is a malfunction.
 *   2. `details` is always populated. Pi rebuilds extension state from tool-result details when a
 *      session branches; a tool that returns prose only is a tool whose effect vanishes on branch.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AVO_TOOL_NAMES, avoTools, defaultDeps, type LineageDetails, type PiToolDeps } from "../pi/extensions/avo/tools.ts";
import { ATTEMPTS_PATH, SCORER_PATH, spawnRunner, type Attempt, type RunResult, type Runner } from "../src/score.ts";
import type { CommitDecision } from "../src/lineage.ts";
import type { AddResult, QueryResult } from "../src/knowledge.ts";
import { FIRECRAWL_KEY, type Fetcher } from "../src/websearch.ts";

// ------------------------------------------------------------------- harness

const clock = () => new Date("2026-08-25T00:00:00.000Z");

function deps(over: Partial<PiToolDeps> = {}): PiToolDeps {
  return { ...defaultDeps(), now: clock, env: {}, ...over };
}

const toolsOf = (d: PiToolDeps = deps()): Map<string, ToolDefinition> =>
  new Map(avoTools(d).map((t) => [t.name, t]));

/** Pi passes the session context; `cwd` is the only field the avo tools are allowed to read. */
const ctxAt = (cwd: string): ExtensionContext => ({ cwd }) as unknown as ExtensionContext;

/** One tool call, with Pi's own argument order. */
function call(tool: ToolDefinition, params: unknown, cwd: string): Promise<{ content: unknown; details: unknown }> {
  return tool.execute("call-1", params as never, undefined, undefined, ctxAt(cwd)) as Promise<{
    content: unknown;
    details: unknown;
  }>;
}

const textOf = (r: { content: unknown }): string =>
  (r.content as { type: string; text: string }[]).map((c) => c.text).join("");

/**
 * A repo whose candidate must print 42 and whose metric is code size, lower better — the same
 * fixture shape the lineage tests use, so a disagreement between `avo commit` and `avo_commit`
 * shows up as two suites diverging rather than as one suite quietly agreeing with itself.
 */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "avo-pi-"));
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
    join(dir, SCORER_PATH),
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

/** A git repo with no scorer at all. */
function bareRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "avo-pi-bare-"));
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  g("init", "-q");
  g("config", "user.email", "avo@example.com");
  g("config", "user.name", "avo");
  g("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "readme.md"), "hi\n");
  g("add", "-A");
  g("commit", "-qm", "baseline");
  return dir;
}

// ------------------------------------------------------- registration surface

test("exactly the six declared tools are registered, in the declared order", () => {
  assert.deepEqual(avoTools(deps()).map((t) => t.name), [...AVO_TOOL_NAMES]);
});

test("every tool reaches the system prompt properly: description, snippet and guidelines", () => {
  for (const t of avoTools(deps())) {
    assert.ok(t.description.length > 40, `${t.name} needs a description the model can act on`);
    // promptSnippet and promptGuidelines are how a tool's usage rules land in the system prompt
    // (docs/extensions.md). A tool with neither is documented only to whoever reads this file.
    assert.ok((t.promptSnippet ?? "").length > 0, `${t.name} has no promptSnippet`);
    assert.ok((t.promptGuidelines ?? []).length > 0, `${t.name} has no promptGuidelines`);
    assert.equal((t.parameters as { type?: string }).type, "object");
  }
});

test("no tool lets the model choose the repo — cwd comes from the session context alone", () => {
  for (const t of avoTools(deps())) {
    const props = Object.keys((t.parameters as { properties?: Record<string, unknown> }).properties ?? {});
    for (const forbidden of ["cwd", "repo", "dir", "path"]) {
      assert.ok(!props.includes(forbidden), `${t.name} exposes '${forbidden}'; the lineage must be hard to retarget`);
    }
  }
});

test("the tools that mutate repo-global state run one at a time", () => {
  const m = toolsOf();
  for (const name of ["avo_score", "avo_commit", "avo_know_add", "avo_fan"]) {
    assert.equal(m.get(name)?.executionMode, "sequential", `${name} must not run concurrently with itself`);
  }
});

// ------------------------------------------------------------------ avo_score

test("avo_score measures the working tree, returns the attempt as details, and records it", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = await call(toolsOf().get("avo_score")!, {}, dir);
  const a = r.details as Attempt;
  assert.equal(a.pass, true);
  assert.equal(a.primary, 34);
  // content is the CLI's own renderer — the model reads what a human reads.
  assert.match(textOf(r), /34/);
  const recorded = readFileSync(join(dir, ATTEMPTS_PATH), "utf8").trim().split("\n");
  assert.equal(recorded.length, 1);
  assert.deepEqual(JSON.parse(recorded[0]!), a);
});

test("a candidate that fails correctness is a RESULT, not a thrown error", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "impl.sh"), "echo 41\n");

  const r = await call(toolsOf().get("avo_score")!, {}, dir);
  const a = r.details as Attempt;
  assert.equal(a.pass, false);
  assert.equal(a.primary, null, "a failed candidate scores the null sentinel, never its measured value");
});

test("record:false measures without touching the log the supervisor reads", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await call(toolsOf().get("avo_score")!, { record: false }, dir);
  assert.equal(existsSync(join(dir, ATTEMPTS_PATH)), false);
});

test("a repo with no scorer is a harness error — a throw, because Pi flags failure only on throw", async (t) => {
  const dir = bareRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await assert.rejects(call(toolsOf().get("avo_score")!, {}, dir), /score/i);
});

// ----------------------------------------------------------------- avo_commit

test("avo_commit persists v1 with its rationale and reports the decision as details", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = await call(toolsOf().get("avo_commit")!, { why: "baseline: adds the scorer" }, dir);
  const d = r.details as CommitDecision;
  assert.equal(d.action, "committed");
  assert.equal(d.version, 1);
  const body = execFileSync("git", ["log", "-1", "--format=%B"], { cwd: dir, encoding: "utf8" });
  assert.match(body, /^Avo-Version: 1$/m);
  assert.match(body, /baseline: adds the scorer/);
});

test("a refused candidate comes back as an ordinary result the model can read and act on", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const commit = toolsOf().get("avo_commit")!;
  await call(commit, { why: "baseline" }, dir);

  // Bigger file, same output: correct, but worse under a lower-is-better metric.
  writeFileSync(join(dir, "impl.sh"), "echo 42\n# padding padding padding padding padding\n");
  const r = await call(commit, { why: "more padding, expecting nothing" }, dir);
  const d = r.details as CommitDecision;
  assert.equal(d.action, "refused");
  assert.match(textOf(r), /refused/i);
  // The refusal did not become a version.
  assert.match(execFileSync("git", ["log", "-1", "--format=%B"], { cwd: dir, encoding: "utf8" }), /Avo-Version: 1/);
});

test("an unchanged tree is a noop, not a second version", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const commit = toolsOf().get("avo_commit")!;
  await call(commit, { why: "baseline" }, dir);

  const r = await call(commit, { why: "again" }, dir);
  assert.equal((r.details as CommitDecision).action, "noop");
});

test("dry_run reports what it would do and creates no version", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = await call(toolsOf().get("avo_commit")!, { why: "would this win?", dry_run: true }, dir);
  assert.equal((r.details as CommitDecision).action, "would-commit");
  assert.match(execFileSync("git", ["log", "-1", "--format=%B"], { cwd: dir, encoding: "utf8" }), /baseline/);
});

test("an empty rationale is refused before anything is scored", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await assert.rejects(call(toolsOf().get("avo_commit")!, { why: "   " }, dir), /why/);
  assert.equal(existsSync(join(dir, ATTEMPTS_PATH)), false, "nothing ran, so nothing was recorded");
});

// ---------------------------------------------------------------- avo_lineage

test("avo_lineage lists the versions and names the best one in details", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await call(toolsOf().get("avo_commit")!, { why: "baseline" }, dir);

  const r = await call(toolsOf().get("avo_lineage")!, {}, dir);
  const d = r.details as LineageDetails;
  assert.equal(d.versions.length, 1);
  assert.equal(d.best?.version, 1);
  assert.equal(d.version, null, "the list view resolves no single version");
});

test("avo_lineage with a version shows its recorded rationale", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await call(toolsOf().get("avo_commit")!, { why: "shrink the padding" }, dir);

  const r = await call(toolsOf().get("avo_lineage")!, { version: 1 }, dir);
  assert.equal((r.details as LineageDetails).version?.version, 1);
  assert.match(textOf(r), /shrink the padding/);
});

test("asking for a version that does not exist says which ones do", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await call(toolsOf().get("avo_commit")!, { why: "baseline" }, dir);

  await assert.rejects(call(toolsOf().get("avo_lineage")!, { version: 7 }, dir), /no v7.*v1/s);
});

test("an empty lineage says so rather than naming nothing", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await assert.rejects(call(toolsOf().get("avo_lineage")!, { version: 1 }, dir), /empty/);
});

// ------------------------------------------------------------ avo_know_query

test("avo_know_query searches K and says which backend answered", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  writeFileSync(join(dir, "knowledge/registers.md"), "# Register pressure\n\nSpilling costs occupancy.\n");

  // No qmd on the test machine's PATH is the normal case; the local scan must still answer.
  const r = await call(toolsOf().get("avo_know_query")!, { query: "register pressure", lexical: true }, dir);
  const q = r.details as QueryResult;
  assert.ok(q.backend.length > 0, "a query result always names its backend");
  assert.equal(q.query, "register pressure");
});

// -------------------------------------------------------------- avo_know_add

test("avo_know_add ingests a local file into K with provenance", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "note.md"), "# A note\n\nWorth keeping.\n");

  const r = await call(toolsOf().get("avo_know_add")!, { target: "note.md", no_embed: true }, dir);
  const a = r.details as AddResult;
  assert.equal(a.ok, true);
  assert.equal(a.action, "created");
  assert.ok(a.path !== null && existsSync(join(dir, a.path)));
});

test("the @ prefix some models emit on a path is stripped, not treated as a filename", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "note.md"), "# A note\n\nWorth keeping.\n");

  const r = await call(toolsOf().get("avo_know_add")!, { target: "@note.md", no_embed: true }, dir);
  assert.equal((r.details as AddResult).ok, true);
});

test("a target outside the repo is refused; K holds THIS repo's knowledge", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await assert.rejects(call(toolsOf().get("avo_know_add")!, { target: "../../etc/hosts" }, dir), /outside the repo/);
});

test("a URL is fetched through the scrape backend rather than resolved as a path", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seen: string[] = [];
  const fetcher: Fetcher = async (url, req) => {
    seen.push(url);
    assert.match(String(req.headers?.["authorization"] ?? ""), /test-key/);
    return {
      status: 200,
      ok: true,
      body: JSON.stringify({ data: { markdown: "# Fetched\n\nbody text\n", metadata: { title: "Fetched" } } }),
      error: null,
    };
  };
  const d = deps({ fetcher, env: { [FIRECRAWL_KEY]: "test-key" } });

  const r = await call(
    toolsOf(d).get("avo_know_add")!,
    { target: "https://example.com/doc", name: "fetched", no_embed: true },
    dir,
  );
  assert.equal(seen.length, 1);
  assert.match(seen[0]!, /firecrawl/i);
  const a = r.details as AddResult;
  assert.equal(a.ok, true);
  assert.ok(a.path !== null && readFileSync(join(dir, a.path), "utf8").includes("https://example.com/doc"), "provenance");
});

test("a URL with no scrape key is refused as a RESULT that says what to do instead", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Not a throw: the model can act on this — save the page and add the file — whereas a thrown
  // error reads as avo being broken.
  const r = await call(toolsOf().get("avo_know_add")!, { target: "https://example.com/doc" }, dir);
  const a = r.details as AddResult;
  assert.equal(a.ok, false);
  assert.equal(a.action, "refused");
  assert.match(textOf(r), /refused/);
  assert.match(a.error ?? "", new RegExp(FIRECRAWL_KEY));
});

// -------------------------------------------------------------------- avo_fan

test("avo_fan refuses bad arguments before creating a single worktree", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await assert.rejects(call(toolsOf().get("avo_fan")!, { prompt: "try things", n: 0 }, dir), /avo_fan/);
  assert.equal(existsSync(join(dir, ".avo/worktrees")), false);
});

test("a guard refusal reaches the model as an error, not as a fan-out that found nothing", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // AVO_FAN_DEPTH at the ceiling means this call is a fan inside a fan inside a fan.
  const d = deps({ env: { AVO_FAN_DEPTH: "3" } });

  await assert.rejects(call(toolsOf(d).get("avo_fan")!, { prompt: "try things" }, dir), /avo_fan/);
});

test("avo_fan drives the agent named in its arguments, on the model it was given", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls: { cmd: string; args: string[] }[] = [];
  const runner: Runner = async (cmd, args, opts) => {
    calls.push({ cmd, args: [...args] });
    if (cmd === "git" || cmd.endsWith(SCORER_PATH)) return spawnRunner(cmd, args, opts);
    // The agent: it does nothing to the worktree, which is a legitimate probe outcome.
    return { code: 0, stdout: "did nothing\n", stderr: "", timedOut: false, spawnError: null } satisfies RunResult;
  };

  const r = await call(toolsOf(deps({ runner })).get("avo_fan")!, { prompt: "try things", n: 1, agent: "claude", model: "haiku" }, dir);
  assert.ok(r.details !== null, "a fan result must survive a session branch");
  const agentCall = calls.find((c) => c.cmd === "claude");
  assert.ok(agentCall !== undefined, `no probe ran claude; ran ${calls.map((c) => c.cmd).join(", ")}`);
  assert.ok(agentCall.args.includes("haiku"), `the probe model was not passed: ${agentCall.args.join(" ")}`);
});

// ------------------------------------------------------------------- branching

test("every successful call returns details, because Pi rebuilds state from them on a branch", async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "note.md"), "# note\n\ntext\n");
  const m = toolsOf();

  const results = [
    await call(m.get("avo_score")!, {}, dir),
    await call(m.get("avo_commit")!, { why: "baseline" }, dir),
    await call(m.get("avo_lineage")!, {}, dir),
    await call(m.get("avo_know_query")!, { query: "anything", lexical: true }, dir),
    await call(m.get("avo_know_add")!, { target: "note.md", no_embed: true }, dir),
  ];
  for (const r of results) {
    assert.notEqual(r.details, undefined);
    assert.notEqual(r.details, null);
    assert.ok(textOf(r).length > 0);
  }
});
