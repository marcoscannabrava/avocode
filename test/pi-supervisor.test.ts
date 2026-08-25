/**
 * The native Pi supervisor. Everything here drives `installSupervisor` through a fake
 * `ExtensionAPI` — the same five events Pi emits, in the same shapes — against a REAL repo with a
 * REAL scorer, a REAL attempt log and a REAL git lineage. The stalling sequence is scripted by
 * running `avo_score` for real, not by handing the detector a fixture array: the whole claim of
 * this extension is that it counts what `avo supervise` counts, and a mocked `supervise()` would
 * prove only that the wiring calls something.
 *
 * The three properties a future edit will break silently, in order of how much they cost:
 *   1. ONE stall produces ONE directive. Steering on every attempt burns context and trains the
 *      model to skim the one message that is supposed to change its mind.
 *   2. The count comes from the log, so `avo run` and a Pi session cannot double-steer.
 *   3. A supervisor that cannot read the log warns and stays out of the way (invariant 4).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { avoTools, defaultDeps } from "../pi/extensions/avo/tools.ts";
import {
  episodeKeys,
  installSupervisor,
  statusLine,
  SUPERVISED_TOOLS,
  SUPERVISOR_MESSAGE_TYPE,
  STATUS_KEY,
  type InterventionRecord,
  type SteerDetails,
  type SupervisorDeps,
} from "../pi/extensions/avo-supervisor/supervisor.ts";
import { CONFIG_PATH } from "../src/config.ts";
import { ATTEMPTS_PATH, spawnRunner, type Attempt } from "../src/score.ts";
import { supervise, type Signal, type SuperviseState, type Supervision } from "../src/supervise.ts";

// ------------------------------------------------------------------- harness

/** Thresholds low enough to stall in a handful of scores; a real `.avo/config.json`, not a flag. */
const STALL = 3;
const THRASH = 2;

/**
 * The repo every test runs against: a candidate that must print 42, scored by its byte size, lower
 * better. Same shape as the lineage and tools fixtures, so a disagreement between `avo commit`,
 * `avo_commit` and this shows up as three suites diverging rather than one agreeing with itself.
 */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "avo-sup-"));
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "avo@example.com");
  g("config", "user.name", "avo");
  mkdirSync(join(dir, ".avo"), { recursive: true });
  // The scaffold commit is deliberately NOT the candidate: `avo commit` calls a tree identical
  // to HEAD a noop, so v1 has to be an actual change made by a test.
  writeFileSync(join(dir, "impl.sh"), "# scaffold\necho 42\n");
  writeFileSync(
    join(dir, ".avo/score"),
    [
      "#!/usr/bin/env bash",
      "out=$(bash impl.sh 2>&1)",
      "size=$(wc -c < impl.sh | tr -d ' ')",
      'if [[ "$out" == "42" ]]; then',
      `  printf '{"ok":true,"correct":true,"primary":%s,"unit":"bytes","higher_is_better":false}\\n' "$size"`,
      "else",
      `  printf '{"ok":true,"correct":false,"primary":null,"unit":"bytes","higher_is_better":false}\\n'`,
      "fi",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(join(dir, CONFIG_PATH), `${JSON.stringify({ supervise: { stall: STALL, thrash: THRASH } })}\n`);
  g("add", "-A");
  g("commit", "-qm", "baseline");
  return dir;
}

interface Sent {
  customType: string;
  content: string;
  display: boolean;
  details: SteerDetails;
}

/**
 * A fake `ExtensionAPI` that records what the supervisor did and lets a test emit the events Pi
 * emits. Only the surface `installSupervisor` is allowed to touch is implemented — anything else
 * throwing is the point, because a supervisor that reached for `pi.setModel` would be doing
 * something this file has not thought about.
 */
function fakePi(cwd: string, entries: SessionEntry[] = []) {
  const handlers = new Map<string, (e: unknown, ctx: ExtensionContext) => unknown>();
  const sent: Sent[] = [];
  const notices: { message: string; type: string }[] = [];
  const status: (string | undefined)[] = [];
  const branch = [...entries];

  const ctx = {
    cwd,
    ui: {
      notify: (message: string, type = "info") => notices.push({ message, type }),
      setStatus: (key: string, text: string | undefined) => {
        assert.equal(key, STATUS_KEY, "the supervisor owns exactly one footer slot");
        status.push(text);
      },
    },
    sessionManager: { getBranch: () => branch },
  } as unknown as ExtensionContext;

  const pi = {
    on: (event: string, handler: (e: unknown, c: ExtensionContext) => unknown) => handlers.set(event, handler),
    sendMessage: (m: Sent) => {
      sent.push(m);
      // Pi appends the injected message to the branch, which is what a later reload reads back.
      branch.push({ type: "custom_message", id: `m${branch.length}`, parentId: null, timestamp: "", ...m } as SessionEntry);
    },
  } as unknown as ExtensionAPI;

  const emit = async (event: string, payload: unknown): Promise<void> => {
    await handlers.get(event)?.(payload, ctx);
  };
  const toolResult = (toolName: string, over: Partial<ToolResultEvent> = {}) =>
    emit("tool_result", {
      type: "tool_result",
      toolCallId: "t1",
      toolName,
      input: {},
      content: [],
      isError: false,
      details: undefined,
      ...over,
    } as ToolResultEvent);

  return { pi, ctx, emit, toolResult, sent, notices, status, branch, handlers };
}

/** Deps whose `record` is a spy: the tests must not need `bd` installed to prove the steer. */
function deps(over: Partial<SupervisorDeps> = {}): { deps: SupervisorDeps; recorded: string[] } {
  const recorded: string[] = [];
  const d: SupervisorDeps = {
    supervise,
    record: async (_cwd, key): Promise<InterventionRecord> => {
      recorded.push(key);
      return { key: `avo-intervention-${key}`, bead: null, backend: "file", warnings: [] };
    },
    runner: spawnRunner,
    now: () => new Date("2026-08-25T00:00:00.000Z"),
    ...over,
  };
  return { deps: d, recorded };
}

const tools = new Map(avoTools({ ...defaultDeps(), env: {} }).map((t) => [t.name, t]));
const at = (cwd: string) => ({ cwd }) as unknown as ExtensionContext;

/** One real `avo_score`: runs the scorer, appends to `.avo/attempts.jsonl`. */
const score = (cwd: string) => tools.get("avo_score")!.execute("s", {} as never, undefined, undefined, at(cwd));
/** One real `avo_commit`, returning the decision Pi would put in `details`. */
const commit = (cwd: string, why: string) =>
  tools.get("avo_commit")!.execute("c", { why } as never, undefined, undefined, at(cwd)) as Promise<{ details: unknown }>;

/** Lands v1: the lean candidate, smaller than the scaffold, so there is a best to stall against. */
async function landV1(dir: string): Promise<unknown> {
  writeFileSync(join(dir, "impl.sh"), "echo 42\n");
  const r = await commit(dir, "baseline: echo 42");
  assert.equal((r.details as { action: string }).action, "committed", "the fixture must be able to land v1");
  return r.details;
}

const cleanup = (dir: string) => rmSync(dir, { recursive: true, force: true });

// ---------------------------------------------------------- the pure decisions

const stateOf = (over: Partial<SuperviseState> = {}): SuperviseState => ({
  versions: 1,
  best: { version: 1, sha: "a".repeat(40), date: "2026-08-24T09:00:00+00:00", primary: 8, unit: "bytes" },
  attempts: 6,
  analyzed: 6,
  since_best: 5,
  failing_streak: 0,
  repeat: 0,
  signature: null,
  last_pass: null,
  ...over,
});

const sig = (kind: Signal["kind"], over: Partial<Signal> = {}): Signal => ({ kind, count: 5, threshold: 3, detail: "d", ...over });

test("a stall keeps one episode key while it deepens — the same problem is not a new problem", () => {
  const first = episodeKeys(stateOf({ analyzed: 6, since_best: 3 }), [sig("stall")]);
  const later = episodeKeys(stateOf({ analyzed: 9, since_best: 6 }), [sig("stall")]);
  assert.deepEqual(first, later);
});

test("a stall under a NEW best version is a new episode", () => {
  const before = episodeKeys(stateOf(), [sig("stall")]);
  const after = episodeKeys(stateOf({ best: { ...stateOf().best!, version: 2, sha: "b".repeat(40) } }), [sig("stall")]);
  assert.notDeepEqual(before, after);
});

test("the anchor is `analyzed`, not `attempts` — past the window a stall would otherwise re-steer forever", () => {
  // Both readings are the same saturated window; only the untruncated total moved.
  const a = episodeKeys(stateOf({ attempts: 4_000, analyzed: 1_000, since_best: 1_000 }), [sig("stall")]);
  const b = episodeKeys(stateOf({ attempts: 4_001, analyzed: 1_000, since_best: 1_000 }), [sig("stall")]);
  assert.deepEqual(a, b);
});

test("a thrash episode is named by its signature and where the streak began", () => {
  const s = stateOf({ signature: "assert failed", failing_streak: 2, analyzed: 6 });
  assert.deepEqual(episodeKeys(s, [sig("thrash")]), ["thrash@assert failed@4"]);
  // Same streak, one failure deeper: still one episode.
  assert.deepEqual(episodeKeys({ ...s, failing_streak: 3, analyzed: 7 }, [sig("thrash")]), ["thrash@assert failed@4"]);
  // A different way of failing is a different problem.
  assert.notDeepEqual(episodeKeys({ ...s, signature: "timeout" }, [sig("thrash")]), episodeKeys(s, [sig("thrash")]));
});

test("the footer names the best, the distance from it, and whether anything is firing", () => {
  const quiet = { triggered: false, state: stateOf({ since_best: 2 }), signals: [] } as unknown as Supervision;
  assert.equal(statusLine(quiet), "v1 · 8 bytes · 2 since best");
  const loud = { triggered: true, state: stateOf(), signals: [sig("stall"), sig("thrash")] } as unknown as Supervision;
  assert.match(statusLine(loud), /^v1 · 8 bytes · 5 since best · ! stall\+thrash$/);
  const fresh = { triggered: false, state: stateOf({ best: null, since_best: 1 }), signals: [] } as unknown as Supervision;
  assert.equal(statusLine(fresh), "no version yet · 1 since best");
});

test("only the two tools that can move a counter are watched", () => {
  // avo_fan scores in disposable worktrees with record:false, so it moves nothing here.
  assert.deepEqual([...SUPERVISED_TOOLS].sort(), ["avo_commit", "avo_score"]);
});

// --------------------------------------------------- the acceptance: exactly once

test("a scripted stalling sequence injects the steering directive EXACTLY ONCE", async () => {
  const dir = fixture();
  try {
    const d = deps();
    const f = fakePi(dir);
    installSupervisor(f.pi, d.deps);
    await f.emit("session_start", { type: "session_start" } as SessionStartEvent);

    // v1: the baseline commits, so there is a best to stall against.
    await f.toolResult("avo_commit", { details: await landV1(dir) });
    assert.equal(f.sent.length, 0, "a fresh best is not a stall");

    // Now score a worse candidate over and over. Nothing improves, so `since_best` climbs past
    // STALL and keeps climbing — the exact shape `avo run` would steer on every iteration.
    for (let i = 0; i < STALL + 4; i++) {
      writeFileSync(join(dir, "impl.sh"), `${"# padding\n".repeat(i + 1)}echo 42\n`);
      await score(dir);
      await f.toolResult("avo_score");
    }

    const s = await supervise({ json: true, cwd: dir, stall: null, thrash: null }, { runner: spawnRunner });
    assert.equal(s.triggered, true, "the sequence must actually stall, or this test proves nothing");
    assert.ok(s.state.since_best > STALL, `since_best ${s.state.since_best} should be well past ${STALL}`);

    assert.equal(f.sent.length, 1, `steered ${f.sent.length} times for one stall`);
    assert.equal(f.sent[0]?.customType, SUPERVISOR_MESSAGE_TYPE);
    assert.match(f.sent[0]?.content ?? "", /stall/i);
    assert.deepEqual(f.sent[0]?.details.kinds, ["stall"]);
    assert.equal(d.recorded.length, 1, "one intervention recorded, keyed by the episode");
  } finally {
    cleanup(dir);
  }
});

test("a new best ends the episode, and the next stall steers again", async () => {
  const dir = fixture();
  try {
    const d = deps();
    const f = fakePi(dir);
    installSupervisor(f.pi, d.deps);
    await f.emit("session_start", { type: "session_start" } as SessionStartEvent);

    await f.toolResult("avo_commit", { details: await landV1(dir) });
    for (let i = 0; i < STALL + 1; i++) {
      writeFileSync(join(dir, "impl.sh"), `${"# padding\n".repeat(i + 1)}echo 42\n`);
      await score(dir);
      await f.toolResult("avo_score");
    }
    assert.equal(f.sent.length, 1, "the first stall steers once");

    // A genuine improvement: fewer bytes than the baseline, so it commits as v2.
    writeFileSync(join(dir, "impl.sh"), "echo 42");
    const better = await commit(dir, "drop the trailing newline");
    assert.equal((better.details as { action: string }).action, "committed", "the fixture must be able to improve");
    await f.toolResult("avo_commit", { details: better.details });
    assert.equal(f.sent.length, 1, "landing a version is not a stall");

    for (let i = 0; i < STALL + 1; i++) {
      writeFileSync(join(dir, "impl.sh"), `${"# padding\n".repeat(i + 1)}echo 42`);
      await score(dir);
      await f.toolResult("avo_score");
    }
    assert.equal(f.sent.length, 2, "a stall under the NEW best is a new problem and steers again");
    assert.notDeepEqual(f.sent[0]?.details.episodes, f.sent[1]?.details.episodes);
    assert.equal(d.recorded.length, 2);
  } finally {
    cleanup(dir);
  }
});

test("the count is the attempt log's, not the session's — a reload steers on what is already there", async () => {
  const dir = fixture();
  try {
    const d = deps();
    const f = fakePi(dir);
    installSupervisor(f.pi, d.deps);

    // The stall happened before this session existed: `avo run`, another Pi window, a plain
    // `avo score` loop. The supervisor never saw a single one of those tool results.
    await f.toolResult("avo_commit", { details: await landV1(dir) });
    await f.emit("session_start", { type: "session_start" } as SessionStartEvent);
    for (let i = 0; i < STALL + 1; i++) {
      writeFileSync(join(dir, "impl.sh"), `${"# padding\n".repeat(i + 1)}echo 42\n`);
      await score(dir);
    }
    assert.equal(f.sent.length, 0, "nothing was emitted to the supervisor yet");

    // One tool result is now enough: the state it reads is the log, which already stalled.
    await f.toolResult("avo_score");
    assert.equal(f.sent.length, 1);
    assert.ok((f.sent[0]?.details.state.since_best ?? 0) > STALL);
  } finally {
    cleanup(dir);
  }
});

test("a reload rebuilds the answered episodes from the branch, so it does not re-steer", async () => {
  const dir = fixture();
  try {
    const first = fakePi(dir);
    installSupervisor(first.pi, deps().deps);
    await first.emit("session_start", { type: "session_start" } as SessionStartEvent);
    await first.toolResult("avo_commit", { details: await landV1(dir) });
    for (let i = 0; i < STALL + 1; i++) {
      writeFileSync(join(dir, "impl.sh"), `${"# padding\n".repeat(i + 1)}echo 42\n`);
      await score(dir);
      await first.toolResult("avo_score");
    }
    assert.equal(first.sent.length, 1);

    // A second session over the same branch — a reload, a resume, an extension reload.
    const second = fakePi(dir, first.branch);
    installSupervisor(second.pi, deps().deps);
    await second.emit("session_start", { type: "session_start" } as SessionStartEvent);
    await score(dir);
    await second.toolResult("avo_score");
    assert.equal(second.sent.length, 0, "the episode was already answered on this branch");

    // A branch that never saw the directive is a model that never read it: it must be steered.
    const branched = fakePi(dir, []);
    installSupervisor(branched.pi, deps().deps);
    await branched.emit("session_start", { type: "session_start" } as SessionStartEvent);
    await branched.toolResult("avo_score");
    assert.equal(branched.sent.length, 1, "a branch without the directive still needs steering");
  } finally {
    cleanup(dir);
  }
});

test("a thrash that appears during a stall is steered — it is a different problem", async () => {
  const dir = fixture();
  try {
    const f = fakePi(dir);
    installSupervisor(f.pi, deps().deps);
    await f.emit("session_start", { type: "session_start" } as SessionStartEvent);
    await f.toolResult("avo_commit", { details: await landV1(dir) });

    for (let i = 0; i < STALL + 1; i++) {
      writeFileSync(join(dir, "impl.sh"), `${"# padding\n".repeat(i + 1)}echo 42\n`);
      await score(dir);
      await f.toolResult("avo_score");
    }
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.sent[0]?.details.kinds, ["stall"]);

    // Now break correctness the same way THRASH times running: a second, distinct signal.
    writeFileSync(join(dir, "impl.sh"), "echo 43\n");
    for (let i = 0; i < THRASH; i++) {
      await score(dir);
      await f.toolResult("avo_score");
    }
    assert.equal(f.sent.length, 2, "the thrash is new information even though the stall is not");
    assert.ok(f.sent[1]?.details.kinds.includes("thrash"));
    // And it does not re-announce the stall it already steered on.
    assert.deepEqual(
      f.sent[1]?.details.episodes.filter((k) => f.sent[0]?.details.episodes.includes(k)),
      f.sent[0]?.details.episodes,
      "the stall episode is carried forward, not re-opened",
    );
  } finally {
    cleanup(dir);
  }
});

// ------------------------------------------------------------- staying out of the way

test("a tool result from anything else is ignored — no scorer runs, no directive", async () => {
  const dir = fixture();
  try {
    let called = 0;
    const f = fakePi(dir);
    installSupervisor(f.pi, deps({ supervise: async () => { called++; return null as unknown as Supervision; } }).deps);
    await f.emit("session_start", { type: "session_start" } as SessionStartEvent);
    for (const name of ["bash", "read", "edit", "avo_lineage", "avo_fan", "avo_know_query"]) await f.toolResult(name);
    assert.equal(called, 0);
    assert.deepEqual(f.status, []);
    assert.equal(f.sent.length, 0);
  } finally {
    cleanup(dir);
  }
});

test("a supervisor that cannot read the log warns and lets the session carry on", async () => {
  const dir = fixture();
  try {
    const f = fakePi(dir);
    installSupervisor(
      f.pi,
      deps({
        supervise: async () => {
          throw new Error("git exploded");
        },
      }).deps,
    );
    await f.emit("session_start", { type: "session_start" } as SessionStartEvent);
    await f.toolResult("avo_score");
    assert.equal(f.sent.length, 0);
    assert.equal(f.notices.at(-1)?.type, "warning");
    assert.match(f.notices.at(-1)?.message ?? "", /git exploded/);
  } finally {
    cleanup(dir);
  }
});

test("a memory backend that fails costs a warning, never the directive", async () => {
  const dir = fixture();
  try {
    const f = fakePi(dir);
    installSupervisor(
      f.pi,
      deps({
        record: async () => {
          throw new Error("bd is not on PATH");
        },
      }).deps,
    );
    await f.emit("session_start", { type: "session_start" } as SessionStartEvent);
    await f.toolResult("avo_commit", { details: await landV1(dir) });
    for (let i = 0; i < STALL + 1; i++) {
      writeFileSync(join(dir, "impl.sh"), `${"# padding\n".repeat(i + 1)}echo 42\n`);
      await score(dir);
      await f.toolResult("avo_score");
    }
    assert.equal(f.sent.length, 1, "the steer still happens");
    assert.equal(f.sent[0]?.details.intervention, null);
    assert.ok(f.notices.some((n) => n.type === "warning" && /bd is not on PATH/.test(n.message)));
  } finally {
    cleanup(dir);
  }
});

test("shutdown clears the footer and stops a late tool result from steering", async () => {
  const dir = fixture();
  try {
    // Pre-stall the log so a single tool result would otherwise be enough to steer.
    appendFileSync(
      join(dir, ATTEMPTS_PATH),
      `${JSON.stringify({
        ts: "2026-08-25T00:00:00.000Z",
        ok: true,
        correct: true,
        pass: true,
        primary: 8,
        normalized: -8,
        unit: "bytes",
        higher_is_better: false,
        scores: { "*": -8 },
        duration_s: 0,
        configs: ["*"],
        parallel: false,
        errors: [],
        warnings: [],
        log: null,
        exit_code: 0,
        git: { head: null, dirty: false },
      } satisfies Attempt)}\n`.repeat(STALL + 1),
    );
    const f = fakePi(dir);
    installSupervisor(f.pi, deps().deps);
    await f.emit("session_start", { type: "session_start" } as SessionStartEvent);
    await f.emit("session_shutdown", { type: "session_shutdown", reason: "quit" } as SessionShutdownEvent);
    assert.deepEqual(f.status, [undefined], "the footer slot is released, not left stale");
    await f.toolResult("avo_score");
    assert.equal(f.sent.length, 0, "teardown means teardown");
  } finally {
    cleanup(dir);
  }
});

test("the footer updates on every watched result, whether or not anything fires", async () => {
  const dir = fixture();
  try {
    const f = fakePi(dir);
    installSupervisor(f.pi, deps().deps);
    await f.emit("session_start", { type: "session_start" } as SessionStartEvent);
    await score(dir);
    await f.toolResult("avo_score");
    assert.equal(f.status.length, 1);
    assert.match(f.status[0] ?? "", /since best/);
    assert.equal(f.sent.length, 0);
  } finally {
    cleanup(dir);
  }
});

test("a landed version is announced to the operator", async () => {
  const dir = fixture();
  try {
    const f = fakePi(dir);
    installSupervisor(f.pi, deps().deps);
    await f.emit("session_start", { type: "session_start" } as SessionStartEvent);
    await f.toolResult("avo_commit", { details: await landV1(dir) });
    assert.ok(f.notices.some((n) => n.type === "info" && /v1 is the new best/.test(n.message)));

    // A refusal is not an announcement: nothing landed.
    f.notices.length = 0;
    writeFileSync(join(dir, "impl.sh"), "# padding\necho 42\n");
    const refused = await commit(dir, "make it bigger");
    assert.notEqual((refused.details as { action: string }).action, "committed");
    await f.toolResult("avo_commit", { details: refused.details });
    assert.equal(f.notices.filter((n) => /new best/.test(n.message)).length, 0);
  } finally {
    cleanup(dir);
  }
});
