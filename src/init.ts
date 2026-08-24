import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH, DEFAULT_CONFIG } from "./config.ts";
import type { Io } from "./io.ts";
import { runKnowInit } from "./knowledge.ts";
import { ensureTrajectoryIgnored, isGitRepo } from "./lineage.ts";
import { MEMORY_PATH, resolveBackend } from "./mem.ts";
import { initScorer, listTemplates, SCORER_PATH, spawnRunner, type Runner } from "./score.ts";
import type { InitStep } from "./steps.ts";

export type { InitStep, StepAction } from "./steps.ts";

export interface InitResult {
  ok: boolean;
  cwd: string;
  steps: InitStep[];
  warnings: string[];
  errors: string[];
}

export interface InitOptions {
  json: boolean;
  cwd: string;
  /** beads issue prefix; unset lets `bd` default to the directory name. */
  prefix: string | null;
  /** Scaffold `.avo/score` from this template while we are here. */
  scorer: string | null;
}

export function parseInitArgs(argv: readonly string[]): InitOptions | { error: string } {
  const opts: InitOptions = { json: false, cwd: process.cwd(), prefix: null, scorer: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--json") opts.json = true;
    else if (a === "--cwd" || a === "--prefix" || a === "--scorer") {
      const v = argv[i + 1];
      if (v === undefined) return { error: `avo init: ${a} needs a value` };
      if (a === "--cwd") opts.cwd = v;
      else if (a === "--prefix") opts.prefix = v;
      else opts.scorer = v;
      i++;
    } else return { error: `avo init: unknown option '${a}'` };
  }
  return opts;
}

function writeIfAbsent(path: string, body: string): InitStep["action"] {
  if (existsSync(path)) return "unchanged";
  writeFileSync(path, body);
  return "created";
}

/**
 * `avo init` — scaffolds everything the loop needs and is safe to re-run. It is the only place that
 * touches `bd init`, whose one visible side effect is a git commit of the beads config files.
 */
export async function runInit(opts: InitOptions, runner: Runner = spawnRunner): Promise<InitResult> {
  const steps: InitStep[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const result = (): InitResult => ({ ok: errors.length === 0, cwd: opts.cwd, steps, warnings, errors });

  if (!(await isGitRepo(runner, opts.cwd))) {
    errors.push(`${opts.cwd} is not a git repository; the lineage lives in git, so init has nothing to write to`);
    steps.push({ name: "git", action: "failed", detail: "not a git repository" });
    return result();
  }
  steps.push({ name: "git", action: "unchanged", detail: `${opts.cwd} is a git repository` });

  try {
    mkdirSync(join(opts.cwd, ".avo"), { recursive: true });
    const before = existsSync(join(opts.cwd, ".avo/.gitignore"));
    ensureTrajectoryIgnored(opts.cwd);
    steps.push({
      name: ".avo/.gitignore",
      action: before ? "unchanged" : "created",
      detail: "keeps the trajectory (attempts, worktrees) out of the lineage",
    });
    const action = writeIfAbsent(
      join(opts.cwd, CONFIG_PATH),
      `${JSON.stringify({ reduce: DEFAULT_CONFIG.reduce, floor: DEFAULT_CONFIG.floor }, null, 2)}\n`,
    );
    steps.push({ name: CONFIG_PATH, action, detail: `reduce: ${DEFAULT_CONFIG.reduce}, floor: ${DEFAULT_CONFIG.floor}` });
  } catch (e) {
    errors.push(`could not scaffold .avo in ${opts.cwd} — ${(e as Error).message}`);
    steps.push({ name: ".avo", action: "failed", detail: (e as Error).message });
    return result();
  }

  if (opts.scorer !== null) {
    const r = initScorer(opts.cwd, opts.scorer, false);
    if (r.ok) steps.push({ name: SCORER_PATH, action: r.action === "unchanged" ? "unchanged" : "created", detail: `template '${opts.scorer}'` });
    else {
      steps.push({ name: SCORER_PATH, action: "failed", detail: r.error ?? "could not scaffold the scorer" });
      errors.push(r.error ?? "could not scaffold the scorer");
    }
  } else if (existsSync(join(opts.cwd, SCORER_PATH))) {
    steps.push({ name: SCORER_PATH, action: "unchanged", detail: "the scorer is already in place" });
  } else {
    steps.push({
      name: SCORER_PATH,
      action: "skipped",
      detail: `no scorer yet — 'avo init --scorer <${listTemplates().join("|")}>' or 'avo score --init <t>' writes one`,
    });
  }

  // K next: qmd is optional too, and runKnowInit creates lineage/ and knowledge/ whether or not it
  // is installed, so the collections exist the moment qmd does.
  const know = await runKnowInit(opts.cwd, runner);
  steps.push(...know.steps);
  warnings.push(...know.warnings);
  errors.push(...know.errors);

  // beads last: it is optional, and everything above must land whether or not it is installed.
  const backend = await resolveBackend(runner, opts.cwd);
  if (backend.kind === "beads") {
    steps.push({
      name: "beads",
      action: "unchanged",
      detail: `bd ${backend.status.version ?? ""} already initialized (prefix '${backend.status.prefix ?? "?"}')`.trim(),
    });
  } else {
    const probe = await runner("bd", ["--version"], { cwd: opts.cwd, timeoutMs: 60_000 });
    if (probe.spawnError !== null || probe.code !== 0) {
      steps.push({ name: "beads", action: "skipped", detail: `bd is not installed; memory falls back to ${MEMORY_PATH}` });
      warnings.push(`bd is not installed; memory falls back to ${MEMORY_PATH} (invariant 4)`);
    } else {
      // --init-if-missing makes this idempotent; --skip-agents leaves AGENTS.md to avo install (S5);
      // --skip-hooks keeps bd out of `avo commit`, whose no-op check needs a clean tree.
      const args = ["init", "--non-interactive", "--init-if-missing", "--skip-agents", "--skip-hooks", "-q"];
      if (opts.prefix !== null) args.push("--prefix", opts.prefix);
      const r = await runner("bd", args, { cwd: opts.cwd, timeoutMs: 300_000 });
      if (r.code !== 0 || r.spawnError !== null) {
        const detail = `${r.stderr}${r.stdout}`.trim().split("\n")[0] ?? `exited ${r.code}`;
        steps.push({ name: "beads", action: "skipped", detail: `bd init failed (${detail}); memory falls back to ${MEMORY_PATH}` });
        warnings.push(`bd init failed (${detail}); memory falls back to ${MEMORY_PATH}`);
      } else {
        const after = await resolveBackend(runner, opts.cwd);
        steps.push({
          name: "beads",
          action: "created",
          detail: `bd initialized (prefix '${after.status.prefix ?? "?"}'); bd commits .beads config files to git`,
        });
      }
    }
  }
  return result();
}

export function renderInit(r: InitResult): string {
  const lines = ["avo init", ""];
  for (const s of r.steps) lines.push(`  ${s.action.padEnd(10)} ${s.name.padEnd(18)} ${s.detail}`);
  lines.push("");
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  for (const e of r.errors) lines.push(`error: ${e}`);
  if (r.warnings.length > 0 || r.errors.length > 0) lines.push("");
  lines.push(r.ok ? "ready — `avo score` measures, `avo commit` persists, `avo mem` remembers" : "init incomplete");
  return `${lines.join("\n")}\n`;
}

export async function initCommand(argv: readonly string[], io: Io, runner: Runner = spawnRunner): Promise<number> {
  const parsed = parseInitArgs(argv);
  if ("error" in parsed) {
    io.err(`${parsed.error}\n`);
    return 2;
  }
  const r = await runInit(parsed, runner);
  if (parsed.json) io.out(`${JSON.stringify(r)}\n`);
  else {
    io.out(renderInit(r));
    for (const e of r.errors) io.err(`avo init: ${e}\n`);
  }
  return r.ok ? 0 : 2;
}
