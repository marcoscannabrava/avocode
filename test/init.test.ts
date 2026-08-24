import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONFIG_PATH, loadConfig } from "../src/config.ts";
import { initCommand, parseInitArgs, renderInit, runInit, type InitResult } from "../src/init.ts";
import { bufferIo } from "../src/io.ts";
import type { RunOpts, Runner, RunResult } from "../src/score.ts";

interface Call {
  cmd: string;
  args: string[];
}

/** Real git (init writes nothing to it), stubbed bd — the dependency we cannot assume exists. */
function runnerWith(bd: Record<string, Partial<RunResult>>): Runner & { calls: Call[] } {
  const calls: Call[] = [];
  const runner = async (cmd: string, args: readonly string[], opts: RunOpts): Promise<RunResult> => {
    calls.push({ cmd, args: [...args] });
    if (cmd === "bd") {
      const key = [cmd, ...args].join(" ");
      const match = Object.keys(bd).find((k) => key.startsWith(k));
      const answer = match === undefined ? {} : (bd[match] as Partial<RunResult>);
      return { code: 0, stdout: "", stderr: "", timedOut: false, spawnError: null, ...answer };
    }
    const { spawnRunner } = await import("../src/score.ts");
    return await spawnRunner(cmd, args, opts);
  };
  return Object.assign(runner, { calls });
}

const NO_BD = { bd: { code: -1, spawnError: "spawn bd ENOENT" } };

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "avo-init-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
  return cwd;
}

function step(r: InitResult, name: string): { action: string; detail: string } {
  const found = r.steps.find((s) => s.name === name);
  assert.ok(found !== undefined, `no step '${name}' in ${r.steps.map((s) => s.name).join(", ")}`);
  return found;
}

test("parseInitArgs takes the three options and rejects anything else", () => {
  assert.deepEqual(parseInitArgs(["--json"]), { json: true, cwd: process.cwd(), prefix: null, scorer: null });
  assert.deepEqual(parseInitArgs(["--prefix", "k", "--scorer", "vitest", "--cwd", "/x"]), {
    json: false,
    cwd: "/x",
    prefix: "k",
    scorer: "vitest",
  });
  assert.match((parseInitArgs(["--prefix"]) as { error: string }).error, /needs a value/);
  assert.match((parseInitArgs(["nope"]) as { error: string }).error, /unknown option/);
});

test("avo init outside a git repository fails, because the lineage lives in git", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "avo-nogit-"));
  try {
    const io = bufferIo();
    assert.equal(await initCommand(["--cwd", cwd], io, runnerWith(NO_BD)), 2);
    assert.match(io.stderr, /not a git repository/);
    assert.equal(existsSync(join(cwd, ".avo")), false, "nothing is scaffolded into a non-repo");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("avo init scaffolds the config, the gitignore and lineage/, and is a no-op the second time", async () => {
  const cwd = repo();
  try {
    const first = await runInit({ json: false, cwd, prefix: null, scorer: null }, runnerWith(NO_BD));
    assert.equal(first.ok, true);
    assert.equal(step(first, CONFIG_PATH).action, "created");
    assert.equal(step(first, ".avo/.gitignore").action, "created");
    assert.equal(step(first, "lineage/").action, "created");
    assert.equal(step(first, ".avo/score").action, "skipped");
    assert.equal(step(first, "beads").action, "skipped");
    assert.match(step(first, "beads").detail, /not installed.*memory\.jsonl/);
    assert.equal(first.warnings.length, 1);

    // The scaffolded config must load as the defaults it claims to be.
    const { config, warnings, present } = loadConfig(cwd);
    assert.deepEqual({ present, warnings }, { present: true, warnings: [] });
    assert.deepEqual(config, { reduce: "dominate", floor: 0, weights: {}, configs: null });

    const before = readFileSync(join(cwd, CONFIG_PATH), "utf8");
    writeFileSync(join(cwd, CONFIG_PATH), JSON.stringify({ reduce: "mean", floor: 0.02 }));
    const second = await runInit({ json: false, cwd, prefix: null, scorer: null }, runnerWith(NO_BD));
    assert.equal(second.ok, true);
    for (const name of [CONFIG_PATH, ".avo/.gitignore", "lineage/"]) {
      assert.equal(step(second, name).action, "unchanged", `${name} is rewritten on a second run`);
    }
    assert.notEqual(readFileSync(join(cwd, CONFIG_PATH), "utf8"), before, "an edited config is left alone");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("avo init --scorer scaffolds f, and reports an existing scorer as unchanged", async () => {
  const cwd = repo();
  try {
    const r = await runInit({ json: false, cwd, prefix: null, scorer: "vitest" }, runnerWith(NO_BD));
    assert.equal(r.ok, true);
    assert.equal(step(r, ".avo/score").action, "created");
    const again = await runInit({ json: false, cwd, prefix: null, scorer: null }, runnerWith(NO_BD));
    assert.equal(step(again, ".avo/score").action, "unchanged");

    const bad = await runInit({ json: false, cwd, prefix: null, scorer: "nope" }, runnerWith(NO_BD));
    assert.equal(bad.ok, false);
    assert.match(bad.errors[0] ?? "", /unknown template 'nope'/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("with bd installed, avo init initializes beads once and leaves AGENTS.md and hooks alone", async () => {
  const cwd = repo();
  try {
    // First run: bd is installed but this repo has no database.
    const runner = runnerWith({
      "bd context": { code: 1, stdout: JSON.stringify({ error: "no .beads directory found" }) },
      "bd --version": { stdout: "bd version 1.2.2\n" },
      "bd init": { stdout: "" },
    });
    const r = await runInit({ json: false, cwd, prefix: "proj", scorer: null }, runner);
    assert.equal(r.ok, true);
    const init = runner.calls.find((c) => c.args[0] === "init");
    assert.deepEqual(init?.args, [
      "init",
      "--non-interactive",
      "--init-if-missing",
      "--skip-agents",
      "--skip-hooks",
      "-q",
      "--prefix",
      "proj",
    ]);
    assert.equal(step(r, "beads").action, "created");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an already-initialized beads database is reported, not re-initialized", async () => {
  const cwd = repo();
  try {
    const runner = runnerWith({ "bd context": { stdout: JSON.stringify({ database: "proj", bd_version: "1.2.2" }) } });
    const r = await runInit({ json: false, cwd, prefix: null, scorer: null }, runner);
    assert.equal(step(r, "beads").action, "unchanged");
    assert.match(step(r, "beads").detail, /prefix 'proj'/);
    assert.equal(runner.calls.some((c) => c.cmd === "bd" && c.args[0] === "init"), false);
    assert.deepEqual(r.warnings, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a failing bd init degrades to the file store instead of failing init", async () => {
  const cwd = repo();
  try {
    const runner = runnerWith({
      "bd context": { code: 1, stdout: "{}" },
      "bd --version": { stdout: "bd version 1.2.2\n" },
      "bd init": { code: 1, stderr: "dolt: port already in use\n" },
    });
    const r = await runInit({ json: false, cwd, prefix: null, scorer: null }, runner);
    assert.equal(r.ok, true, "beads is optional: its failure must not fail init");
    assert.equal(step(r, "beads").action, "skipped");
    assert.match(r.warnings[0] ?? "", /bd init failed \(dolt: port already in use\).*memory\.jsonl/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("avo init --json reports every step, and the pretty form names them all", async () => {
  const cwd = repo();
  try {
    const io = bufferIo();
    assert.equal(await initCommand(["--cwd", cwd, "--json"], io, runnerWith(NO_BD)), 0);
    const parsed = JSON.parse(io.stdout) as InitResult;
    assert.equal(parsed.ok, true);
    assert.deepEqual(
      parsed.steps.map((s) => s.name),
      ["git", ".avo/.gitignore", CONFIG_PATH, "lineage/", ".avo/score", "beads"],
    );
    const pretty = renderInit(parsed);
    assert.match(pretty, /created\s+\.avo\/config\.json/);
    assert.match(pretty, /ready — /);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
