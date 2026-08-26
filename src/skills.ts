import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Where skills live, relative to a repo root: the Agent Skills standard's shared location, which is
 * no one agent's. Pi discovers it natively; `avo install` wires the others to it (PLAN §3).
 */
export const SKILLS_DIR = ".agents/skills";
export const SKILL_FILE = "SKILL.md";

/**
 * avocode's own checkout, wherever installed. Exported because `avo install` links a target repo at
 * two things avo ships — the skills and the Pi extension — and two roots is how they disagree.
 */
export function avocodeRoot(): string {
  return repoRoot;
}

/** avocode's own bundled skills — the source `avo install` links a target repo to. */
export function bundledSkillsDir(): string {
  return join(repoRoot, SKILLS_DIR);
}

/** agentskills.io/specification: 1-64 chars, lowercase alphanumerics and single inner hyphens. */
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;

export interface Skill {
  /** The `name` from the frontmatter. */
  name: string;
  description: string;
  /** Directory name on disk. The spec requires it to equal `name`. */
  dir: string;
  path: string;
  /** Spec violations. A skill with errors is not installable — agents disagree on leniency. */
  errors: string[];
}

/**
 * Minimal YAML front-matter reader: the flat `key: value` subset the spec uses, plus `key:` followed
 * by an indented block (joined into one string, enough to tell non-empty from missing).
 *
 * Deliberately not a YAML dependency. Frontmatter these rules cannot parse is frontmatter some
 * agent will also refuse, so failing here is the useful outcome.
 */
export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } | { error: string } {
  const normalized = text.replace(/^﻿/, "");
  if (!normalized.startsWith("---\n")) return { error: "no YAML frontmatter: the file must start with a '---' line" };
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return { error: "unterminated YAML frontmatter: no closing '---' line" };
  const head = normalized.slice(4, end + 1);
  const body = normalized.slice(normalized.indexOf("\n", end + 1) + 1);

  const fields: Record<string, string> = {};
  let current: string | null = null;
  for (const raw of head.split("\n")) {
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    if (/^\s/.test(raw)) {
      // Folded onto the key: multi-line descriptions stay readable and still checkable.
      if (current === null) return { error: `unexpected indented line in frontmatter: '${raw.trim()}'` };
      fields[current] = `${fields[current] ?? ""} ${raw.trim()}`.trim();
      continue;
    }
    const colon = raw.indexOf(":");
    if (colon === -1) return { error: `frontmatter line is not 'key: value': '${raw.trim()}'` };
    const key = raw.slice(0, colon).trim();
    if (key === "") return { error: `frontmatter line has an empty key: '${raw.trim()}'` };
    if (key in fields) return { error: `duplicate frontmatter key '${key}'` };
    current = key;
    fields[key] = unquote(raw.slice(colon + 1).trim());
  }
  return { fields, body };
}

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Validates one skill directory against the Agent Skills spec. `name` must equal the directory name:
 * Pi relaxes that, Claude Code and the spec do not, and a shipped skill must load everywhere.
 */
export function readSkill(skillsDir: string, dir: string): Skill {
  const path = join(skillsDir, dir, SKILL_FILE);
  const errors: string[] = [];
  const skill = (name: string, description: string): Skill => ({ name, description, dir, path, errors });

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    errors.push(`cannot read ${SKILL_FILE} — ${(e as Error).message}`);
    return skill(dir, "");
  }

  const parsed = parseFrontmatter(text);
  if ("error" in parsed) {
    errors.push(parsed.error);
    return skill(dir, "");
  }

  const name = parsed.fields.name ?? "";
  const description = parsed.fields.description ?? "";
  if (name === "") errors.push("frontmatter is missing a 'name'");
  else {
    if (name.length > NAME_MAX) errors.push(`name is ${name.length} chars; the spec caps it at ${NAME_MAX}`);
    if (!NAME_RE.test(name)) errors.push(`name '${name}' is not lowercase alphanumerics separated by single hyphens`);
    if (name !== dir) errors.push(`name '${name}' does not match its directory '${dir}'; the spec requires them to match`);
  }
  if (description === "") errors.push("frontmatter is missing a non-empty 'description'; without one the skill is never loaded");
  else if (description.length > DESCRIPTION_MAX) errors.push(`description is ${description.length} chars; the spec caps it at ${DESCRIPTION_MAX}`);
  if (parsed.body.trim() === "") errors.push("the body is empty; a skill with no instructions teaches an agent nothing");

  return skill(name, description);
}

/** Every skill directory under `skillsDir`, sorted by directory name so output is stable. */
export function readSkills(skillsDir: string): Skill[] {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && existsSync(join(skillsDir, e.name, SKILL_FILE)))
    .map((e) => e.name)
    .sort()
    .map((dir) => readSkill(skillsDir, dir));
}
