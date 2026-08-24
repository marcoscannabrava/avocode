import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bufferIo } from "../src/io.ts";
import { commitCommand } from "../src/lineage.ts";
import {
  MEMORY_KINDS,
  beadId,
  listMemories,
  MEMORY_PATH,
  memCommand,
  parseMemArgs,
  probeBd,
  readMemoryFile,
  remember,
  renderPrime,
  resolveBackend,
  slugKey,
} from "../src/mem.ts";
import type { RunOpts, Runner, RunResult } from "../src/score.ts";

const NOW = () => new Date("2026-08-24T12:00:00.000Z");

interface Call {
  cmd: string;
  args: string[];
}

/** A runner that answers a script of commands and records every call, so we can assert the argv. */
function stub(answers: Record<string, Partial<RunResult>>): Runner & { calls: Call[] } {
  const calls: Call[] = [];
  const runner = (cmd: string, args: readonly string[], _opts: RunOpts): Promise<RunResult> => {
    calls.push({ cmd, args: [...args] });
    const key = [cmd, ...args].join(" ");
    const match = Object.keys(answers).find((k) => key.startsWith(k));
    const answer = match === undefined ? {} : (answers[match] as Partial<RunResult>);
    return Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: false, spawnError: null, ...answer });
  };
  return Object.assign(runner, { calls });
}

const NO_BD = { "bd context": { code: -1, spawnError: "spawn bd ENOENT" } };
const BD_READY = { "bd context": { stdout: JSON.stringify({ database: "proj", bd_version: "1.2.2" }) } };

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "avo-mem-"));
}

// ------------------------------------------------------------------ pure parts

test("slugKey turns an insight into a stable, bounded key", () => {
  assert.equal(slugKey("Shared memory beats registers here!"), "shared-memory-beats-registers-here");
  assert.equal(slugKey("a b c d e f g h i j"), "a-b-c-d-e-f-g-h");
  assert.equal(slugKey("!!!").length, 8); // no letters left: falls back to a content hash
  assert.equal(slugKey("x", "avo"), "avo-x");
  assert.equal(slugKey("Same text"), slugKey("same text"));
});

test("beadId is deterministic: a version maps to one bead, a dead end to one per content", () => {
  assert.equal(beadId("proj", { kind: "version", text: "v3", version: 3 }), "proj-v3");
  const a = beadId("proj", { kind: "failure", text: "regressed on b1" });
  assert.equal(a, beadId("proj", { kind: "failure", text: "regressed on b1" }));
  assert.notEqual(a, beadId("proj", { kind: "failure", text: "regressed on b8" }));
  assert.match(a, /^proj-x[0-9a-f]{8}$/);
});

test("parseMemArgs understands the three shapes and rejects the rest", () => {
  assert.deepEqual((parseMemArgs([]) as { sub: string }).sub, "list");
  assert.deepEqual((parseMemArgs(["prime"]) as { sub: string }).sub, "prime");
  const add = parseMemArgs(["add", "shared", "memory", "wins", "--key", "k"]);
  assert.deepEqual(add, { json: false, cwd: process.cwd(), sub: "add", key: "k", args: ["shared", "memory", "wins"] });
  assert.match((parseMemArgs(["add"]) as { error: string }).error, /needs the insight/);
  assert.match((parseMemArgs(["--nope"]) as { error: string }).error, /unknown option/);
  assert.match((parseMemArgs(["--key", "k"]) as { error: string }).error, /only applies to/);
  assert.match((parseMemArgs(["bogus"]) as { error: string }).error, /unknown argument/);
  assert.match((parseMemArgs(["--cwd"]) as { error: string }).error, /needs a value/);
});

test("renderPrime groups what was learned and calls dead ends what they are", () => {
  const out = renderPrime([
    { ts: "", kind: "insight", key: "k1", text: "shared memory wins", version: null, bead: null, parent: null },
    { ts: "", kind: "failure", key: "k2", text: "regressed on b1", version: 2, bead: null, parent: null },
  ]);
  assert.match(out, /## insights \(1\)/);
  assert.match(out, /do not re-try these/);
  assert.match(out, /regressed on b1/);
  assert.match(renderPrime([]), /nothing remembered yet/);
});

// ------------------------------------------------------- the fallback backend
// bd is an optional dependency, so this is the common path, not the exceptional one.

test("probeBd reports a missing binary as not-installed, and a missing database as run-avo-init", async () => {
  const missing = await probeBd(stub(NO_BD), "/tmp");
  assert.equal(missing.available, false);
  assert.match(missing.reason ?? "", /not installed/);

  const uninitialized = await probeBd(
    stub({ "bd context": { code: 1, stdout: JSON.stringify({ error: "no .beads directory found" }) } }),
    "/tmp",
  );
  assert.equal(uninitialized.available, false);
  assert.match(uninitialized.reason ?? "", /no beads database.*avo init/s);

  const ready = await probeBd(stub(BD_READY), "/tmp");
  assert.deepEqual(ready, { available: true, reason: null, prefix: "proj", version: "1.2.2" });
});

test("a memory written without bd lands in lineage/memory.jsonl and reads back", async () => {
  const cwd = scratch();
  try {
    const backend = await resolveBackend(stub(NO_BD), cwd);
    assert.equal(backend.kind, "file");
    assert.equal(backend.warnings.length, 1);
    assert.match(backend.warnings[0] ?? "", /falls back to lineage\/memory\.jsonl/);

    const w = await remember(stub(NO_BD), cwd, backend, { kind: "insight", text: "shared memory wins" }, NOW);
    assert.deepEqual(
      { ok: w.ok, backend: w.backend, key: w.key, bead: w.bead, error: w.error },
      { ok: true, backend: "file", key: "shared-memory-wins", bead: null, error: null },
    );
    const { memories } = readMemoryFile(cwd);
    assert.deepEqual(memories, [
      {
        ts: "2026-08-24T12:00:00.000Z",
        kind: "insight",
        key: "shared-memory-wins",
        text: "shared memory wins",
        version: null,
        bead: null,
        parent: null,
      },
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the fallback store is append-only and last-write-wins per key", async () => {
  const cwd = scratch();
  try {
    const runner = stub(NO_BD);
    const backend = await resolveBackend(runner, cwd);
    await remember(runner, cwd, backend, { kind: "insight", text: "first", key: "k" }, NOW);
    await remember(runner, cwd, backend, { kind: "insight", text: "second", key: "k" }, NOW);
    const raw = readFileSync(join(cwd, MEMORY_PATH), "utf8").trim().split("\n");
    assert.equal(raw.length, 2, "both writes are kept on disk");
    const { memories } = readMemoryFile(cwd);
    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.text, "second");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a corrupt line in the fallback store is skipped with a warning, never a crash", () => {
  const cwd = scratch();
  try {
    const good = JSON.stringify({ kind: "insight", key: "k", text: "kept" });
    mkdirSync(join(cwd, "lineage"), { recursive: true });
    writeFileSync(join(cwd, MEMORY_PATH), `not json\n${good}\n{"text":"no key"}\n`);
    const { memories, warnings } = readMemoryFile(cwd);
    assert.deepEqual(
      memories.map((m) => m.text),
      ["kept"],
    );
    assert.equal(warnings.length, 2);
    assert.match(warnings[0] ?? "", /memory\.jsonl:1 is not valid JSON/);
    assert.match(warnings[1] ?? "", /has no key\/text/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a missing fallback store is empty, not an error", () => {
  assert.deepEqual(readMemoryFile(join(tmpdir(), "avo-does-not-exist-9f2")), { memories: [], warnings: [] });
});

// ------------------------------------------------------------- the bd backend

test("an insight goes to bd remember with an explicit key, so re-writing it updates in place", async () => {
  const runner = stub(BD_READY);
  const backend = await resolveBackend(runner, "/tmp");
  assert.equal(backend.kind, "beads");
  assert.deepEqual(backend.warnings, []);
  const w = await remember(runner, "/tmp", backend, { kind: "insight", text: "shared memory wins" }, NOW);
  assert.deepEqual({ ok: w.ok, backend: w.backend, warnings: w.warnings }, { ok: true, backend: "beads", warnings: [] });
  assert.deepEqual(runner.calls.at(-1), {
    cmd: "bd",
    args: ["remember", "shared memory wins", "--key", "shared-memory-wins"],
  });
});

test("a committed version becomes a bead with a deterministic id, linked to its parent", async () => {
  const runner = stub({ ...BD_READY, "bd create": { stdout: "proj-v4\n" } });
  const backend = await resolveBackend(runner, "/tmp");
  const w = await remember(
    runner,
    "/tmp",
    backend,
    { kind: "version", key: "avo-v4", text: "avo v4: 8 bytes", version: 4, parentVersion: 3, detail: "score 8 bytes" },
    NOW,
  );
  assert.deepEqual({ ok: w.ok, bead: w.bead, parent: w.parent }, { ok: true, bead: "proj-v4", parent: "proj-v3" });
  assert.deepEqual(runner.calls[1], {
    cmd: "bd",
    args: [
      "create",
      "avo v4: 8 bytes",
      "--id",
      "proj-v4",
      "--silent",
      "--force",
      "-l",
      "avo,avo-version",
      "-d",
      "score 8 bytes",
      "-t",
      "task",
    ],
  });
  // `bd dep add <child> <parent>`: v4 depends on v3, which is the lineage edge.
  assert.deepEqual(runner.calls[2], { cmd: "bd", args: ["dep", "add", "proj-v4", "proj-v3"] });
});

test("a failed bd write degrades to the file store with one warning, and still reports ok", async () => {
  const cwd = scratch();
  try {
    const runner = stub({ ...BD_READY, "bd remember": { code: 1, stderr: "database is locked" } });
    const backend = await resolveBackend(runner, cwd);
    const w = await remember(runner, cwd, backend, { kind: "insight", text: "still learned this" }, NOW);
    assert.equal(w.ok, true);
    assert.equal(w.backend, "file");
    assert.deepEqual(w.warnings, ["bd remember failed (database is locked); using lineage/memory.jsonl"]);
    assert.equal(readMemoryFile(cwd).memories[0]?.text, "still learned this");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a failed dep add costs the edge, not the bead", async () => {
  const runner = stub({ ...BD_READY, "bd create": { stdout: "proj-v2\n" }, "bd dep add": { code: 1, stderr: "no such issue: proj-v1" } });
  const backend = await resolveBackend(runner, "/tmp");
  const w = await remember(runner, "/tmp", backend, { kind: "version", text: "avo v2", version: 2, parentVersion: 1 }, NOW);
  assert.deepEqual({ ok: w.ok, bead: w.bead, parent: w.parent }, { ok: true, bead: "proj-v2", parent: null });
  assert.match(w.warnings[0] ?? "", /bd dep add proj-v2 proj-v1 failed/);
});

test("listMemories reads bd, then adds anything the file store holds from a bd-less session", async () => {
  const cwd = scratch();
  try {
    const noBd = stub(NO_BD);
    await remember(noBd, cwd, await resolveBackend(noBd, cwd), { kind: "insight", text: "learned offline" }, NOW);
    const runner = stub({
      ...BD_READY,
      "bd --json memories": { stdout: JSON.stringify({ "in-beads": "learned online", schema_version: 1 }) },
    });
    const backend = await resolveBackend(runner, cwd);
    const { memories } = await listMemories(runner, cwd, backend);
    assert.deepEqual(
      memories.map((m) => m.text),
      ["learned online", "learned offline"],
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ the mem command

test("avo mem add then avo mem shows the insight (the slice's acceptance case)", async () => {
  const cwd = scratch();
  try {
    const runner = stub(NO_BD);
    const add = bufferIo();
    assert.equal(await memCommand(["add", "shared", "memory", "beats", "registers", "--cwd", cwd], add, runner, NOW), 0);
    assert.match(add.stdout, /remembered \[shared-memory-beats-registers\] via file/);
    assert.match(add.stderr, /warning: bd is not installed/);

    const list = bufferIo();
    assert.equal(await memCommand(["--cwd", cwd], list, runner, NOW), 0);
    assert.match(list.stdout, /shared memory beats registers/);
    assert.match(list.stdout, /1 memory via file/);

    const json = bufferIo();
    assert.equal(await memCommand(["--json", "--cwd", cwd], json, runner, NOW), 0);
    const parsed = JSON.parse(json.stdout) as { backend: string; memories: { text: string }[]; warnings: string[] };
    assert.equal(parsed.backend, "file");
    assert.equal(parsed.memories[0]?.text, "shared memory beats registers");
    assert.equal(parsed.warnings.length, 1, "the degradation is warned about exactly once");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("avo mem prime renders our own digest without bd, and passes bd prime through with it", async () => {
  const cwd = scratch();
  try {
    const noBd = stub(NO_BD);
    await memCommand(["add", "shared memory wins", "--cwd", cwd], bufferIo(), noBd, NOW);
    const own = bufferIo();
    assert.equal(await memCommand(["prime", "--cwd", cwd], own, noBd, NOW), 0);
    assert.match(own.stdout, /# avo memory/);
    assert.match(own.stdout, /shared memory wins/);

    const bd = stub({ ...BD_READY, "bd prime": { stdout: "# beads context\n" } });
    const passthrough = bufferIo();
    assert.equal(await memCommand(["prime", "--cwd", cwd], passthrough, bd, NOW), 0);
    assert.equal(passthrough.stdout, "# beads context\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("avo mem exits 2 on a usage error", async () => {
  const io = bufferIo();
  assert.equal(await memCommand(["add"], io, stub(NO_BD), NOW), 2);
  assert.match(io.stderr, /needs the insight/);
});

// ------------------------------------ what avo commit records, without a bd
// The lineage is the source of truth; memory is a cache of *why*. A commit must never fail because
// a memory write did.

const SCORER = (metric: number): string => `#!/bin/sh
printf '{"ok":true,"correct":true,"primary":%s,"unit":"bytes","higher_is_better":false}\\n' ${metric}
`;

function fixture(): string {
  const cwd = mkdtempSync(join(tmpdir(), "avo-memcommit-"));
  const run = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "avo@example.com");
  run("config", "user.name", "avo");
  writeFileSync(join(cwd, "impl.txt"), "aaaa\n");
  mkdirSync(join(cwd, ".avo"), { recursive: true });
  writeFileSync(join(cwd, ".avo/score"), SCORER(5), { mode: 0o755 });
  run("add", "-A");
  run("commit", "-q", "-m", "seed");
  return cwd;
}

test("a committed version is remembered with its parent, and a refusal is remembered as a dead end", async () => {
  const cwd = fixture();
  try {
    // bd is absent, so every memory lands in the file store.
    writeFileSync(join(cwd, "impl.txt"), "aaa\n");
    writeFileSync(join(cwd, ".avo/score"), SCORER(3), { mode: 0o755 });
    assert.equal(await commitCommand(["--cwd", cwd, "--why", "dropped a byte"], bufferIo()), 0);
    let mem = readMemoryFile(cwd).memories;
    assert.equal(mem.length, 1);
    assert.deepEqual(
      { kind: mem[0]?.kind, key: mem[0]?.key, version: mem[0]?.version, parent: mem[0]?.parent },
      { kind: "version", key: "avo-v1", version: 1, parent: null },
    );

    writeFileSync(join(cwd, ".avo/score"), SCORER(2), { mode: 0o755 });
    assert.equal(await commitCommand(["--cwd", cwd], bufferIo()), 0);
    mem = readMemoryFile(cwd).memories;
    assert.equal(mem.length, 2);
    assert.deepEqual({ key: mem[1]?.key, parent: mem[1]?.parent }, { key: "avo-v2", parent: "v1" });

    // A regression: refused, and remembered as a dead end so it is not re-tried.
    writeFileSync(join(cwd, ".avo/score"), SCORER(9), { mode: 0o755 });
    assert.equal(await commitCommand(["--cwd", cwd], bufferIo()), 1);
    const dead = readMemoryFile(cwd).memories.filter((m) => m.kind === "failure");
    assert.equal(dead.length, 1);
    assert.match(dead[0]?.key ?? "", /^avo-dead-end-[0-9a-f]{8}$/);
    assert.match(dead[0]?.text ?? "", /dead end from v2/);

    // Re-attempting the same dead end updates one record instead of piling up.
    assert.equal(await commitCommand(["--cwd", cwd], bufferIo()), 1);
    assert.equal(readMemoryFile(cwd).memories.filter((m) => m.kind === "failure").length, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the memory written for a version does not make the next run look like a new candidate", async () => {
  const cwd = fixture();
  try {
    writeFileSync(join(cwd, ".avo/score"), SCORER(3), { mode: 0o755 });
    const first = bufferIo();
    assert.equal(await commitCommand(["--cwd", cwd, "--json"], first), 0);
    assert.equal((JSON.parse(first.stdout) as { action: string }).action, "committed");
    assert.equal(readMemoryFile(cwd).memories.length, 1);

    // Nothing but avo's own writes changed, so this must be a no-op — not a scored candidate that
    // gets refused for not improving, and not a second memory.
    const second = bufferIo();
    assert.equal(await commitCommand(["--cwd", cwd, "--json"], second), 0);
    assert.equal((JSON.parse(second.stdout) as { action: string }).action, "noop");
    assert.equal(readMemoryFile(cwd).memories.length, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("--dry-run and --no-record write no memory at all", async () => {
  const cwd = fixture();
  try {
    writeFileSync(join(cwd, ".avo/score"), SCORER(3), { mode: 0o755 });
    assert.equal(await commitCommand(["--cwd", cwd, "--dry-run"], bufferIo()), 0);
    assert.equal(existsSync(join(cwd, MEMORY_PATH)), false);
    assert.equal(await commitCommand(["--cwd", cwd, "--no-record"], bufferIo()), 0);
    assert.equal(existsSync(join(cwd, MEMORY_PATH)), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a no-op commit and a harness error record nothing: there is no candidate to learn from", async () => {
  const cwd = fixture();
  try {
    // Clean tree: no-op.
    assert.equal(await commitCommand(["--cwd", cwd], bufferIo()), 0);
    assert.equal(existsSync(join(cwd, MEMORY_PATH)), false);
    // A scorer that prints nothing usable is a harness error, not a dead end.
    writeFileSync(join(cwd, "impl.txt"), "aa\n");
    writeFileSync(join(cwd, ".avo/score"), "#!/bin/sh\necho broken\n", { mode: 0o755 });
    assert.equal(await commitCommand(["--cwd", cwd], bufferIo()), 2);
    assert.equal(existsSync(join(cwd, MEMORY_PATH)), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the memory log is trajectory-adjacent but lives in lineage/, so it is committed with the version", async () => {
  const cwd = fixture();
  try {
    writeFileSync(join(cwd, ".avo/score"), SCORER(3), { mode: 0o755 });
    assert.equal(await commitCommand(["--cwd", cwd], bufferIo()), 0);
    const tracked = execFileSync("git", ["ls-files", "lineage"], { cwd, encoding: "utf8" });
    assert.match(tracked, /lineage\/v001\.md/);
    // The memory written *for* v1 arrives after its commit, so it is staged with the next one.
    assert.equal(existsSync(join(cwd, MEMORY_PATH)), true);
    writeFileSync(join(cwd, ".avo/score"), SCORER(2), { mode: 0o755 });
    assert.equal(await commitCommand(["--cwd", cwd], bufferIo()), 0);
    assert.match(execFileSync("git", ["ls-files", "lineage"], { cwd, encoding: "utf8" }), /lineage\/memory\.jsonl/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a memory kind added later is not silently read back as an insight", () => {
  const dir = mkdtempSync(join(tmpdir(), "avo-kinds-"));
  mkdirSync(join(dir, "lineage"), { recursive: true });
  // The kind whitelist used to be written out inline, so `intervention` — added in S7b — read back
  // as `insight`, which put a whole previous steering directive into the next one's citations.
  const lines = MEMORY_KINDS.map((kind, i) =>
    JSON.stringify({ ts: "2026-08-24T00:00:00.000Z", kind, key: `k${i}`, text: `a ${kind}`, version: null, bead: null, parent: null }),
  );
  writeFileSync(join(dir, "lineage/memory.jsonl"), `${lines.join("\n")}\n`);
  const { memories } = readMemoryFile(dir);
  assert.deepEqual(memories.map((m) => m.kind).sort(), [...MEMORY_KINDS].sort());
});

test("a kind we have never heard of still reads as an insight rather than corrupting the store", () => {
  const dir = mkdtempSync(join(tmpdir(), "avo-kinds2-"));
  mkdirSync(join(dir, "lineage"), { recursive: true });
  writeFileSync(
    join(dir, "lineage/memory.jsonl"),
    `${JSON.stringify({ kind: "prophecy", key: "k", text: "t" })}\n`,
  );
  assert.equal(readMemoryFile(dir).memories[0]?.kind, "insight");
});
