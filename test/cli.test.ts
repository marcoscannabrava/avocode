import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commandUsage, main, USAGE } from "../src/cli.ts";
import { bufferIo } from "../src/io.ts";
import { VERSION } from "../src/version.ts";

test("no args and help flags print usage and exit 0", async () => {
  for (const argv of [[], ["help"], ["-h"], ["--help"]]) {
    const io = bufferIo();
    assert.equal(await main(argv, io), 0, `argv=${JSON.stringify(argv)}`);
    assert.equal(io.stdout, USAGE);
    assert.equal(io.stderr, "");
  }
});

test("version flags print the package version and exit 0", async () => {
  for (const argv of [["version"], ["-v"], ["--version"]]) {
    const io = bufferIo();
    assert.equal(await main(argv, io), 0);
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

test("unknown command exits 2 with usage on stderr", async () => {
  const io = bufferIo();
  assert.equal(await main(["frobnicate"], io), 2);
  assert.equal(io.stdout, "");
  assert.match(io.stderr, /unknown command 'frobnicate'/);
  assert.ok(io.stderr.includes(USAGE));
});

test("usage documents every dispatchable command", () => {
  for (const cmd of ["doctor", "score", "version", "help"]) assert.ok(USAGE.includes(cmd), `usage omits ${cmd}`);
});

test("doctor is reachable through the dispatcher", async () => {
  const io = bufferIo();
  const code = await main(["doctor", "--json"], io);
  assert.ok(code === 0 || code === 1, `doctor returned ${code}`);
  const report = JSON.parse(io.stdout) as { deps: unknown[] };
  assert.ok(report.deps.length > 0);
});

test("score is reachable through the dispatcher and reports a missing scorer", async () => {
  const io = bufferIo();
  const dir = mkdtempSync(join(tmpdir(), "avo-cli-"));
  try {
    assert.equal(await main(["score", "--cwd", dir], io), 2);
    assert.match(io.stderr, /no executable \.avo\/score/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every subcommand in the usage text is actually dispatched", async () => {
  const block = USAGE.split("commands:\n")[1]?.split("\n\n")[0] ?? "";
  const documented = [...block.matchAll(/^ {2}([a-z]+)/gm)].map((m) => m[1] as string);
  assert.ok(documented.length >= 6, `parsed ${documented.length} commands from usage`);
  assert.ok(documented.includes("commit") && documented.includes("lineage") && documented.includes("best"));
  const dir = mkdtempSync(join(tmpdir(), "avo-cli-"));
  for (const cmd of new Set(documented)) {
    const io = bufferIo();
    // No repo and no scorer here, so these fail — but they must fail as themselves, never as
    // "unknown command", which is the only thing this asserts.
    await main([cmd, "--cwd", dir], io);
    assert.doesNotMatch(io.stderr, /unknown command/, `'${cmd}' is documented but not dispatched`);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("every subcommand answers --help and -h with its own stanza (#50)", async () => {
  const block = USAGE.split("commands:\n")[1]?.split("\n\n")[0] ?? "";
  const documented = [...block.matchAll(/^ {2}([a-z]+)/gm)].map((m) => m[1] as string);
  const commands = documented.filter((c) => c !== "version" && c !== "help");
  assert.ok(commands.length >= 12, `parsed ${commands.length} commands`);
  for (const cmd of commands) {
    for (const argv of [[cmd, "--help"], [cmd, "-h"], [cmd, "--json", "--help"], ["help", cmd]]) {
      const io = bufferIo();
      assert.equal(await main(argv, io), 0, `${argv.join(" ")} exit code; stderr=${io.stderr}`);
      assert.ok(io.stdout.startsWith(`avo ${cmd}:\n`), `${argv.join(" ")} printed no '${cmd}:' stanza`);
      assert.equal(io.stdout, commandUsage(cmd));
      assert.equal(io.stderr, "");
    }
  }
});

test("avo run --help names every flag it parses", () => {
  const src = readFileSync(new URL("../src/run.ts", import.meta.url), "utf8");
  const from = src.indexOf("export function parseRunArgs");
  const body = src.slice(from, src.indexOf("return opts;", from));
  const flags = new Set([...body.matchAll(/"(--[a-z-]+)"/g)].map((m) => m[1] as string));
  assert.ok(flags.has("--max-wall"), `parsed ${[...flags].join(" ")}`);
  const stanza = commandUsage("run") ?? "";
  for (const f of flags) assert.ok(stanza.includes(f), `avo run --help omits ${f}`);
});

test("avo help names an unknown topic and exits 2", async () => {
  const io = bufferIo();
  assert.equal(await main(["help", "frobnicate"], io), 2);
  assert.match(io.stderr, /no help for 'frobnicate'/);
});
