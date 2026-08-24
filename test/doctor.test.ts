import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReport,
  DEPS,
  doctorCommand,
  parseDoctorArgs,
  renderReport,
  spawnProber,
  type DoctorReport,
  type Prober,
} from "../src/doctor.ts";
import { bufferIo } from "../src/io.ts";

/** Prober where only the named commands exist. */
const proberWith = (...present: string[]): Prober => (name) =>
  present.includes(name) ? { present: true, version: `${name} 1.0.0` } : { present: false, version: null };

const proberAll: Prober = (name) => ({ present: true, version: `${name} 1.0.0` });
const proberNone: Prober = () => ({ present: false, version: null });

test("everything present => ok with no problems", () => {
  const r = buildReport("0.0.0", proberAll, {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
  assert.equal(r.deps.length, DEPS.length);
});

test("optional deps missing does not make the report not-ok", () => {
  const r = buildReport("0.0.0", proberWith("git", "jq", "claude"), {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
  assert.equal(r.deps.find((d) => d.name === "qmd")?.present, false);
});

test("missing required dep => not ok, named in problems with install hint", () => {
  const r = buildReport("0.0.0", proberWith("git", "claude"), {});
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0] ?? "", /required dependency 'jq'/);
  assert.match(r.problems[0] ?? "", /install: /);
});

test("no agent at all => not ok with a single actionable problem", () => {
  const r = buildReport("0.0.0", proberWith("git", "jq"), {});
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0] ?? "", /no coding agent found/);
  for (const a of ["pi", "claude", "codex"]) assert.match(r.problems[0] ?? "", new RegExp(a));
});

test("one agent is enough", () => {
  for (const agent of ["pi", "claude", "codex"]) {
    const r = buildReport("0.0.0", proberWith("git", "jq", agent), {});
    assert.equal(r.ok, true, `${agent} alone should satisfy the agent requirement`);
  }
});

test("nothing installed => every required dep plus the agent group is reported", () => {
  const r = buildReport("0.0.0", proberNone, {});
  assert.equal(r.ok, false);
  // one problem per required dep, plus one for the agent group
  const required = DEPS.filter((d) => d.kind === "required").length;
  assert.equal(r.problems.length, required + 1);
});

test("keys report presence only, never values", () => {
  const secret = "sk-ant-do-not-leak-me";
  const r = buildReport("0.0.0", proberAll, { ANTHROPIC_API_KEY: secret, OPENAI_API_KEY: "" });
  assert.equal(r.keys.find((k) => k.name === "ANTHROPIC_API_KEY")?.set, true);
  assert.equal(r.keys.find((k) => k.name === "OPENAI_API_KEY")?.set, false, "empty string counts as unset");
  const serialized = JSON.stringify(r) + renderReport(r);
  assert.equal(serialized.includes(secret), false, "invariant 6: no key value in json or pretty output");
});

test("renderReport lists each problem for humans", () => {
  const r = buildReport("0.0.0", proberNone, {});
  const text = renderReport(r);
  assert.match(text, /not ok — \d+ problem\(s\)/);
  for (const p of r.problems) assert.ok(text.includes(p), `problem missing from render: ${p}`);
});

test("doctorCommand exits 0 when ok, 1 when not", () => {
  const okIo = bufferIo();
  assert.equal(doctorCommand([], okIo, "0.0.0", proberAll, {}), 0);
  assert.match(okIo.stdout, /^avo 0\.0\.0 — doctor/);

  const badIo = bufferIo();
  assert.equal(doctorCommand([], badIo, "0.0.0", proberNone, {}), 1);
  assert.match(badIo.stdout, /missing required dependency 'git'/);
});

test("doctorCommand --json emits one parseable line", () => {
  const io = bufferIo();
  assert.equal(doctorCommand(["--json"], io, "0.0.0", proberAll, {}), 0);
  assert.equal(io.stdout.trimEnd().includes("\n"), false, "must be a single line");
  const parsed = JSON.parse(io.stdout) as DoctorReport;
  assert.equal(parsed.ok, true);
  assert.equal(parsed.version, "0.0.0");
});

test("doctorCommand rejects unknown options with exit 2", () => {
  const io = bufferIo();
  assert.equal(doctorCommand(["--nope"], io, "0.0.0", proberAll, {}), 2);
  assert.match(io.stderr, /unknown option '--nope'/);
  assert.equal(io.stdout, "");
});

test("parseDoctorArgs", () => {
  assert.deepEqual(parseDoctorArgs([]), { json: false });
  assert.deepEqual(parseDoctorArgs(["--json"]), { json: true });
  assert.ok("error" in parseDoctorArgs(["-x"]));
});

test("spawnProber finds node and reports a version, and does not throw on a missing binary", () => {
  const found = spawnProber("node", ["--version"]);
  assert.equal(found.present, true);
  assert.match(found.version ?? "", /^v?\d+\./);

  const absent = spawnProber("avo-definitely-not-a-real-binary", ["--version"]);
  assert.deepEqual(absent, { present: false, version: null });
});
