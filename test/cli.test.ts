import assert from "node:assert/strict";
import test from "node:test";
import { main, USAGE } from "../src/cli.ts";
import { bufferIo } from "../src/io.ts";
import { VERSION } from "../src/version.ts";

test("no args and help flags print usage and exit 0", () => {
  for (const argv of [[], ["help"], ["-h"], ["--help"]]) {
    const io = bufferIo();
    assert.equal(main(argv, io), 0, `argv=${JSON.stringify(argv)}`);
    assert.equal(io.stdout, USAGE);
    assert.equal(io.stderr, "");
  }
});

test("version flags print the package version and exit 0", () => {
  for (const argv of [["version"], ["-v"], ["--version"]]) {
    const io = bufferIo();
    assert.equal(main(argv, io), 0);
    assert.equal(io.stdout, `${VERSION}\n`);
  }
});

test("VERSION is semver and matches package.json", async () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
  const pkg = JSON.parse(await (await import("node:fs/promises")).readFile("package.json", "utf8")) as {
    version: string;
  };
  assert.equal(VERSION, pkg.version);
});

test("unknown command exits 2 with usage on stderr", () => {
  const io = bufferIo();
  assert.equal(main(["frobnicate"], io), 2);
  assert.equal(io.stdout, "");
  assert.match(io.stderr, /unknown command 'frobnicate'/);
  assert.ok(io.stderr.includes(USAGE));
});

test("usage documents every dispatchable command", () => {
  for (const cmd of ["doctor", "version", "help"]) assert.ok(USAGE.includes(cmd), `usage omits ${cmd}`);
});

test("doctor is reachable through the dispatcher", () => {
  const io = bufferIo();
  const code = main(["doctor", "--json"], io);
  assert.ok(code === 0 || code === 1, `doctor returned ${code}`);
  const report = JSON.parse(io.stdout) as { deps: unknown[] };
  assert.ok(report.deps.length > 0);
});
