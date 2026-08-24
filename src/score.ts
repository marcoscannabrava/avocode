import { spawn } from "node:child_process";
import { accessSync, appendFileSync, constants, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Io } from "./io.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Where `f` lives, relative to the target repo root. */
export const SCORER_PATH = ".avo/score";
/** Append-only log of every `avo score` run. Attempts are not commits (PLAN §3). */
export const ATTEMPTS_PATH = ".avo/attempts.jsonl";
/** Scorer output beyond this is truncated; a runaway scorer must not exhaust memory. */
const OUTPUT_CAP = 200_000;

/**
 * The `f` contract — frozen (PLAN §3). `.avo/score` is any executable, run from the repo root:
 *
 *     .avo/score                   score everything; print one JSON line
 *     .avo/score --configs         print config names, one per line (optional; enables --parallel)
 *     .avo/score --config <name>   score one config; print one JSON line
 *
 * It should always exit 0 — correctness and build failures belong *in* the JSON, so the agent
 * receives a diagnosable payload instead of a crash. A non-zero exit is tolerated anyway: avo
 * turns it into a failing attempt rather than crashing (invariant 4).
 *
 * Unknown fields are allowed (scorers may carry their own metadata) but reported as warnings, so a
 * misspelled required key shows up as both "required field missing" and "unknown field".
 */
export const ScoreOutputSchema = Type.Object(
  {
    ok: Type.Boolean(),
    correct: Type.Boolean(),
    primary: Type.Union([Type.Number(), Type.Null()]),
    unit: Type.String({ minLength: 1 }),
    higher_is_better: Type.Boolean(),
    scores: Type.Optional(Type.Record(Type.String(), Type.Number())),
    log: Type.Optional(Type.String()),
    duration_s: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: true },
);

export type ScoreOutput = Static<typeof ScoreOutputSchema>;

const KNOWN_FIELDS: readonly string[] = Object.keys(ScoreOutputSchema.properties);

/**
 * One normalized `avo score` run. This — not the scorer's raw JSON — is what gets logged and what
 * `avo commit` will read.
 */
export interface Attempt {
  ts: string;
  /** Scorer ran *and* produced valid output *and* reported ok. */
  ok: boolean;
  correct: boolean;
  /** The single gate: `ok && correct`. A failing `f` never yields a commit (invariant 2). */
  pass: boolean;
  /**
   * The measured metric, or `null` — the failing sentinel. `null` is the direction-safe
   * generalization of the paper's "zero score": zero is the *best* possible value for a
   * lower-is-better metric, so it cannot mean failure.
   */
  primary: number | null;
  /** Direction-normalized so higher is always better; `null` compares worse than any number. */
  normalized: number | null;
  unit: string;
  higher_is_better: boolean;
  /** The vector form of `f`. `avo commit` compares these, not `primary` (PLAN §6 Q1). */
  scores: Record<string, number>;
  duration_s: number | null;
  /** Configs actually run; `["*"]` for a single whole-repo run. */
  configs: string[];
  parallel: boolean;
  /** Harness-level diagnostics: missing scorer, malformed output, timeout. Empty when ok. */
  errors: string[];
  warnings: string[];
  log: string | null;
  exit_code: number;
  git: { head: string | null; dirty: boolean };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: string | null;
}

export interface RunOpts {
  cwd: string;
  timeoutMs: number;
}

/** Runs one child process. Injected so the command is testable without real scorers. */
export type Runner = (cmd: string, args: readonly string[], opts: RunOpts) => Promise<RunResult>;

export const spawnRunner: Runner = (cmd, args, opts) =>
  new Promise((resolve) => {
    // detached puts the scorer in its own process group, so a timeout can kill the benchmark
    // processes it spawned too. Killing only the scorer leaves them holding our stdio pipes open,
    // and we would wait out the full benchmark despite having "timed out".
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError: string | null = null;
    const timer =
      opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            const pid = child.pid;
            try {
              if (pid !== undefined) process.kill(-pid, "SIGKILL");
              else child.kill("SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }, opts.timeoutMs)
        : null;
    const cap = (s: string, chunk: string) => (s.length >= OUTPUT_CAP ? s : s + chunk);
    child.stdout.on("data", (d: Buffer) => void (stdout = cap(stdout, d.toString())));
    child.stderr.on("data", (d: Buffer) => void (stderr = cap(stderr, d.toString())));
    child.on("error", (e: Error) => void (spawnError = e.message));
    child.on("close", (code) => {
      if (timer !== null) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut, spawnError });
    });
  });

/** `/scores/b1` -> `scores.b1`, so an error message names a field the way a human writes it. */
function fieldName(path: string): string {
  return path.replace(/^\//, "").replaceAll("/", ".");
}

export interface ParseFailure {
  errors: string[];
}

export interface ParseSuccess {
  output: ScoreOutput;
  warnings: string[];
}

export function isParseFailure(r: ParseSuccess | ParseFailure): r is ParseFailure {
  return "errors" in r;
}

/**
 * Validates one line of scorer output. The contract says stdout is a single JSON line, but a
 * scorer that also echoes build noise is far too common to reject: we take the last line that
 * parses as JSON and warn about the rest.
 */
export function parseScoreOutput(stdout: string): ParseSuccess | ParseFailure {
  const lines = stdout.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) {
    return { errors: [`${SCORER_PATH} printed nothing on stdout; expected one JSON line`] };
  }

  const warnings: string[] = [];
  let parsed: unknown;
  let jsonLine = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const candidate: unknown = JSON.parse(lines[i] ?? "");
      if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
        parsed = candidate;
        jsonLine = i;
        break;
      }
    } catch {
      // keep scanning backwards
    }
  }
  if (jsonLine < 0) {
    return {
      errors: [
        `${SCORER_PATH} stdout is not a JSON object; expected one line like ` +
          `{"ok":true,"correct":true,"primary":1.0,"unit":"s","higher_is_better":false}`,
      ],
    };
  }
  if (lines.length > 1) {
    warnings.push(
      `${SCORER_PATH} printed ${lines.length} non-empty stdout lines; used line ${jsonLine + 1} as the result`,
    );
  }

  const errors: string[] = [];
  for (const e of Value.Errors(ScoreOutputSchema, parsed)) {
    errors.push(`field '${fieldName(e.path)}': ${e.message.toLowerCase()} (got ${JSON.stringify(e.value)})`);
  }
  if (errors.length > 0) return { errors };

  const output = parsed as ScoreOutput;
  for (const key of Object.keys(output)) {
    if (!KNOWN_FIELDS.includes(key)) warnings.push(`unknown field '${key}' ignored`);
  }

  // Semantics the schema cannot express.
  if (output.ok && output.correct && !Number.isFinite(output.primary)) {
    errors.push(
      `field 'primary': must be a finite number when ok and correct are true (got ${JSON.stringify(output.primary)})`,
    );
  }
  for (const [cfg, v] of Object.entries(output.scores ?? {})) {
    if (!Number.isFinite(v)) errors.push(`field 'scores.${cfg}': must be a finite number (got ${JSON.stringify(v)})`);
  }
  if (errors.length > 0) return { errors };

  return { output, warnings };
}

/** Config names must be plain tokens — that is also how we detect a scorer with no `--configs`. */
const CONFIG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseConfigList(stdout: string): string[] | null {
  const names = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (names.length === 0) return null;
  if (!names.every((n) => CONFIG_NAME.test(n))) return null;
  return [...new Set(names)];
}

/** Runs `tasks` with at most `limit` in flight, preserving input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

export function concurrencyCap(): number {
  return Math.max(1, Math.min(8, availableParallelism() - 2));
}

function truncate(s: string, max = 8_000): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… [${s.length - max} more characters]`;
}

/** Turns one scorer invocation into either a validated output or a list of harness errors. */
function interpret(run: RunResult, label: string): ParseSuccess | ParseFailure {
  if (run.spawnError !== null) return { errors: [`${label}: could not execute ${SCORER_PATH} — ${run.spawnError}`] };
  if (run.timedOut) return { errors: [`${label}: ${SCORER_PATH} exceeded the timeout and was killed`] };
  const parsed = parseScoreOutput(run.stdout);
  if (isParseFailure(parsed)) {
    const suffix = run.code !== 0 ? ` (it also exited ${run.code})` : "";
    return { errors: parsed.errors.map((e) => `${label}: ${e}${suffix}`) };
  }
  return { ...parsed, warnings: parsed.warnings.map((w) => `${label}: ${w}`) };
}

/**
 * Reduces one-or-more scorer outputs into an Attempt.
 *
 * With several configs, `primary` becomes their arithmetic mean — informative for a human, but not
 * the commit criterion: `avo commit` compares the `scores` vector (PLAN §6 Q1).
 */
export function normalize(
  parts: readonly { config: string; result: ParseSuccess | ParseFailure }[],
  meta: { ts: string; parallel: boolean; exitCode: number; git: Attempt["git"]; durationS: number },
): Attempt {
  const errors = parts.flatMap((p) => (isParseFailure(p.result) ? p.result.errors : []));
  const good = parts.flatMap((p) => (isParseFailure(p.result) ? [] : [{ config: p.config, ...p.result }]));
  const warnings = good.flatMap((g) => g.warnings);

  const outputs = good.map((g) => g.output);
  const first = outputs[0];
  const ok = errors.length === 0 && outputs.length > 0 && outputs.every((o) => o.ok);
  const correct = outputs.length > 0 && outputs.every((o) => o.correct);
  const pass = ok && correct;

  const scores: Record<string, number> = {};
  for (const g of good) {
    const own = g.output.scores;
    if (own !== undefined && Object.keys(own).length > 0) Object.assign(scores, own);
    else if (g.config !== "*" && typeof g.output.primary === "number") scores[g.config] = g.output.primary;
  }

  const primaries = outputs.map((o) => o.primary).filter((p): p is number => typeof p === "number");
  const primary = pass && primaries.length > 0 ? primaries.reduce((a, b) => a + b, 0) / primaries.length : null;
  const higherIsBetter = first?.higher_is_better ?? true;

  const logs = good.map((g) => g.output.log).filter((l): l is string => typeof l === "string" && l !== "");

  return {
    ts: meta.ts,
    ok,
    correct,
    pass,
    primary,
    normalized: primary === null ? null : higherIsBetter ? primary : -primary,
    unit: first?.unit ?? "",
    higher_is_better: higherIsBetter,
    scores,
    // A single scorer's self-reported duration is more meaningful than our wall clock (it excludes
    // process startup); across configs only the wall clock describes the fan-out.
    duration_s:
      outputs.length === 1 && typeof first?.duration_s === "number" ? first.duration_s : meta.durationS,
    configs: parts.map((p) => p.config),
    parallel: meta.parallel,
    errors,
    warnings,
    log: logs.length > 0 ? truncate(logs.join("\n")) : null,
    exit_code: meta.exitCode,
    git: meta.git,
  };
}

export function renderAttempt(a: Attempt): string {
  const lines: string[] = ["avo score", ""];
  const row = (k: string, v: string) => lines.push(`  ${k.padEnd(12)} ${v}`);
  row("ok", a.ok ? "yes" : "no");
  row("correct", a.correct ? "yes" : "no");
  const dir = a.higher_is_better ? "higher is better" : "lower is better";
  row("primary", a.primary === null ? `— (failing sentinel; ${dir})` : `${a.primary} ${a.unit} (${dir})`);
  const cfgs = Object.entries(a.scores);
  if (cfgs.length > 0) row("scores", cfgs.map(([k, v]) => `${k}=${v}`).join("  "));
  if (a.duration_s !== null) row("duration", `${a.duration_s}s`);
  row("configs", `${a.configs.join(", ")}${a.parallel ? " (parallel)" : ""}`);
  lines.push("");
  for (const w of a.warnings) lines.push(`warning: ${w}`);
  for (const e of a.errors) lines.push(`error: ${e}`);
  if (a.errors.length > 0 || a.warnings.length > 0) lines.push("");
  if (a.log !== null) lines.push(a.log, "");
  lines.push(a.pass ? "pass" : a.errors.length > 0 ? "error — the scorer did not produce a usable result" : "fail");
  return `${lines.join("\n")}\n`;
}

export function templatesDir(): string {
  return join(repoRoot, "templates", "score");
}

export function listTemplates(): string[] {
  try {
    return readdirSync(templatesDir())
      .filter((f) => f.endsWith(".sh"))
      .map((f) => f.replace(/\.sh$/, ""))
      .sort();
  } catch {
    return [];
  }
}

export type InitAction = "created" | "unchanged" | "overwritten";

export interface InitResult {
  ok: boolean;
  action?: InitAction;
  template?: string;
  path?: string;
  error?: string;
}

/**
 * Scaffolds `.avo/score` from a template. Idempotent: an identical existing scorer is left alone;
 * a *different* one is never clobbered without `--force` (invariant 5).
 */
export function initScorer(cwd: string, template: string, force: boolean): InitResult {
  const available = listTemplates();
  if (!available.includes(template)) {
    return { ok: false, error: `unknown template '${template}'; available: ${available.join(", ") || "(none)"}` };
  }
  const src = join(templatesDir(), `${template}.sh`);
  const dest = join(cwd, SCORER_PATH);
  const body = readFileSync(src, "utf8");

  let existing: string | null = null;
  try {
    existing = readFileSync(dest, "utf8");
  } catch {
    existing = null;
  }
  if (existing !== null && !force) {
    if (existing === body) return { ok: true, action: "unchanged", template, path: SCORER_PATH };
    return {
      ok: false,
      error: `${SCORER_PATH} already exists and differs from the '${template}' template; re-run with --force to replace it`,
    };
  }

  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, body, { mode: 0o755 });
  return { ok: true, action: existing === null ? "created" : "overwritten", template, path: SCORER_PATH };
}

export interface ScoreOptions {
  json: boolean;
  parallel: boolean;
  timeoutS: number;
  init: string | null;
  force: boolean;
  record: boolean;
  cwd: string;
}

export function parseScoreArgs(argv: readonly string[]): ScoreOptions | { error: string } {
  const opts: ScoreOptions = {
    json: false,
    parallel: false,
    timeoutS: 0,
    init: null,
    force: false,
    record: true,
    cwd: process.cwd(),
  };
  const need = (i: number, flag: string): string | { error: string } => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("-")) return { error: `avo score: ${flag} needs a value` };
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      case "--parallel":
        opts.parallel = true;
        break;
      case "--force":
        opts.force = true;
        break;
      case "--no-record":
        opts.record = false;
        break;
      case "--init": {
        const v = need(i, "--init");
        if (typeof v !== "string") return v;
        opts.init = v;
        i++;
        break;
      }
      case "--cwd": {
        const v = need(i, "--cwd");
        if (typeof v !== "string") return v;
        opts.cwd = v;
        i++;
        break;
      }
      case "--timeout": {
        const v = need(i, "--timeout");
        if (typeof v !== "string") return v;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) return { error: `avo score: --timeout needs a non-negative number, got '${v}'` };
        opts.timeoutS = n;
        i++;
        break;
      }
      default:
        return { error: `avo score: unknown option '${a}'` };
    }
  }
  return opts;
}

async function readGit(runner: Runner, cwd: string): Promise<Attempt["git"]> {
  const head = await runner("git", ["rev-parse", "HEAD"], { cwd, timeoutMs: 10_000 });
  if (head.code !== 0 || head.spawnError !== null) return { head: null, dirty: false };
  const status = await runner("git", ["status", "--porcelain"], { cwd, timeoutMs: 10_000 });
  return { head: head.stdout.trim(), dirty: status.stdout.trim() !== "" };
}

/** Result codes: 0 = pass, 1 = ran but failed, 2 = harness error (usage, no scorer, bad output). */
export async function scoreCommand(
  argv: readonly string[],
  io: Io,
  runner: Runner = spawnRunner,
  now: () => Date = () => new Date(),
): Promise<number> {
  const parsed = parseScoreArgs(argv);
  if ("error" in parsed) {
    io.err(`${parsed.error}\n`);
    return 2;
  }
  const opts = parsed;

  if (opts.init !== null) {
    const r = initScorer(opts.cwd, opts.init, opts.force);
    if (opts.json) io.out(`${JSON.stringify(r)}\n`);
    else if (r.ok) io.out(`avo score --init: ${r.path} ${r.action} from template '${r.template}'\n`);
    else io.err(`avo score --init: ${r.error}\n`);
    return r.ok ? 0 : 2;
  }

  const scorer = join(opts.cwd, SCORER_PATH);
  const fail = (msg: string): number => {
    if (opts.json) io.out(`${JSON.stringify({ ok: false, pass: false, errors: [msg] })}\n`);
    else io.err(`avo score: ${msg}\n`);
    return 2;
  };
  try {
    accessSync(scorer, constants.X_OK);
  } catch {
    const templates = listTemplates().join("|");
    return fail(
      `no executable ${SCORER_PATH} in ${opts.cwd} — scaffold one with 'avo score --init <${templates}>' ` +
        `(or 'chmod +x ${SCORER_PATH}' if it exists but is not executable)`,
    );
  }

  const timeoutMs = opts.timeoutS * 1000;
  const started = Date.now();
  const warmupWarnings: string[] = [];

  let configs: string[] | null = null;
  if (opts.parallel) {
    const probe = await runner(scorer, ["--configs"], { cwd: opts.cwd, timeoutMs });
    configs = probe.code === 0 ? parseConfigList(probe.stdout) : null;
    if (configs === null) {
      warmupWarnings.push(
        `--parallel requested but ${SCORER_PATH} --configs listed no usable config names; ran a single serial pass`,
      );
    }
  }

  const parts =
    configs === null
      ? [
          {
            config: "*",
            run: await runner(scorer, [], { cwd: opts.cwd, timeoutMs }),
          },
        ]
      : await mapLimit(configs, concurrencyCap(), async (config) => ({
          config,
          run: await runner(scorer, ["--config", config], { cwd: opts.cwd, timeoutMs }),
        }));

  const durationS = Math.round((Date.now() - started) / 100) / 10;
  const interpreted = parts.map((p) => ({ config: p.config, result: interpret(p.run, p.config) }));
  const attempt = normalize(interpreted, {
    ts: now().toISOString(),
    parallel: configs !== null,
    exitCode: parts.find((p) => p.run.code !== 0)?.run.code ?? 0,
    git: await readGit(runner, opts.cwd),
    durationS,
  });
  attempt.warnings.unshift(...warmupWarnings);
  if (attempt.errors.length > 0 && attempt.log === null) {
    const noise = parts.map((p) => `${p.run.stdout}${p.run.stderr}`).join("\n").trim();
    if (noise !== "") attempt.log = truncate(noise);
  }

  if (opts.record) {
    try {
      mkdirSync(join(opts.cwd, dirname(ATTEMPTS_PATH)), { recursive: true });
      appendFileSync(join(opts.cwd, ATTEMPTS_PATH), `${JSON.stringify(attempt)}\n`);
    } catch (e) {
      attempt.warnings.push(`could not record the attempt in ${ATTEMPTS_PATH} — ${(e as Error).message}`);
    }
  }

  io.out(opts.json ? `${JSON.stringify(attempt)}\n` : renderAttempt(attempt));
  if (attempt.errors.length > 0) return 2;
  return attempt.pass ? 0 : 1;
}
