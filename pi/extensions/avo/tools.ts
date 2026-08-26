/**
 * The native Pi tools: thin wrappers over `src/`, one per capability the CLI already exposes.
 *
 * "Thin" is the whole design. Invariant 8 says every capability must be reachable from bash before
 * it gets a Pi binding, and S1..S7 built exactly that, so nothing here decides anything: the commit
 * rule is `decideCommit`, the `f` contract `runScore`, the guards `runFan`. A second implementation
 * of any of them is a second thing that can disagree with the CLI, and an operator running
 * `avo commit` in one terminal and `avo_commit` in Pi would get two answers about P_t.
 *
 * Each result splits the way Pi's docs ask:
 *   - `content` is the CLI's OWN renderer, verbatim. The model reads what a human reads.
 *   - `details` is the structured result, because Pi reconstructs extension state from tool-result
 *     details when a session branches (docs/extensions.md, "State Management"). The supervisor
 *     recovers its counters from these, so they must be complete.
 *
 * Lives under `pi/`, not `src/`, for one reason: the schemas need `typebox` at RUNTIME, and
 * `typebox` (v1, what Pi resolves — NOT the `@sinclair/typebox` v0.34 `src/` uses, a different
 * package with a different `TSchema`) is a devDependency. `src/` must work in a Pi-less checkout.
 */

import { relative, resolve } from "node:path";
import { defineTool, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  knowAdd,
  knowQuery,
  renderQuery,
  resolveKnowledge,
  type AddResult,
  type QueryResult,
} from "../../../src/knowledge.ts";
import {
  bestVersion,
  decideCommit,
  readLineage,
  renderDecision,
  renderLineage,
  renderVersion,
  type CommitDecision,
  type Lineage,
  type Version,
} from "../../../src/lineage.ts";
import { loadConfig } from "../../../src/config.ts";
import { renderAttempt, runScore, spawnRunner, type Attempt, type Runner } from "../../../src/score.ts";
import { parseFanArgs, renderFan, runFan, type FanResult } from "../../../src/fan.ts";
import { globalFetcher, type Fetcher } from "../../../src/websearch.ts";

/**
 * The tools' only reach outside. Injected so tests drive every branch with no repo, network or agent
 * binary; the defaults are what Pi gets.
 */
export interface PiToolDeps {
  runner: Runner;
  fetcher: Fetcher;
  now: () => Date;
  env: NodeJS.ProcessEnv;
}

export function defaultDeps(): PiToolDeps {
  return { runner: spawnRunner, fetcher: globalFetcher, now: () => new Date(), env: process.env };
}

/** The six tool names, in the order they are registered. Exported so the tests cannot drift. */
export const AVO_TOOL_NAMES = [
  "avo_score",
  "avo_commit",
  "avo_lineage",
  "avo_know_query",
  "avo_know_add",
  "avo_fan",
] as const;

const text = (s: string) => [{ type: "text" as const, text: s }];

/**
 * `ctx.cwd` is the ONLY source of the repo root. No tool takes a `cwd`, deliberately: an agent that
 * can retarget the repo can write a version into a repo nobody is watching.
 */
const repoOf = (ctx: ExtensionContext): string => ctx.cwd;

/**
 * A harness error throws, because Pi sets `isError` only when `execute` throws — a returned object
 * never marks a failure, however shaped (docs/extensions.md, "Signaling errors"). A REFUSAL is not
 * an error: `avo commit` declining a candidate is a measurement the model should act on. The same
 * split the CLI's exit codes make (2 = harness error, 1 = refused).
 */
function harnessError(message: string): never {
  throw new Error(message);
}

// ---------------------------------------------------------------------------
// avo_score
// ---------------------------------------------------------------------------

const scoreTool = (deps: PiToolDeps): ToolDefinition =>
  defineTool({
    name: "avo_score",
    label: "avo score",
    description:
      "Run the repo's fitness function .avo/score (the f contract) once against the CURRENT working " +
      "tree and return the normalized attempt: whether it passed correctness, the score per config, " +
      "and the scorer's log. Records the attempt in .avo/attempts.jsonl, which is what the supervisor " +
      "reads. Does not commit anything.",
    promptSnippet: "Measure the working tree with the repo's .avo/score fitness function",
    promptGuidelines: [
      "Use avo_score to measure a change before deciding whether to keep it; never guess at a score or read one from a previous turn.",
      "avo_score measures the working tree as it is now, so make the edit first and score after.",
    ],
    // Sequential: the scorer is a process, the attempt log is repo-global, and two concurrent
    // scores fight over whatever the scorer builds into.
    executionMode: "sequential",
    parameters: Type.Object({
      parallel: Type.Optional(
        Type.Boolean({
          description: "Fan the scorer's declared configs out concurrently. Requires '.avo/score --configs'.",
        }),
      ),
      timeout_s: Type.Optional(
        Type.Number({ minimum: 0, description: "Kill the scorer after this many seconds. 0 (the default) means no limit." }),
      ),
      record: Type.Optional(
        Type.Boolean({ description: "Append the attempt to .avo/attempts.jsonl. Default true; the supervisor reads that log." }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = params;
      const { attempt, error } = await runScore(
        {
          json: false,
          parallel: p.parallel ?? false,
          timeoutS: p.timeout_s ?? 0,
          init: null,
          force: false,
          record: p.record ?? true,
          cwd: repoOf(ctx),
        },
        deps.runner,
        deps.now,
      );
      // Nothing ran — no scorer, or not executable. No attempt to reason about, and the model
      // must not read it as "it scored badly".
      if (attempt === null) harnessError(error ?? "avo score: the scorer did not run");
      return { content: text(renderAttempt(attempt)), details: attempt satisfies Attempt };
    },
  });

// ---------------------------------------------------------------------------
// avo_commit
// ---------------------------------------------------------------------------

const commitTool = (deps: PiToolDeps): ToolDefinition =>
  defineTool({
    name: "avo_commit",
    label: "avo commit",
    description:
      "Score the working tree, compare it against the best committed version under the repo's " +
      "reduction rule, and persist it as the next version ONLY if it wins. This is the only way a " +
      "version enters the lineage. Returns the decision: committed, refused (with which config " +
      "regressed), or noop (nothing changed). A refusal is a normal, useful answer — not an error.",
    promptSnippet: "Score the working tree and commit it as the next version only if it beats the best",
    promptGuidelines: [
      "Use avo_commit rather than a git commit for any change meant to become a version; it is the only writer of the lineage.",
      "avo_commit requires a rationale in `why`: write what you changed and what you expected, because the supervisor cites it back to you later.",
      "A refusal from avo_commit is a measurement. Read which config regressed and change direction rather than re-running it unchanged.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      why: Type.String({
        minLength: 1,
        description:
          "The rationale: what you changed and why you expected it to help. Recorded in the commit and in lineage/vNNN.md.",
      }),
      dry_run: Type.Optional(
        // "Creates no version", not "writes nothing": the candidate is still scored, so the
        // attempt lands in .avo/attempts.jsonl like any other.
        Type.Boolean({ description: "Score and compare, and report the decision, but create no version." }),
      ),
      parallel: Type.Optional(Type.Boolean({ description: "Fan the scorer's configs out concurrently." })),
      timeout_s: Type.Optional(Type.Number({ minimum: 0, description: "Kill the scorer after this many seconds. 0 = no limit." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = params;
      // `why` is REQUIRED here while the CLI's --why is optional: a Pi turn always has the
      // rationale in hand, and S7's directive is only worth reading because it quotes a real one.
      if (p.why.trim() === "") harnessError("avo_commit: `why` is empty — the lineage records rationales, not just diffs");
      const decision = await decideCommit(
        {
          json: false,
          parallel: p.parallel ?? false,
          timeoutS: p.timeout_s ?? 0,
          init: null,
          force: false,
          record: true,
          cwd: repoOf(ctx),
          why: p.why,
          dryRun: p.dry_run ?? false,
        },
        deps.runner,
        deps.now,
      );
      return { content: text(renderDecision(decision)), details: decision satisfies CommitDecision };
    },
  });

// ---------------------------------------------------------------------------
// avo_lineage
// ---------------------------------------------------------------------------

export interface LineageDetails {
  versions: Version[];
  warnings: string[];
  best: { version: number; sha: string } | null;
  /** Set when `version` was given and matched; null for the list view. */
  version: Version | null;
}

const lineageTool = (deps: PiToolDeps): ToolDefinition =>
  defineTool({
    name: "avo_lineage",
    label: "avo lineage",
    description:
      "Read P_t, the committed lineage: every version with its score per config and the rationale " +
      "recorded with it. With no argument, the table plus which version is currently best. With " +
      "`version`, that one version in full including its --why. Read-only.",
    promptSnippet: "List the committed versions with their scores, or show one version in full",
    promptGuidelines: [
      "Call avo_lineage before proposing a change, so you do not re-try a direction a previous version already recorded.",
    ],
    parameters: Type.Object({
      version: Type.Optional(
        Type.Number({ minimum: 1, description: "Show this version in full (its scores and its recorded rationale) instead of the list." }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = params;
      const cwd = repoOf(ctx);
      const lineage: Lineage = await readLineage(deps.runner, cwd);
      const best = bestVersion(lineage.versions);
      const bestRef = best === null ? null : { version: best.version, sha: best.sha };
      if (p.version !== undefined) {
        const found = lineage.versions.find((v) => v.version === p.version) ?? null;
        if (found === null) {
          const known = lineage.versions.map((v) => `v${v.version}`).join(", ");
          harnessError(
            `avo_lineage: no v${p.version} in the lineage${known === "" ? " (it is empty)" : ` — it has ${known}`}`,
          );
        }
        const details: LineageDetails = { versions: lineage.versions, warnings: lineage.warnings, best: bestRef, version: found };
        return { content: text(renderVersion(found)), details };
      }
      const { config } = loadConfig(cwd);
      const details: LineageDetails = { versions: lineage.versions, warnings: lineage.warnings, best: bestRef, version: null };
      return { content: text(renderLineage(lineage, config)), details };
    },
  });

// ---------------------------------------------------------------------------
// avo_know_query
// ---------------------------------------------------------------------------

const knowQueryTool = (deps: PiToolDeps): ToolDefinition =>
  defineTool({
    name: "avo_know_query",
    label: "avo know query",
    description:
      "Search K, the repo's knowledge base (knowledge/ and the rendered lineage/), for documentation, " +
      "papers and notes relevant to a question. Hybrid retrieval with rerank when qmd is installed, a " +
      "local scan otherwise — either way it says which backend answered. Read-only.",
    promptSnippet: "Search the repo's knowledge base K for documentation and prior findings",
    promptGuidelines: [
      "Search K with avo_know_query before proposing a technical approach; the repo may already hold the reference you are about to guess at.",
    ],
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "What you want to know, as a question or a phrase." }),
      n: Type.Optional(Type.Number({ minimum: 1, description: "Maximum hits. Default 5." })),
      collection: Type.Optional(Type.String({ description: "Restrict to one collection, e.g. 'knowledge' or 'lineage'." })),
      lexical: Type.Optional(
        Type.Boolean({ description: "BM25 only — no LLM query expansion and no rerank. Fast and deterministic." }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = params;
      const cwd = repoOf(ctx);
      const backend = await resolveKnowledge(deps.runner, cwd);
      const result = await knowQuery(deps.runner, cwd, backend, p.query, {
        n: p.n ?? 5,
        collection: p.collection ?? null,
        lexical: p.lexical ?? false,
        minScore: null,
        timeoutMs: 0,
      });
      return { content: text(renderQuery(result)), details: result satisfies QueryResult };
    },
  });

// ---------------------------------------------------------------------------
// avo_know_add
// ---------------------------------------------------------------------------

const knowAddTool = (deps: PiToolDeps): ToolDefinition =>
  defineTool({
    name: "avo_know_add",
    label: "avo know add",
    description:
      "Grow K by ingesting a URL or a local file into knowledge/<slug>.md with provenance " +
      "frontmatter, then embedding it so avo_know_query can find it. Use it when you had to go " +
      "outside the repo for something a later turn will need again.",
    promptSnippet: "Ingest a URL or file into the repo's knowledge base K, with provenance",
    promptGuidelines: [
      "When avo_know_query finds nothing and you had to look a fact up elsewhere, add the source with avo_know_add so the next turn does not repeat the search.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      target: Type.String({ minLength: 1, description: "An http(s) URL, or a path to a local file, to ingest into K." }),
      name: Type.Optional(Type.String({ description: "Slug for the doc. Defaults to one derived from the URL or filename." })),
      force: Type.Optional(Type.Boolean({ description: "Replace an existing doc of the same name whose content differs." })),
      no_embed: Type.Optional(Type.Boolean({ description: "Skip the qmd embed step; useful when adding many docs at once." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = params;
      const cwd = repoOf(ctx);
      const backend = await resolveKnowledge(deps.runner, cwd);
      // Models sometimes prefix paths with @; pi's built-ins strip it and the docs ask custom
      // tools to. A URL never starts with @, and the path is then confined to the repo.
      const raw = p.target.startsWith("@") ? p.target.slice(1) : p.target;
      const target = /^https?:\/\//i.test(raw) ? raw : confineToRepo(cwd, raw);
      const result = await knowAdd(
        deps.runner,
        deps.fetcher,
        deps.env,
        cwd,
        backend,
        target,
        { name: p.name ?? null, force: p.force ?? false, noEmbed: p.no_embed ?? false, backend: null, timeoutMs: 0 },
        deps.now,
      );
      const head = result.ok
        ? `avo know add — ${result.action} ${result.path ?? ""} (${result.bytes} bytes via ${result.source}${result.embedded ? ", embedded" : ""})`
        : `avo know add — ${result.action}: ${result.error ?? "unknown"}`;
      const lines = [head, ...result.warnings.map((w) => `warning: ${w}`)];
      return { content: text(`${lines.join("\n")}\n`), details: result satisfies AddResult };
    },
  });

/** A local ingest target that escapes the repo is refused, not silently read. */
function confineToRepo(cwd: string, target: string): string {
  const abs = resolve(cwd, target);
  const rel = relative(cwd, abs);
  if (rel === "" || rel.startsWith("..")) {
    harnessError(`avo_know_add: '${target}' is outside the repo; K holds this repo's knowledge`);
  }
  return abs;
}

// ---------------------------------------------------------------------------
// avo_fan
// ---------------------------------------------------------------------------

const fanTool = (deps: PiToolDeps): ToolDefinition =>
  defineTool({
    name: "avo_fan",
    label: "avo fan",
    description:
      "Explore several directions at once: N git worktrees, N headless agent processes each given " +
      "the same prompt, each candidate scored by .avo/score. Returns every probe's score, diffstat " +
      "and summary, and names the best PASSING one. Promotion is a separate, explicit step — this " +
      "never touches the root working tree or HEAD. Expensive; use it when you genuinely cannot " +
      "tell which direction is better by reading.",
    promptSnippet: "Try N directions in parallel worktrees with small-model agents, and score each",
    promptGuidelines: [
      "Reach for avo_fan only when a step has several plausible directions and reading cannot separate them; one direction you believe in is cheaper to just try.",
      "avo_fan leaves the working tree untouched, so promoting a winner is a separate step you must take yourself.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, description: "The task every probe is given. Each probe is a fresh agent with no other context." }),
      n: Type.Optional(Type.Number({ minimum: 1, description: "How many probes. Default 3; they run min(8, cpus-2) at a time." })),
      agent: Type.Optional(Type.String({ description: "Which agent to drive: pi | claude | codex | a custom one from .avo/config.json." })),
      model: Type.Optional(Type.String({ description: "The probe model. Small models are the point here; defaults to $AVO_PROBE_MODEL." })),
      timeout_s: Type.Optional(Type.Number({ minimum: 0, description: "Kill a probe's process group after this many seconds. Default 900." })),
      keep: Type.Optional(Type.Boolean({ description: "Keep every worktree, including the ones no probe changed." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = params;
      // Through parseFanArgs, not a hand-made FanOptions: defaults, env fallbacks ($AVO_AGENT,
      // $AVO_PROBE_MODEL) and later flags all come from one place.
      const argv = ["--prompt", p.prompt, "--cwd", repoOf(ctx)];
      if (p.n !== undefined) argv.push("--n", String(p.n));
      if (p.agent !== undefined) argv.push("--agent", p.agent);
      if (p.model !== undefined) argv.push("--model", p.model);
      if (p.timeout_s !== undefined) argv.push("--timeout", String(p.timeout_s));
      if (p.keep === true) argv.push("--keep");
      const opts = parseFanArgs(argv, deps.env);
      if ("error" in opts) harnessError(`avo_fan: ${opts.error}`);
      const result = await runFan(opts, { runner: deps.runner, now: deps.now, env: deps.env });
      // A guard refusal arrives as an error string: a refusal, not a crash, but also the one case
      // where no probe ran, so the model must not read it as a fan-out that found nothing.
      if ("error" in result) harnessError(`avo_fan: ${result.error}`);
      return { content: text(renderFan(result)), details: result satisfies FanResult };
    },
  });

// ---------------------------------------------------------------------------

/**
 * Every avo tool, in registration order. A factory, not a constant: the deps are injected, and Pi's
 * docs are explicit that a factory may run in an invocation that never starts a session — so nothing
 * here touches the filesystem or spawns until `execute` is called.
 */
export function avoTools(deps: PiToolDeps = defaultDeps()): ToolDefinition[] {
  return [scoreTool(deps), commitTool(deps), lineageTool(deps), knowQueryTool(deps), knowAddTool(deps), fanTool(deps)];
}
