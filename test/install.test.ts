import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AGENTS_FILE,
  BEGIN_MARKER,
  CLAUDE_SKILLS,
  END_MARKER,
  installCommand,
  linkState,
  linkTargetFor,
  mergePiSettings,
  parseInstallArgs,
  PI_DEFAULT_TOOLS,
  PI_EXTENSION,
  PI_EXTENSION_NAMES,
  PI_EXTENSION_SRC,
  piExtension,
  piExtensionSrc,
  PI_SETTINGS,
  renderAgentsBlock,
  renderInstall,
  runInstall,
  spliceBlock,
  type InstallOptions,
  type InstallResult,
} from "../src/install.ts";
import { bufferIo } from "../src/io.ts";
import { avocodeRoot, bundledSkillsDir, readSkills, SKILLS_DIR } from "../src/skills.ts";

function repo(): string {
  return mkdtempSync(join(tmpdir(), "avo-install-"));
}

function opts(cwd: string, over: Partial<InstallOptions> = {}): InstallOptions {
  return { json: false, cwd, agents: ["pi", "claude", "codex"], force: false, ...over };
}

function step(r: InstallResult, name: string) {
  return r.steps.find((s) => s.name === name);
}

// ---------------------------------------------------------------------------
// parseInstallArgs
// ---------------------------------------------------------------------------

test("parseInstallArgs defaults to every agent", () => {
  const r = parseInstallArgs([]);
  assert.ok(!("error" in r));
  assert.deepEqual(r.agents, ["pi", "claude", "codex"]);
  assert.equal(r.force, false);
  assert.equal(r.json, false);
});

test("parseInstallArgs takes --agent repeated, comma-separated, and 'all'", () => {
  for (const [argv, expected] of [
    [["--agent", "pi"], ["pi"]],
    [["--agent", "pi", "--agent", "codex"], ["pi", "codex"]],
    [["--agent", "codex,pi"], ["codex", "pi"]],
    [["--agent", "all"], ["pi", "claude", "codex"]],
    [["--agent", "pi", "--agent", "pi"], ["pi"]],
  ] as const) {
    const r = parseInstallArgs(argv);
    assert.ok(!("error" in r), `unexpected error for ${argv.join(" ")}`);
    assert.deepEqual(r.agents, expected, argv.join(" "));
  }
});

test("parseInstallArgs names the valid agents when given a bad one", () => {
  const r = parseInstallArgs(["--agent", "cursor"]);
  assert.ok("error" in r);
  assert.match(r.error, /unknown agent 'cursor' \(expected pi \| claude \| codex \| all\)/);
});

test("parseInstallArgs rejects a flag with a missing value and an unknown flag", () => {
  for (const [argv, pattern] of [
    [["--agent"], /--agent needs a value/],
    [["--cwd"], /--cwd needs a value/],
    [["--recursive"], /unknown option '--recursive'/],
  ] as const) {
    const r = parseInstallArgs(argv);
    assert.ok("error" in r);
    assert.match(r.error, pattern);
  }
});

test("parseInstallArgs builds options fresh per call", () => {
  // The S4 bug worth not repeating: a module-level default whose array is shared accumulates
  // arguments across calls, and the Pi extension makes many calls in one process.
  parseInstallArgs(["--agent", "pi", "--force", "--json"]);
  const second = parseInstallArgs([]);
  assert.ok(!("error" in second));
  assert.deepEqual(second.agents, ["pi", "claude", "codex"]);
  assert.equal(second.force, false);
  assert.equal(second.json, false);
});

// ---------------------------------------------------------------------------
// linkState / linkTargetFor
// ---------------------------------------------------------------------------

test("linkState distinguishes every way a path can be in the way", () => {
  const cwd = repo();
  try {
    mkdirSync(join(cwd, "target"));
    assert.equal(linkState(join(cwd, "link"), "target"), "absent");

    symlinkSync("target", join(cwd, "link"), "dir");
    assert.equal(linkState(join(cwd, "link"), "target"), "match");
    assert.equal(linkState(join(cwd, "link"), "elsewhere"), "other-link");

    // An absolute link to the same place is already correct: rewriting it would be churn.
    rmSync(join(cwd, "link"));
    symlinkSync(join(cwd, "target"), join(cwd, "link"), "dir");
    assert.equal(linkState(join(cwd, "link"), "target"), "match");

    mkdirSync(join(cwd, "realdir"));
    assert.equal(linkState(join(cwd, "realdir"), "target"), "directory");
    writeFileSync(join(cwd, "afile"), "x");
    assert.equal(linkState(join(cwd, "afile"), "target"), "file");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("linkState calls a dangling link replaceable rather than throwing", () => {
  const cwd = repo();
  try {
    symlinkSync("gone", join(cwd, "link"), "dir");
    assert.equal(linkState(join(cwd, "link"), "somewhere-else"), "other-link");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("linkTargetFor is relative inside the repo and absolute when it leaves", () => {
  const cwd = "/repo";
  assert.equal(linkTargetFor(cwd, "/repo/.claude", "/repo/.agents/skills"), "../.agents/skills");
  // Reaching out of the repo encodes the repo's own location, which breaks in a git worktree.
  assert.equal(linkTargetFor(cwd, "/repo/.agents/skills", "/opt/avocode/.agents/skills/avo-vary"), "/opt/avocode/.agents/skills/avo-vary");
});

// ---------------------------------------------------------------------------
// spliceBlock — AGENTS.md
// ---------------------------------------------------------------------------

test("spliceBlock creates, then reports the identical rewrite as unchanged", () => {
  const block = `${BEGIN_MARKER}\nrules\n${END_MARKER}`;
  const first = spliceBlock(null, block);
  assert.equal(first.action, "created");
  assert.equal(spliceBlock(first.text, block).action, "unchanged");
});

test("spliceBlock appends to an unmarked file and keeps every byte the human wrote", () => {
  const block = `${BEGIN_MARKER}\nrules\n${END_MARKER}`;
  const existing = "# Our rules\n\nAlways rebase.\n";
  const r = spliceBlock(existing, block);
  assert.equal(r.action, "appended");
  assert.ok(r.text.startsWith(existing));
  assert.ok(r.text.includes("Always rebase."));
  assert.equal(spliceBlock(r.text, block).action, "unchanged");
});

test("spliceBlock rewrites only between the markers", () => {
  const before = `head\n\n${BEGIN_MARKER}\nold rules\n${END_MARKER}\n\ntail\n`;
  const r = spliceBlock(before, `${BEGIN_MARKER}\nnew rules\n${END_MARKER}`);
  assert.equal(r.action, "updated");
  assert.ok(r.text.startsWith("head\n"));
  assert.ok(r.text.endsWith("tail\n"));
  assert.ok(r.text.includes("new rules"));
  assert.ok(!r.text.includes("old rules"));
});

test("spliceBlock appends rather than corrupting a file with markers in the wrong order", () => {
  const r = spliceBlock(`${END_MARKER}\nstuff\n${BEGIN_MARKER}\n`, `${BEGIN_MARKER}\nrules\n${END_MARKER}`);
  assert.equal(r.action, "appended");
  assert.ok(r.text.includes("stuff"));
});

test("renderAgentsBlock indexes every skill and escapes a pipe so the table survives", () => {
  const skills = readSkills(bundledSkillsDir());
  const block = renderAgentsBlock(skills);
  for (const s of skills) assert.ok(block.includes(`\`${s.name}\``), `${s.name} is missing from the index`);
  assert.ok(block.startsWith(BEGIN_MARKER) && block.endsWith(END_MARKER));
  const piped = renderAgentsBlock([{ name: "x", description: "a | b. Use when.", dir: "x", path: "p", errors: [] }]);
  assert.ok(piped.includes("a \\| b."));
});

// ---------------------------------------------------------------------------
// mergePiSettings
// ---------------------------------------------------------------------------

test("mergePiSettings writes avo's keys and preserves everything else", () => {
  const r = mergePiSettings({ provider: "anthropic", extensions: ["./x.ts"] });
  assert.equal(r.settings.provider, "anthropic");
  assert.deepEqual(r.settings.extensions, ["./x.ts"]);
  assert.deepEqual(r.settings.defaultTools, [...PI_DEFAULT_TOOLS]);
  assert.equal(r.settings.enableSkillCommands, true);
  assert.deepEqual(r.changed, ["defaultTools", "enableSkillCommands"]);
});

test("mergePiSettings does not re-declare .agents/skills, which pi discovers natively", () => {
  // Declaring it again buys a pi name-collision warning and nothing else.
  const r = mergePiSettings(null);
  assert.equal(r.settings.skills, undefined);
});

test("mergePiSettings leaves a deliberate defaultTools alone but warns when bash is missing", () => {
  const r = mergePiSettings({ defaultTools: ["read", "edit"] });
  assert.deepEqual(r.settings.defaultTools, ["read", "edit"]);
  assert.deepEqual(r.changed, ["enableSkillCommands"]);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0] as string, /without 'bash'.*CLIs/);
});

test("mergePiSettings reports nothing to change on a second pass", () => {
  const first = mergePiSettings(null);
  const second = mergePiSettings(first.settings);
  assert.deepEqual(second.changed, []);
  assert.deepEqual(second.warnings, []);
});

test("mergePiSettings ignores a non-object settings file rather than spreading it", () => {
  for (const bad of [["a"], 42, "text"]) {
    const r = mergePiSettings(bad);
    assert.deepEqual(r.settings.defaultTools, [...PI_DEFAULT_TOOLS]);
  }
});

// ---------------------------------------------------------------------------
// runInstall
// ---------------------------------------------------------------------------

test("runInstall links every skill into a fresh repo and wires all three agents", () => {
  const cwd = repo();
  try {
    const r = runInstall(opts(cwd));
    assert.ok(r.ok, r.errors.join("; "));
    assert.equal(r.skills.length, readSkills(bundledSkillsDir()).length);
    for (const s of r.skills) {
      const link = join(cwd, SKILLS_DIR, s.dir);
      assert.ok(lstatSync(link).isSymbolicLink(), `${s.dir} should be a symlink, not a copy`);
      assert.match(readFileSync(join(link, "SKILL.md"), "utf8"), /^---\n/);
    }
    assert.match(readFileSync(join(cwd, AGENTS_FILE), "utf8"), /avo commit` is the only thing that persists a version/);
    assert.equal(readlinkSync(join(cwd, CLAUDE_SKILLS)), "../.agents/skills");
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, PI_SETTINGS), "utf8")).defaultTools, [...PI_DEFAULT_TOOLS]);
    assert.equal(step(r, "codex")?.action, "unchanged");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("wiring pi links the native extension where pi discovers it, without copying it", () => {
  const cwd = repo();
  try {
    const r = runInstall(opts(cwd, { agents: ["pi"] }));
    assert.ok(r.ok, r.errors.join("; "));
    const link = join(cwd, PI_EXTENSION);
    assert.ok(lstatSync(link).isSymbolicLink(), "a copy is a fork that stops receiving fixes");
    // Absolute, because avocode lives outside the target repo — a relative link out of the repo
    // would encode this machine's layout and break in a clone or in a fan-out worktree.
    assert.equal(readlinkSync(link), join(avocodeRoot(), PI_EXTENSION_SRC));
    // And it is the real extension: pi loads `<dir>/index.ts`.
    assert.match(readFileSync(join(link, "index.ts"), "utf8"), /registerTool/);
    assert.equal(step(r, PI_EXTENSION)?.action, "created");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("both extensions are linked: the tools and the supervisor are separate loads", () => {
  const cwd = repo();
  try {
    const r = runInstall(opts(cwd, { agents: ["pi"] }));
    assert.deepEqual([...PI_EXTENSION_NAMES], ["avo", "avo-supervisor"]);
    for (const name of PI_EXTENSION_NAMES) {
      const link = join(cwd, piExtension(name));
      assert.ok(lstatSync(link).isSymbolicLink(), `${name} must be a link, not a copy`);
      assert.equal(readlinkSync(link), join(avocodeRoot(), piExtensionSrc(name)));
      assert.equal(step(r, piExtension(name))?.action, "created");
    }
    // Not the same file twice: the supervisor subscribes, it does not register tools.
    assert.match(readFileSync(join(cwd, piExtension("avo-supervisor"), "index.ts"), "utf8"), /installSupervisor/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("only pi gets the extension; the other agents reach the same capabilities through bash", () => {
  const cwd = repo();
  try {
    runInstall(opts(cwd, { agents: ["claude", "codex"] }));
    for (const name of PI_EXTENSION_NAMES) assert.ok(!existsSync(join(cwd, piExtension(name))));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("avocode's own repo is told it owns the extension rather than linked to itself", () => {
  // A repo whose pi/extensions/avo already *is* the bundled one — which is avo's own checkout.
  // Reproduced through a symlinked temp dir rather than by running against the real checkout, so
  // the test cannot dirty the working tree. Installing into itself would do exactly that.
  const cwd = repo();
  try {
    mkdirSync(join(cwd, "pi/extensions"), { recursive: true });
    for (const name of PI_EXTENSION_NAMES) symlinkSync(join(avocodeRoot(), piExtensionSrc(name)), join(cwd, piExtensionSrc(name)), "dir");
    const r = runInstall(opts(cwd, { agents: ["pi"] }));
    for (const name of PI_EXTENSION_NAMES) {
      assert.equal(step(r, piExtension(name))?.action, "unchanged");
      assert.match(step(r, piExtension(name))?.detail ?? "", /owns the extension/);
      assert.ok(!existsSync(join(cwd, piExtension(name))), `${name}: nothing was linked`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runInstall is idempotent: a second run changes nothing and creates nothing", () => {
  const cwd = repo();
  try {
    runInstall(opts(cwd));
    const before = snapshot(cwd);
    const second = runInstall(opts(cwd));
    assert.ok(second.ok, second.errors.join("; "));
    assert.deepEqual(
      second.steps.filter((s) => s.action !== "unchanged"),
      [],
      "every step should report 'unchanged' on a re-run",
    );
    assert.deepEqual(snapshot(cwd), before);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runInstall only wires the agents it was asked for", () => {
  const cwd = repo();
  try {
    const r = runInstall(opts(cwd, { agents: ["codex"] }));
    assert.ok(r.ok, r.errors.join("; "));
    // AGENTS.md and the skills are unconditional; the per-agent wiring is not.
    assert.ok(existsSync(join(cwd, AGENTS_FILE)));
    assert.ok(existsSync(join(cwd, SKILLS_DIR, "avo-vary")));
    assert.ok(!existsSync(join(cwd, PI_SETTINGS)));
    assert.ok(!existsSync(join(cwd, CLAUDE_SKILLS)));
    assert.deepEqual(r.warnings, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runInstall reports a repo that already owns the skills instead of linking them to itself", () => {
  // Pointed at a repo whose .agents/skills already *is* the bundled directory — which is avo's own
  // repo. Reproduced through a symlinked temp dir rather than by running against the real checkout,
  // so the test cannot write into the working tree.
  const cwd = repo();
  try {
    mkdirSync(join(cwd, ".agents"), { recursive: true });
    symlinkSync(bundledSkillsDir(), join(cwd, SKILLS_DIR), "dir");
    const r = runInstall(opts(cwd, { agents: [] }));
    assert.ok(r.ok, r.errors.join("; "));
    const s = step(r, SKILLS_DIR);
    assert.equal(s?.action, "unchanged");
    assert.match(s?.detail ?? "", /this repo owns them/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runInstall links avo's skills inside an existing .claude/skills instead of replacing it", () => {
  const cwd = repo();
  try {
    mkdirSync(join(cwd, CLAUDE_SKILLS, "their-skill"), { recursive: true });
    writeFileSync(join(cwd, CLAUDE_SKILLS, "their-skill", "SKILL.md"), "---\nname: their-skill\ndescription: theirs\n---\nbody\n");
    const r = runInstall(opts(cwd, { agents: ["claude"] }));
    assert.ok(r.ok, r.errors.join("; "));
    assert.match(step(r, CLAUDE_SKILLS)?.detail ?? "", /already a real directory/);
    assert.ok(existsSync(join(cwd, CLAUDE_SKILLS, "their-skill", "SKILL.md")), "their skill must survive");
    assert.equal(readlinkSync(join(cwd, CLAUDE_SKILLS, "avo-vary")), "../../.agents/skills/avo-vary");
    // And still idempotent down this branch.
    const before = snapshot(cwd);
    runInstall(opts(cwd, { agents: ["claude"] }));
    assert.deepEqual(snapshot(cwd), before);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runInstall refuses to replace a foreign symlink without --force, and replaces it with one", () => {
  const cwd = repo();
  try {
    mkdirSync(join(cwd, "somewhere"), { recursive: true });
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    symlinkSync("../somewhere", join(cwd, CLAUDE_SKILLS), "dir");
    const refused = runInstall(opts(cwd, { agents: ["claude"] }));
    assert.ok(refused.ok, "a skipped step is not a failure");
    assert.equal(step(refused, CLAUDE_SKILLS)?.action, "skipped");
    assert.match(step(refused, CLAUDE_SKILLS)?.detail ?? "", /--force/);
    assert.equal(readlinkSync(join(cwd, CLAUDE_SKILLS)), "../somewhere");

    const forced = runInstall(opts(cwd, { agents: ["claude"], force: true }));
    assert.equal(step(forced, CLAUDE_SKILLS)?.action, "created");
    assert.equal(readlinkSync(join(cwd, CLAUDE_SKILLS)), "../.agents/skills");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runInstall never deletes a real directory, even with --force", () => {
  const cwd = repo();
  try {
    mkdirSync(join(cwd, SKILLS_DIR, "avo-vary", "mine"), { recursive: true });
    writeFileSync(join(cwd, SKILLS_DIR, "avo-vary", "mine", "keep.txt"), "keep\n");
    const r = runInstall(opts(cwd, { agents: ["pi"], force: true }));
    assert.equal(step(r, join(SKILLS_DIR, "avo-vary"))?.action, "skipped");
    assert.match(step(r, join(SKILLS_DIR, "avo-vary"))?.detail ?? "", /refusing to replace it/);
    assert.ok(existsSync(join(cwd, SKILLS_DIR, "avo-vary", "mine", "keep.txt")));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runInstall leaves an unparseable .pi/settings.json alone and says so", () => {
  const cwd = repo();
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, PI_SETTINGS), "{ not json\n");
    const r = runInstall(opts(cwd, { agents: ["pi"] }));
    assert.ok(r.ok);
    assert.equal(step(r, PI_SETTINGS)?.action, "skipped");
    assert.equal(readFileSync(join(cwd, PI_SETTINGS), "utf8"), "{ not json\n");
    assert.ok(r.warnings.some((w) => /not valid JSON/.test(w)));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runInstall always warns that headless pi ignores project skills until the project is trusted", () => {
  const cwd = repo();
  try {
    const r = runInstall(opts(cwd, { agents: ["pi"] }));
    assert.ok(r.warnings.some((w) => /--approve|defaultProjectTrust/.test(w)), r.warnings.join("; "));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// installCommand
// ---------------------------------------------------------------------------

test("installCommand --json emits one parseable line and nothing else", () => {
  const cwd = repo();
  try {
    const io = bufferIo();
    assert.equal(installCommand(["--json", "--cwd", cwd], io), 0);
    assert.equal(io.stderr, "");
    const parsed = JSON.parse(io.stdout) as InstallResult;
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.agents, ["pi", "claude", "codex"]);
    assert.ok(parsed.skills.length >= 4);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("installCommand returns 2 on a bad flag without writing anything", () => {
  const cwd = repo();
  try {
    const io = bufferIo();
    assert.equal(installCommand(["--agent", "vim", "--cwd", cwd], io), 2);
    assert.match(io.stderr, /unknown agent 'vim'/);
    assert.equal(io.stdout, "");
    assert.ok(!existsSync(join(cwd, AGENTS_FILE)));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("renderInstall shows every step and ends with what an agent can now do", () => {
  const cwd = repo();
  try {
    const text = renderInstall(runInstall(opts(cwd)));
    assert.match(text, /avo install --agent pi,claude,codex/);
    assert.match(text, /avo-vary/);
    assert.match(text, /skill\(s\) wired for pi, claude, codex/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

/** Every path avo install touches, with what is actually there — so a re-run can be byte-compared. */
function snapshot(cwd: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string): void => {
    const abs = join(cwd, rel);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) out[rel] = `link:${readlinkSync(abs)}`;
    else if (st.isDirectory()) {
      out[rel] = "dir";
      for (const name of readdirSync(abs).sort()) walk(join(rel, name));
    } else out[rel] = readFileSync(abs, "utf8");
  };
  for (const rel of [SKILLS_DIR, AGENTS_FILE, CLAUDE_SKILLS, PI_SETTINGS, ...PI_EXTENSION_NAMES.map(piExtension)]) walk(rel);
  return out;
}
