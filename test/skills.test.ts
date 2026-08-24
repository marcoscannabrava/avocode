import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { bundledSkillsDir, parseFrontmatter, readSkill, readSkills, SKILL_FILE } from "../src/skills.ts";

function skillsRoot(): string {
  return mkdtempSync(join(tmpdir(), "avo-skills-"));
}

function writeSkill(root: string, dir: string, body: string): void {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, SKILL_FILE), body);
}

// ---------------------------------------------------------------------------
// the acceptance case for S5: avo's own skills must be valid
// ---------------------------------------------------------------------------

test("every bundled SKILL.md parses and has a non-empty description", () => {
  const skills = readSkills(bundledSkillsDir());
  assert.ok(skills.length >= 4, `expected avo's bundled skills, found ${skills.length}`);
  for (const s of skills) {
    assert.deepEqual(s.errors, [], `${s.dir}/${SKILL_FILE}: ${s.errors.join("; ")}`);
    assert.notEqual(s.description.trim(), "");
    assert.equal(s.name, s.dir);
  }
});

test("every bundled skill says when to use it, not just what it does", () => {
  // The description is the only thing always in context (progressive disclosure), so it has to
  // carry the trigger. A description with no "use when" is a skill that never loads.
  for (const s of readSkills(bundledSkillsDir())) {
    assert.match(s.description, /\bUse (when|whenever|for|before)\b/i, `${s.dir} has no trigger in its description`);
  }
});

test("every relative link in a bundled skill resolves to a real file", () => {
  // Progressive disclosure works by relative path: the agent follows the link to load the detail.
  // A broken one is a dead end it cannot recover from, and nothing else in the suite would catch it.
  const root = bundledSkillsDir();
  let checked = 0;
  for (const s of readSkills(root)) {
    const dir = dirname(s.path);
    const text = readFileSync(s.path, "utf8");
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const href = m[1] as string;
      if (/^(https?:|mailto:|#)/.test(href)) continue;
      const target = resolve(dir, href.split("#")[0] as string);
      assert.ok(existsSync(target), `${s.dir}/${SKILL_FILE} links to ${href}, which resolves to a missing ${target}`);
      checked++;
    }
  }
  assert.ok(checked >= 4, `expected the skills to cross-reference each other, followed ${checked} link(s)`);
});

test("no bundled skill links outside the skills tree", () => {
  // `avo install` symlinks individual skill directories into a target repo, so a link that reaches
  // above `.agents/skills/` resolves against *that* repo, where the path does not exist. Sibling
  // skills are fine: they are linked in as siblings too.
  const root = bundledSkillsDir();
  for (const s of readSkills(root)) {
    for (const m of readFileSync(s.path, "utf8").matchAll(/\]\(([^)\s]+)\)/g)) {
      const href = m[1] as string;
      if (/^(https?:|mailto:|#)/.test(href)) continue;
      const target = resolve(dirname(s.path), href.split("#")[0] as string);
      assert.ok(
        !relative(root, target).startsWith(".."),
        `${s.dir}/${SKILL_FILE} links to ${href}, which escapes ${root} — it would not resolve in a repo that symlinks the skill in`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

test("parseFrontmatter reads the flat key: value subset", () => {
  const r = parseFrontmatter('---\nname: a-skill\ndescription: "does a thing"\n---\n# Body\n\ntext\n');
  assert.ok(!("error" in r));
  assert.equal(r.fields.name, "a-skill");
  assert.equal(r.fields.description, "does a thing");
  assert.match(r.body, /^# Body/);
});

test("parseFrontmatter folds an indented continuation onto its key", () => {
  const r = parseFrontmatter("---\ndescription: line one\n  line two\nname: a\n---\nbody\n");
  assert.ok(!("error" in r));
  assert.equal(r.fields.description, "line one line two");
  assert.equal(r.fields.name, "a");
});

test("parseFrontmatter ignores comments and blank lines", () => {
  const r = parseFrontmatter("---\n# a comment\n\nname: a\n---\nbody\n");
  assert.ok(!("error" in r));
  assert.deepEqual(Object.keys(r.fields), ["name"]);
});

test("parseFrontmatter tolerates a BOM, which a Windows editor will add", () => {
  const r = parseFrontmatter("﻿---\nname: a\ndescription: d\n---\nbody\n");
  assert.ok(!("error" in r));
  assert.equal(r.fields.name, "a");
});

test("parseFrontmatter refuses what an agent would also refuse", () => {
  for (const [text, pattern] of [
    ["# just markdown\n", /must start with a '---' line/],
    ["---\nname: a\n", /unterminated/],
    ["---\nnot a mapping\n---\nbody\n", /not 'key: value'/],
    ["---\n  orphan: 1\n---\nbody\n", /unexpected indented line/],
    ["---\nname: a\nname: b\n---\nbody\n", /duplicate frontmatter key 'name'/],
    ["---\n: 1\n---\nbody\n", /empty key/],
  ] as const) {
    const r = parseFrontmatter(text);
    assert.ok("error" in r, `expected a parse error for ${JSON.stringify(text)}`);
    assert.match(r.error, pattern);
  }
});

// ---------------------------------------------------------------------------
// readSkill — the spec rules
// ---------------------------------------------------------------------------

test("readSkill reports every spec violation it finds, not just the first", () => {
  const root = skillsRoot();
  try {
    writeSkill(root, "Bad_Name", "---\nname: Bad_Name\n---\n\n");
    const s = readSkill(root, "Bad_Name");
    assert.ok(s.errors.some((e) => /not lowercase alphanumerics/.test(e)));
    assert.ok(s.errors.some((e) => /missing a non-empty 'description'/.test(e)));
    assert.ok(s.errors.some((e) => /body is empty/.test(e)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readSkill requires name to match its directory, the strictest reading of the spec", () => {
  // Pi is lenient here and Claude Code is not. A skill we ship has to load in both, so we hold to
  // the strict rule rather than the lenient one.
  const root = skillsRoot();
  try {
    writeSkill(root, "the-dir", "---\nname: another-name\ndescription: d\n---\nbody\n");
    const s = readSkill(root, "the-dir");
    assert.equal(s.errors.length, 1);
    assert.match(s.errors[0] as string, /does not match its directory 'the-dir'/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readSkill enforces the spec's length caps", () => {
  const root = skillsRoot();
  try {
    const long = "a".repeat(65);
    writeSkill(root, long, `---\nname: ${long}\ndescription: ${"d".repeat(1025)}\n---\nbody\n`);
    const s = readSkill(root, long);
    assert.ok(s.errors.some((e) => /name is 65 chars; the spec caps it at 64/.test(e)));
    assert.ok(s.errors.some((e) => /description is 1025 chars; the spec caps it at 1024/.test(e)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readSkill rejects leading, trailing and doubled hyphens", () => {
  const root = skillsRoot();
  try {
    for (const name of ["-lead", "trail-", "double--hyphen"]) {
      writeSkill(root, name, `---\nname: ${name}\ndescription: d\n---\nbody\n`);
      const s = readSkill(root, name);
      assert.ok(
        s.errors.some((e) => /not lowercase alphanumerics/.test(e)),
        `${name} should be rejected`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readSkill turns an unreadable SKILL.md into an error rather than a throw", () => {
  const root = skillsRoot();
  try {
    const s = readSkill(root, "not-there");
    assert.equal(s.errors.length, 1);
    assert.match(s.errors[0] as string, /cannot read SKILL\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// readSkills
// ---------------------------------------------------------------------------

test("readSkills lists directories holding a SKILL.md, sorted, and ignores everything else", () => {
  const root = skillsRoot();
  try {
    writeSkill(root, "zeta", "---\nname: zeta\ndescription: d\n---\nbody\n");
    writeSkill(root, "alpha", "---\nname: alpha\ndescription: d\n---\nbody\n");
    mkdirSync(join(root, "no-skill-here"), { recursive: true });
    writeFileSync(join(root, "README.md"), "not a skill\n");
    assert.deepEqual(
      readSkills(root).map((s) => s.dir),
      ["alpha", "zeta"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readSkills on a missing directory is empty, not a throw", () => {
  assert.deepEqual(readSkills(join(tmpdir(), "avo-skills-does-not-exist")), []);
});
