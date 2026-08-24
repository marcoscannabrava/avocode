import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Io } from "./io.ts";
import { bundledSkillsDir, readSkills, SKILL_FILE, SKILLS_DIR, type Skill } from "./skills.ts";
import type { InitStep } from "./steps.ts";

export type { InitStep, StepAction } from "./steps.ts";

export type AgentName = "pi" | "claude" | "codex";
export const AGENT_NAMES: readonly AgentName[] = ["pi", "claude", "codex"];

export const AGENTS_FILE = "AGENTS.md";
export const CLAUDE_SKILLS = ".claude/skills";
export const PI_SETTINGS = ".pi/settings.json";

/** Delimits the block `avo install` owns, so re-running rewrites it instead of appending again. */
export const BEGIN_MARKER = "<!-- BEGIN avo: managed by `avo install`, edits inside are overwritten -->";
export const END_MARKER = "<!-- END avo -->";

/**
 * Pi's standard built-ins plus `grep`/`find`/`ls`. `bash` is the one that matters: avo, `bd` and
 * `qmd` are CLIs, which is what makes the harness agent-agnostic (PLAN §2) — an agent without
 * `bash` cannot drive any of it.
 */
export const PI_DEFAULT_TOOLS: readonly string[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export interface InstallResult {
  ok: boolean;
  cwd: string;
  agents: AgentName[];
  skills: { name: string; dir: string }[];
  steps: InitStep[];
  warnings: string[];
  errors: string[];
}

export interface InstallOptions {
  json: boolean;
  cwd: string;
  agents: AgentName[];
  /** Replace a symlink or file that is in the way. Never recurses into a real directory. */
  force: boolean;
}

export function parseInstallArgs(argv: readonly string[]): InstallOptions | { error: string } {
  const opts: InstallOptions = { json: false, cwd: process.cwd(), agents: [...AGENT_NAMES], force: false };
  let sawAgent = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--json") opts.json = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--cwd" || a === "--agent") {
      const v = argv[i + 1];
      if (v === undefined) return { error: `avo install: ${a} needs a value` };
      if (a === "--cwd") opts.cwd = v;
      else {
        // Repeatable and comma-separated, so `--agent pi --agent codex` and `--agent pi,codex` both
        // work; the first `--agent` replaces the default of all three.
        const names: AgentName[] = [];
        for (const part of v.split(",").map((s) => s.trim())) {
          if (part === "all") names.push(...AGENT_NAMES);
          else if ((AGENT_NAMES as readonly string[]).includes(part)) names.push(part as AgentName);
          else return { error: `avo install: unknown agent '${part}' (expected ${AGENT_NAMES.join(" | ")} | all)` };
        }
        if (!sawAgent) opts.agents = [];
        sawAgent = true;
        for (const n of names) if (!opts.agents.includes(n)) opts.agents.push(n);
      }
      i++;
    } else return { error: `avo install: unknown option '${a}'` };
  }
  return opts;
}

// ---------------------------------------------------------------------------
// symlinks — the one genuinely new idempotency case in this command
// ---------------------------------------------------------------------------

export type LinkState = "absent" | "match" | "other-link" | "directory" | "file";

/**
 * What is at `linkPath`, relative to the link we want there. `match` compares the resolved targets
 * rather than the raw link text, so an equivalent absolute link counts as already-correct instead of
 * being needlessly rewritten.
 */
export function linkState(linkPath: string, wantTarget: string): LinkState {
  let st;
  try {
    st = lstatSync(linkPath);
  } catch {
    return "absent";
  }
  if (st.isSymbolicLink()) {
    const raw = readlinkSync(linkPath);
    if (raw === wantTarget) return "match";
    try {
      if (realpathSync(linkPath) === realpathSync(resolve(dirname(linkPath), wantTarget))) return "match";
    } catch {
      // A dangling link, or a want-target that does not exist yet: not a match, and safe to replace.
    }
    return "other-link";
  }
  return st.isDirectory() ? "directory" : "file";
}

/** Creates `linkPath -> wantTarget` idempotently. Never touches a real directory. */
function ensureLink(linkPath: string, wantTarget: string, force: boolean): { action: InitStep["action"]; detail: string } {
  const state = linkState(linkPath, wantTarget);
  if (state === "match") return { action: "unchanged", detail: `already links to ${wantTarget}` };
  if (state === "directory") {
    return { action: "skipped", detail: "a real directory is already there; refusing to replace it (nothing is deleted by avo install)" };
  }
  if ((state === "other-link" || state === "file") && !force) {
    const what = state === "file" ? "a file" : `a symlink to ${readlinkSync(linkPath)}`;
    return { action: "skipped", detail: `${what} is already there; re-run with --force to replace it` };
  }
  try {
    mkdirSync(dirname(linkPath), { recursive: true });
    if (state !== "absent") rmSync(linkPath, { force: true });
    symlinkSync(wantTarget, linkPath, "dir");
    return { action: "created", detail: `-> ${wantTarget}` };
  } catch (e) {
    return { action: "failed", detail: (e as Error).message };
  }
}

/**
 * Where a link at `fromDir` should point to reach `to`.
 *
 * Relative when both ends live under the same repo, so the pair survives being cloned or moved
 * wholesale. Absolute when they do not: a relative link reaching *out* of the repo encodes the
 * repo's own location, which breaks the moment the repo is checked out somewhere else — including
 * into the git worktrees `avo fan` will create.
 */
export function linkTargetFor(cwd: string, fromDir: string, to: string): string {
  const inside = !relative(cwd, to).startsWith("..");
  return inside ? relative(fromDir, to) || "." : to;
}

/** Per-skill links into an existing real directory — the shape `qmd skill install` also uses. */
function linkEachSkill(cwd: string, intoDir: string, sourceDir: string, skills: readonly Skill[], force: boolean, steps: InitStep[]): void {
  for (const s of skills) {
    const linkPath = join(intoDir, s.dir);
    const r = ensureLink(linkPath, linkTargetFor(cwd, intoDir, join(sourceDir, s.dir)), force);
    steps.push({ name: relative(cwd, linkPath), action: r.action, detail: r.detail });
  }
}

// ---------------------------------------------------------------------------
// AGENTS.md
// ---------------------------------------------------------------------------

/**
 * The always-on rules, plus a skills index. The index exists for Codex, which has no skill
 * discovery mechanism at all — for it, "wiring" means naming the files and what each is for, so the
 * agent can `read` the right one. Pi and Claude Code get the same table for free.
 */
export function renderAgentsBlock(skills: readonly Skill[]): string {
  const lines = [
    BEGIN_MARKER,
    "",
    "## avocode",
    "",
    "This repo is an [avocode](https://github.com/mcannabrava/avocode) optimization loop: a scorer",
    "`.avo/score` defines what better means, and a committed lineage of versions records every",
    "improvement. Some rules always apply here.",
    "",
    "- **`avo commit` is the only thing that persists a version.** Never hand-write a version commit,",
    "  never edit `lineage/`, and never edit `.avo/score` to make a candidate pass.",
    "- **Measure before you claim.** `avo score --json` is the only evidence that a change helped.",
    "- **Read the past before you vary.** `avo mem prime`, `avo best`, and",
    '  `avo know query "<idea>"` cost one command each and hold what earlier sessions learned.',
    "- **Record what you learn.** `avo mem add \"<insight>\"` — especially dead ends. A refusal you do",
    "  not write down is a refusal the next session earns again.",
    "- **Use `bd` for task state, never markdown TODO lists.** `bd create`, `bd ready`, `bd close`.",
    "  Markdown checklists are exactly what beads exists to replace, and they do not survive a",
    "  session boundary.",
    "",
    "### Skills",
    "",
    `Full instructions live in \`${SKILLS_DIR}/<name>/${SKILL_FILE}\`. Read the one that matches the task.`,
    "",
    "| Skill | Read this when |",
    "| --- | --- |",
  ];
  for (const s of skills) lines.push(`| \`${s.name}\` | ${firstSentence(s.description)} |`);
  lines.push("", END_MARKER);
  return lines.join("\n");
}

function firstSentence(description: string): string {
  const trimmed = description.replace(/\|/g, "\\|").trim();
  const stop = trimmed.search(/\.\s/);
  return stop === -1 ? trimmed : trimmed.slice(0, stop + 1);
}

/**
 * Splices the managed block into `AGENTS.md`, preserving everything outside the markers. An
 * unmarked existing file keeps all of its content and gains the block at the end — `avo install`
 * has no business rewriting rules a human wrote.
 */
export function spliceBlock(existing: string | null, block: string): { text: string; action: "created" | "unchanged" | "updated" | "appended" } {
  if (existing === null) return { text: `${block}\n`, action: "created" };
  const begin = existing.indexOf(BEGIN_MARKER);
  const end = existing.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || end < begin) {
    const sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return { text: `${existing}${sep}${block}\n`, action: "appended" };
  }
  const head = existing.slice(0, begin);
  const tail = existing.slice(end + END_MARKER.length);
  const text = `${head}${block}${tail}`;
  return { text, action: text === existing ? "unchanged" : "updated" };
}

// ---------------------------------------------------------------------------
// .pi/settings.json
// ---------------------------------------------------------------------------

/**
 * Merges avo's keys into whatever is already there, and reports whether anything changed.
 *
 * `.agents/skills/` is deliberately *not* added to `skills`: Pi discovers project `.agents/skills/`
 * natively, and Pi warns on a name collision between two skill locations — so declaring it again
 * would buy a warning and nothing else. What Pi does need from us is `bash`.
 */
export function mergePiSettings(existing: unknown): { settings: Record<string, unknown>; changed: string[]; warnings: string[] } {
  const settings: Record<string, unknown> = existing !== null && typeof existing === "object" && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {};
  const changed: string[] = [];
  const warnings: string[] = [];

  const tools = settings.defaultTools;
  if (tools === undefined) {
    settings.defaultTools = [...PI_DEFAULT_TOOLS];
    changed.push("defaultTools");
  } else if (Array.isArray(tools) && !tools.includes("bash")) {
    // Someone's deliberate choice; widening it silently would be worse than saying so.
    warnings.push(`${PI_SETTINGS} sets defaultTools without 'bash'; avo, bd and qmd are CLIs, so the agent cannot run any of them`);
  }
  if (settings.enableSkillCommands === undefined) {
    settings.enableSkillCommands = true;
    changed.push("enableSkillCommands");
  }
  return { settings, changed, warnings };
}

// ---------------------------------------------------------------------------
// avo install
// ---------------------------------------------------------------------------

export function runInstall(opts: InstallOptions): InstallResult {
  const steps: InitStep[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const cwd = resolve(opts.cwd);
  const source = bundledSkillsDir();
  const skills = readSkills(source);
  const result = (): InstallResult => ({
    ok: errors.length === 0,
    cwd,
    agents: opts.agents,
    skills: skills.map((s) => ({ name: s.name, dir: s.dir })),
    steps,
    warnings,
    errors,
  });

  if (skills.length === 0) {
    errors.push(`no skills found in ${source}; avo's own ${SKILLS_DIR}/ is missing or empty`);
    steps.push({ name: SKILLS_DIR, action: "failed", detail: `nothing to install from ${source}` });
    return result();
  }
  // A skill that violates the spec loads in Pi (lenient) and not in Claude Code (strict), which is
  // the worst outcome: the harness would look installed and behave differently per agent.
  const broken = skills.filter((s) => s.errors.length > 0);
  if (broken.length > 0) {
    for (const s of broken) errors.push(`${s.dir}/${SKILL_FILE} violates the Agent Skills spec: ${s.errors.join("; ")}`);
    steps.push({ name: SKILLS_DIR, action: "failed", detail: `${broken.length} of ${skills.length} skill(s) are invalid` });
    return result();
  }

  const target = join(cwd, SKILLS_DIR);
  const ownRepo = existsSync(target) && sameDir(target, source);
  if (ownRepo) {
    steps.push({ name: SKILLS_DIR, action: "unchanged", detail: `${skills.length} skill(s) already live here; this repo owns them` });
  } else {
    try {
      mkdirSync(target, { recursive: true });
      linkEachSkill(cwd, target, source, skills, opts.force, steps);
    } catch (e) {
      errors.push(`could not create ${SKILLS_DIR} in ${cwd} — ${(e as Error).message}`);
      steps.push({ name: SKILLS_DIR, action: "failed", detail: (e as Error).message });
      return result();
    }
  }

  // AGENTS.md is unconditional: every agent here reads it, and it carries the rules that hold
  // whether or not a skill was loaded.
  const agentsPath = join(cwd, AGENTS_FILE);
  try {
    const existing = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : null;
    const spliced = spliceBlock(existing, renderAgentsBlock(skills));
    if (spliced.action !== "unchanged") writeFileSync(agentsPath, spliced.text);
    steps.push({
      name: AGENTS_FILE,
      action: spliced.action === "unchanged" ? "unchanged" : "created",
      detail:
        spliced.action === "appended"
          ? "the managed block appended; your own content above it is untouched"
          : spliced.action === "updated"
            ? "the managed block refreshed in place"
            : "the always-on rules and the skills index",
    });
  } catch (e) {
    errors.push(`could not write ${AGENTS_FILE} — ${(e as Error).message}`);
    steps.push({ name: AGENTS_FILE, action: "failed", detail: (e as Error).message });
  }

  for (const agent of opts.agents) {
    if (agent === "pi") installPi(cwd, steps, warnings);
    else if (agent === "claude") installClaude(cwd, ownRepo ? source : target, skills, opts.force, steps);
    else steps.push({ name: "codex", action: "unchanged", detail: `discovers skills through the ${AGENTS_FILE} index; it has no skills mechanism of its own` });
  }

  return result();
}

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function installPi(cwd: string, steps: InitStep[], warnings: string[]): void {
  steps.push({ name: "pi", action: "unchanged", detail: `discovers project ${SKILLS_DIR}/ natively — no copying, no config` });
  const path = join(cwd, PI_SETTINGS);
  let existing: unknown = null;
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      steps.push({ name: PI_SETTINGS, action: "skipped", detail: `existing file is not valid JSON (${(e as Error).message}); refusing to overwrite it` });
      warnings.push(`${PI_SETTINGS} is not valid JSON, so avo left it alone; pi will not read it either`);
      return;
    }
  }
  const merged = mergePiSettings(existing);
  warnings.push(...merged.warnings);
  try {
    if (merged.changed.length === 0) {
      steps.push({ name: PI_SETTINGS, action: "unchanged", detail: "defaultTools and enableSkillCommands are already set" });
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(merged.settings, null, 2)}\n`);
      steps.push({ name: PI_SETTINGS, action: "created", detail: `set ${merged.changed.join(", ")}` });
    }
  } catch (e) {
    steps.push({ name: PI_SETTINGS, action: "failed", detail: (e as Error).message });
    warnings.push(`could not write ${PI_SETTINGS} — ${(e as Error).message}`);
  }
  // The trap worth naming: headless pi (-p, --mode json) never prompts for project trust, and
  // without a saved decision it ignores project .agents/skills and .pi/settings.json entirely — so
  // an installed harness silently does nothing in exactly the mode `avo fan` will drive it in.
  warnings.push(
    "pi ignores project-local skills and settings until the project is trusted, and headless runs (-p, --mode json) never prompt: " +
      "pass --approve, run 'pi' once and answer the trust prompt, or set defaultProjectTrust to 'always' in ~/.pi/agent/settings.json",
  );
}

function installClaude(cwd: string, skillsDir: string, skills: readonly Skill[], force: boolean, steps: InitStep[]): void {
  const linkPath = join(cwd, CLAUDE_SKILLS);
  const want = linkTargetFor(cwd, join(cwd, dirname(CLAUDE_SKILLS)), join(cwd, SKILLS_DIR));
  if (linkState(linkPath, want) === "directory") {
    // A real .claude/skills means the repo already has Claude-only skills. Linking each of ours
    // inside it adds avo's without touching theirs; replacing the directory would delete them.
    steps.push({ name: CLAUDE_SKILLS, action: "unchanged", detail: "already a real directory with its own skills; linking avo's inside it instead" });
    linkEachSkill(cwd, linkPath, skillsDir, skills, force, steps);
    return;
  }
  const r = ensureLink(linkPath, want, force);
  steps.push({
    name: CLAUDE_SKILLS,
    action: r.action,
    detail: r.action === "created" ? `${r.detail} — one link, so a skill added later needs no re-install` : r.detail,
  });
}

export function renderInstall(r: InstallResult): string {
  const lines = [`avo install --agent ${r.agents.join(",")}`, ""];
  for (const s of r.steps) lines.push(`  ${s.action.padEnd(10)} ${s.name.padEnd(22)} ${s.detail}`);
  lines.push("");
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  for (const e of r.errors) lines.push(`error: ${e}`);
  if (r.warnings.length > 0 || r.errors.length > 0) lines.push("");
  lines.push(r.ok ? `${r.skills.length} skill(s) wired for ${r.agents.join(", ")} — ${r.skills.map((s) => s.name).join(", ")}` : "avo install incomplete");
  return `${lines.join("\n")}\n`;
}

export function installCommand(argv: readonly string[], io: Io): number {
  const parsed = parseInstallArgs(argv);
  if ("error" in parsed) {
    io.err(`${parsed.error}\n`);
    return 2;
  }
  const r = runInstall(parsed);
  if (parsed.json) io.out(`${JSON.stringify(r)}\n`);
  else {
    io.out(renderInstall(r));
    for (const e of r.errors) io.err(`avo install: ${e}\n`);
  }
  return r.ok ? 0 : 2;
}
