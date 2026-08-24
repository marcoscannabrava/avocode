import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { Io } from "./io.ts";
import { LINEAGE_DIR } from "./lineage.ts";
import { spawnRunner, type RunResult, type Runner } from "./score.ts";
import type { InitStep } from "./steps.ts";
import {
  FIRECRAWL_KEY,
  firecrawlScrape,
  globalFetcher,
  SEARCH_BACKENDS,
  webSearch,
  type Fetcher,
  type SearchBackendKind,
  type SearchResult,
} from "./websearch.ts";

/**
 * `K` — the domain knowledge base. qmd (hybrid BM25 + vector + local rerank) indexes two
 * collections: `knowledge/` (what we were told) and `lineage/` (what we learned), so the agent can
 * semantically search its own history with the same tool it uses for docs (PLAN §3).
 *
 * qmd is an *optional* dependency and, as with `bd` in S3, its absence is the common path: the
 * fallback below answers the same query with the same JSON shape, so an agent never has to know
 * whether qmd was installed (invariant 3, invariant 4).
 */
export const QMD = "qmd";
export const KNOWLEDGE_DIR = "knowledge";
/** qmd's project-local index. Created by `qmd init`; machine-local, never committed. */
export const QMD_DIR = ".qmd";
export const QMD_CONFIG = ".qmd/index.yml";
export const QMD_IGNORE = ".qmd/.gitignore";
/** Only markdown is indexed — qmd's collection pattern is `**\/*.md`, and the fallback matches it. */
export const INDEXED_EXT = ".md";

const QUERY_TIMEOUT_MS = 180_000;
const EMBED_TIMEOUT_MS = 1_800_000;
const PROBE_TIMEOUT_MS = 30_000;
const SCRAPE_TIMEOUT_MS = 120_000;
/** A knowledge doc beyond this is truncated: `K` is for reading, not for archiving. */
const DOC_CAP = 400_000;

/** The two collections avo owns, with the descriptions that become `qmd context add` entries. */
export const COLLECTIONS: readonly { name: string; dir: string; context: string }[] = [
  {
    name: "knowledge",
    dir: KNOWLEDGE_DIR,
    context: "domain knowledge K: reference docs, papers and notes the agent may consult while varying a candidate",
  },
  {
    name: "lineage",
    dir: LINEAGE_DIR,
    context: "the lineage P_t: one rendered file per committed version, with its scores, parent and rationale",
  },
];

export interface QmdStatus {
  /** Installed *and* this repo has a project-local index — the only state qmd is usable in. */
  available: boolean;
  installed: boolean;
  /** Why qmd is unusable, phrased so it names the fix. Shown verbatim. */
  reason: string | null;
  version: string | null;
  /** Collection names read from `.qmd/index.yml`. */
  collections: string[];
}

export type KnowledgeBackendKind = "qmd" | "files";

export interface KnowledgeBackend {
  kind: KnowledgeBackendKind;
  status: QmdStatus;
  /** Emitted once per command, never once per hit. */
  warnings: string[];
}

/** One search hit. Identical whichever backend produced it. */
export interface Hit {
  /** Repo-relative path, so an agent can read the file straight from it. */
  file: string;
  line: number;
  title: string | null;
  /** 0..1, higher is better. qmd's own relevance, or coverage from the fallback. */
  score: number;
  snippet: string;
  collection: string | null;
}

export async function qmd(runner: Runner, cwd: string, args: readonly string[], timeoutMs: number): Promise<RunResult> {
  return await runner(QMD, args, { cwd, timeoutMs });
}

function why(r: RunResult): string {
  const text = `${r.stderr}${r.stdout}`.trim().split("\n")[0] ?? "";
  return text === "" ? `exited ${r.code}` : text;
}

/**
 * Collection names out of `.qmd/index.yml`.
 *
 * Deliberately not a YAML parser: the file is machine-written by qmd with a fixed two-space shape,
 * and the only thing we need from it is which collections exist, which is exactly what makes
 * `avo know init` idempotent. A hand-edited file that does not match simply reports no collections,
 * and `qmd collection add` then reports 'already exists' harmlessly.
 */
export function readQmdCollections(cwd: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(join(cwd, QMD_CONFIG), "utf8");
  } catch {
    return [];
  }
  const names: string[] = [];
  let inCollections = false;
  for (const line of raw.split("\n")) {
    if (/^collections:\s*$/.test(line)) {
      inCollections = true;
      continue;
    }
    if (!inCollections) continue;
    if (/^\S/.test(line)) break;
    const m = /^ {2}([A-Za-z0-9][A-Za-z0-9._-]*):\s*$/.exec(line);
    if (m?.[1] !== undefined) names.push(m[1]);
  }
  return names;
}

/**
 * Two questions, one spawn plus one file read: is qmd installed, and does *this repo* have an
 * index. The second matters because without `qmd init` qmd silently uses the user's global index
 * at `~/.cache/qmd`, which would mix one repo's knowledge into every other repo's searches.
 */
export async function probeQmd(runner: Runner, cwd: string): Promise<QmdStatus> {
  const r = await qmd(runner, cwd, ["--version"], PROBE_TIMEOUT_MS);
  if (r.spawnError !== null) {
    return { available: false, installed: false, reason: `qmd is not installed (${r.spawnError})`, version: null, collections: [] };
  }
  if (r.timedOut) {
    return { available: false, installed: false, reason: "qmd --version timed out", version: null, collections: [] };
  }
  if (r.code !== 0) {
    return { available: false, installed: false, reason: `qmd --version failed (${why(r)})`, version: null, collections: [] };
  }
  const version = r.stdout.trim().split("\n")[0]?.trim() ?? null;
  if (!existsSync(join(cwd, QMD_CONFIG))) {
    return {
      available: false,
      installed: true,
      reason: `qmd is installed but this repo has no index; run 'avo know init'`,
      version,
      collections: [],
    };
  }
  return { available: true, installed: true, reason: null, version, collections: readQmdCollections(cwd) };
}

/** Resolves the backend once per command, so the degradation warning is emitted exactly once. */
export async function resolveKnowledge(runner: Runner, cwd: string): Promise<KnowledgeBackend> {
  const status = await probeQmd(runner, cwd);
  if (status.available) return { kind: "qmd", status, warnings: [] };
  return {
    kind: "files",
    status,
    warnings: [`${status.reason ?? "qmd is unavailable"}; knowledge search falls back to a local scan of ${COLLECTIONS.map((c) => `${c.dir}/`).join(" and ")}`],
  };
}

// ---------------------------------------------------------------------------
// the local fallback
// ---------------------------------------------------------------------------

/** Words too common to discriminate. Short on purpose: over-filtering loses real query terms. */
const STOPWORDS = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "is", "it", "for", "on", "how", "do", "does", "i", "we", "with", "that", "this", "be", "are", "was", "can"]);

export function queryTerms(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  // Everything filtered out means the query was all stopwords; keep them rather than match nothing.
  return terms.length > 0 ? [...new Set(terms)] : [...new Set(query.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t !== ""))];
}

function walkMarkdown(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.startsWith(".")) continue;
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkMarkdown(full, out);
    else if (e.endsWith(INDEXED_EXT)) out.push(full);
  }
}

export interface DocRef {
  /** Repo-relative path, so an agent can read the doc straight from it. */
  file: string;
  title: string | null;
  collection: string;
}

/**
 * Every doc in a collection, unranked. `localSearch` answers "what matches this query"; this answers
 * "what is in `K` at all", which is the question the supervisor asks when it wants a direction the
 * lineage has never mentioned — a search cannot find what nobody thought to query for.
 */
export function listDocs(cwd: string, collection: string | null = null): DocRef[] {
  const docs: DocRef[] = [];
  for (const c of COLLECTIONS) {
    if (collection !== null && c.name !== collection) continue;
    const files: string[] = [];
    walkMarkdown(join(cwd, c.dir), files);
    for (const full of files) {
      let title: string | null = null;
      try {
        title = firstHeading(readFileSync(full, "utf8").split("\n"));
      } catch {
        continue;
      }
      docs.push({ file: relative(cwd, full).split(sep).join("/"), title, collection: c.name });
    }
  }
  docs.sort((a, b) => a.file.localeCompare(b.file));
  return docs;
}

/**
 * The keyless fallback: term-coverage search over the same files qmd would index.
 *
 * It is not BM25 and does not pretend to be — `score` is the fraction of distinct query terms the
 * document contains, so it is comparable against a `--min-score` threshold and means the same thing
 * in both backends: 1 is "every term is here". Ranking within a score ties on total term hits.
 */
export function localSearch(cwd: string, query: string, limit: number): Hit[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const scored: (Hit & { hits: number })[] = [];
  for (const c of COLLECTIONS) {
    const files: string[] = [];
    walkMarkdown(join(cwd, c.dir), files);
    for (const full of files) {
      let text: string;
      try {
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      const matched = new Set<string>();
      let hits = 0;
      let bestLine = 0;
      let bestLineTerms = 0;
      for (let i = 0; i < lines.length; i++) {
        const lower = (lines[i] ?? "").toLowerCase();
        let onThisLine = 0;
        for (const t of terms) {
          const n = countOccurrences(lower, t);
          if (n > 0) {
            matched.add(t);
            hits += n;
            onThisLine++;
          }
        }
        if (onThisLine > bestLineTerms) {
          bestLineTerms = onThisLine;
          bestLine = i;
        }
      }
      if (matched.size === 0) continue;
      const rel = relative(cwd, full).split(sep).join("/");
      scored.push({
        file: rel,
        line: bestLine + 1,
        title: firstHeading(lines),
        score: matched.size / terms.length,
        snippet: lines.slice(Math.max(0, bestLine - 1), bestLine + 3).join("\n").trim(),
        collection: c.name,
        hits,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score || b.hits - a.hits || a.file.localeCompare(b.file));
  return scored.slice(0, limit).map(({ hits: _hits, ...h }) => h);
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

function firstHeading(lines: readonly string[]): string | null {
  for (const l of lines) {
    const m = /^#{1,6}\s+(.*\S)\s*$/.exec(l);
    if (m?.[1] !== undefined) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// avo know init
// ---------------------------------------------------------------------------

export interface KnowInitResult {
  ok: boolean;
  backend: KnowledgeBackendKind;
  steps: InitStep[];
  warnings: string[];
  errors: string[];
}

/**
 * `.qmd/` is machine-local: `index.yml` records collection paths as *absolute* paths, so a
 * committed index is wrong on every other machine, and `index.sqlite` is a multi-megabyte binary.
 * A `*` gitignore inside the directory hides all of it, including itself, which also keeps it out
 * of the tree-dirtiness check `avo commit` reasons about.
 */
export function ensureQmdIgnored(cwd: string): "created" | "unchanged" {
  const path = join(cwd, QMD_IGNORE);
  if (existsSync(path)) return "unchanged";
  mkdirSync(join(cwd, QMD_DIR), { recursive: true });
  writeFileSync(path, `# written by avo know init: the qmd index is machine-local\n# (index.yml records absolute paths; index.sqlite is a binary)\n*\n`);
  return "created";
}

/**
 * Scaffolds `K`. Safe to re-run: existing collections are detected from `.qmd/index.yml` and
 * skipped rather than re-added, and qmd's absence is a skipped step, not a failure (invariant 4).
 */
export async function runKnowInit(cwd: string, runner: Runner = spawnRunner): Promise<KnowInitResult> {
  const steps: InitStep[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  for (const c of COLLECTIONS) {
    const existed = existsSync(join(cwd, c.dir));
    try {
      mkdirSync(join(cwd, c.dir), { recursive: true });
      steps.push({ name: `${c.dir}/`, action: existed ? "unchanged" : "created", detail: c.context });
    } catch (e) {
      steps.push({ name: `${c.dir}/`, action: "failed", detail: (e as Error).message });
      errors.push(`could not create ${c.dir}/ — ${(e as Error).message}`);
    }
  }
  if (errors.length > 0) return { ok: false, backend: "files", steps, warnings, errors };

  const status = await probeQmd(runner, cwd);
  if (!status.installed) {
    steps.push({ name: QMD, action: "skipped", detail: `${status.reason ?? "qmd is unavailable"}; 'avo know query' falls back to a local scan` });
    warnings.push(`${status.reason ?? "qmd is unavailable"}; install it with 'npm i -g @tobilu/qmd' for hybrid search over K`);
    return { ok: true, backend: "files", steps, warnings, errors };
  }

  // `qmd init` is idempotent (verified against qmd 2.8.3: a second run keeps the indexed docs), but
  // report it honestly by checking for the config first.
  const hadIndex = existsSync(join(cwd, QMD_CONFIG));
  if (hadIndex) {
    steps.push({ name: `${QMD} init`, action: "unchanged", detail: `${QMD_CONFIG} already exists` });
  } else {
    const r = await qmd(runner, cwd, ["init"], PROBE_TIMEOUT_MS);
    if (r.code !== 0 || r.spawnError !== null) {
      steps.push({ name: `${QMD} init`, action: "failed", detail: why(r) });
      warnings.push(`qmd init failed (${why(r)}); knowledge search falls back to a local scan`);
      return { ok: true, backend: "files", steps, warnings, errors };
    }
    steps.push({ name: `${QMD} init`, action: "created", detail: `project-local index at ${QMD_CONFIG} (not the global ~/.cache/qmd one)` });
  }

  try {
    steps.push({ name: QMD_IGNORE, action: ensureQmdIgnored(cwd), detail: "the index is machine-local; keep it out of git" });
  } catch (e) {
    warnings.push(`could not write ${QMD_IGNORE} — ${(e as Error).message}; the qmd index may show up as untracked`);
  }

  const existing = new Set(readQmdCollections(cwd));
  for (const c of COLLECTIONS) {
    if (existing.has(c.name)) {
      steps.push({ name: `collection ${c.name}`, action: "unchanged", detail: `already indexes ${c.dir}/` });
      continue;
    }
    const r = await qmd(runner, cwd, ["collection", "add", c.dir, "--name", c.name], QUERY_TIMEOUT_MS);
    if (r.code !== 0 || r.spawnError !== null) {
      steps.push({ name: `collection ${c.name}`, action: "failed", detail: why(r) });
      warnings.push(`qmd collection add ${c.dir} failed (${why(r)})`);
      continue;
    }
    steps.push({ name: `collection ${c.name}`, action: "created", detail: `indexes ${c.dir}/**/*${INDEXED_EXT}` });
    // Contexts are qmd's headline feature: a human summary attached to a collection, which the
    // reranker reads. Only worth writing when the collection is new — re-adding overwrites a
    // description the user may have edited.
    const ctx = await qmd(runner, cwd, ["context", "add", `qmd://${c.name}/`, c.context], QUERY_TIMEOUT_MS);
    if (ctx.code !== 0 || ctx.spawnError !== null) warnings.push(`qmd context add for '${c.name}' failed (${why(ctx)})`);
  }

  return { ok: true, backend: "qmd", steps, warnings, errors };
}

// ---------------------------------------------------------------------------
// avo know query
// ---------------------------------------------------------------------------

export interface QueryResult {
  backend: KnowledgeBackendKind;
  query: string;
  hits: Hit[];
  warnings: string[];
  errors: string[];
}

function parseQmdHits(stdout: string, cwd: string): Hit[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim() === "" ? "[]" : stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.map((r) => {
    const o = (typeof r === "object" && r !== null ? r : {}) as Record<string, unknown>;
    const file = typeof o["file"] === "string" ? o["file"] : "";
    return {
      file: normalizeQmdPath(file, cwd),
      line: typeof o["line"] === "number" ? o["line"] : 1,
      title: typeof o["title"] === "string" && o["title"] !== "" ? o["title"] : null,
      score: typeof o["score"] === "number" ? o["score"] : 0,
      snippet: typeof o["snippet"] === "string" ? o["snippet"] : "",
      collection: collectionOf(file),
    };
  });
}

/** `--full-path` yields `./knowledge/x.md` under PWD and an absolute path outside it. */
function normalizeQmdPath(file: string, cwd: string): string {
  if (file.startsWith("./")) return file.slice(2);
  if (file.startsWith("/")) return relative(cwd, file).split(sep).join("/");
  return file;
}

function collectionOf(file: string): string | null {
  const m = /^qmd:\/\/([^/]+)\//.exec(file);
  if (m?.[1] !== undefined) return m[1];
  for (const c of COLLECTIONS) if (file.includes(`${c.dir}/`)) return c.name;
  return null;
}

export interface KnowQueryOptions {
  n: number;
  collection: string | null;
  /** BM25 only (`qmd search`) — no LLM expansion, no rerank. Fast and deterministic. */
  lexical: boolean;
  minScore: number | null;
  timeoutMs: number;
}

export async function knowQuery(
  runner: Runner,
  cwd: string,
  backend: KnowledgeBackend,
  query: string,
  opts: KnowQueryOptions,
): Promise<QueryResult> {
  const warnings = [...backend.warnings];
  if (backend.kind === "qmd") {
    const args = [opts.lexical ? "search" : "query", query, "--format", "json", "--full-path", "-n", String(opts.n)];
    if (opts.collection !== null) args.push("-c", opts.collection);
    const r = await qmd(runner, cwd, args, opts.timeoutMs > 0 ? opts.timeoutMs : QUERY_TIMEOUT_MS);
    if (r.timedOut) {
      return { backend: "qmd", query, hits: [], warnings, errors: [`qmd ${args[0]} timed out; --lexical skips the LLM expansion and rerank`] };
    }
    if (r.spawnError === null && r.code === 0) {
      const hits = parseQmdHits(r.stdout, cwd);
      if (hits !== null) {
        // qmd search reports BM25 hits with score 0 (verified against 2.8.3), so a threshold would
        // silently discard every one of them. Say so rather than returning a confusing empty list.
        if (opts.lexical && opts.minScore !== null && opts.minScore > 0 && hits.every((h) => h.score === 0)) {
          warnings.push(`qmd search does not report a relevance score, so --min-score ${opts.minScore} would drop every hit; it is applied only to 'avo know query' without --lexical`);
          return { backend: "qmd", query, hits, warnings, errors: [] };
        }
        // qmd writes "N documents need embeddings" to stderr; it is exactly the actionable hint an
        // agent should see, because it explains an empty vector result.
        const note = r.stderr.trim().split("\n").find((l) => l.toLowerCase().includes("embedding"));
        if (note !== undefined) warnings.push(`${note.trim()} — run 'avo know add' or 'qmd embed'`);
        return { backend: "qmd", query, hits: filterScore(hits, opts.minScore), warnings, errors: [] };
      }
      warnings.push(`qmd ${args[0]} did not return JSON; fell back to a local scan`);
    } else {
      warnings.push(`qmd ${args[0]} failed (${why(r)}); fell back to a local scan`);
    }
  }
  const hits = localSearch(cwd, query, opts.n);
  return { backend: "files", query, hits: filterScore(hits, opts.minScore), warnings, errors: [] };
}

function filterScore(hits: readonly Hit[], minScore: number | null): Hit[] {
  return minScore === null ? [...hits] : hits.filter((h) => h.score >= minScore);
}

// ---------------------------------------------------------------------------
// avo know add
// ---------------------------------------------------------------------------

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug === "" ? "doc" : slug;
}

/** A URL's slug comes from its path, falling back to the host for a bare domain. */
export function slugForUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "").replace(/\.(html?|md|txt|pdf)$/i, "");
    const tail = path.split("/").filter((s) => s !== "").pop();
    return slugify(tail === undefined ? u.hostname : `${u.hostname}-${tail}`);
  } catch {
    return slugify(url);
  }
}

/** Provenance is the point: a doc in `K` with no source is a doc the agent cannot re-check. */
export function renderDoc(source: string, title: string, fetchedAt: string, via: string, body: string): string {
  const escape = (s: string) => s.replace(/"/g, '\\"');
  const front = [
    "---",
    `source: "${escape(source)}"`,
    `title: "${escape(title)}"`,
    `fetched-at: "${fetchedAt}"`,
    `via: "${escape(via)}"`,
    "---",
    "",
  ].join("\n");
  const capped = body.length > DOC_CAP ? `${body.slice(0, DOC_CAP)}\n\n<!-- truncated by avo know add at ${DOC_CAP} bytes -->\n` : body;
  return `${front}${capped.endsWith("\n") ? capped : `${capped}\n`}`;
}

/** Everything after the frontmatter, so re-adding an unchanged doc is detected as unchanged. */
export function docBody(text: string): string {
  const m = /^---\n[\s\S]*?\n---\n/.exec(text);
  return m === null ? text : text.slice(m[0].length);
}

/**
 * Makes a newly written doc findable. Both calls are needed and in this order: `qmd embed` only
 * generates vectors for documents the index already knows about, so a doc added after
 * `qmd collection add` stays invisible — `qmd ls knowledge` reports "No files found" and every
 * search returns nothing — until `qmd update` re-scans the collection. Verified against qmd 2.8.3.
 */
export async function reindex(runner: Runner, cwd: string, collection: string): Promise<{ embedded: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  const up = await qmd(runner, cwd, ["update", "-c", collection], EMBED_TIMEOUT_MS);
  if (up.code !== 0 || up.spawnError !== null || up.timedOut) {
    warnings.push(`qmd update failed (${up.timedOut ? "timed out" : why(up)}); the new doc is not in the index yet`);
    return { embedded: false, warnings };
  }
  const em = await qmd(runner, cwd, ["embed", "-c", collection], EMBED_TIMEOUT_MS);
  if (em.code !== 0 || em.spawnError !== null || em.timedOut) {
    warnings.push(`qmd embed failed (${em.timedOut ? "timed out" : why(em)}); the doc is indexed lexically but has no vectors`);
    return { embedded: false, warnings };
  }
  return { embedded: true, warnings };
}

export interface AddResult {
  ok: boolean;
  action: "created" | "updated" | "unchanged" | "refused" | "failed";
  path: string | null;
  source: string;
  bytes: number;
  embedded: boolean;
  warnings: string[];
  error: string | null;
}

export interface KnowAddOptions {
  name: string | null;
  force: boolean;
  /** Skip `qmd embed`; useful when adding many docs and embedding once at the end. */
  noEmbed: boolean;
  backend: SearchBackendKind | null;
  timeoutMs: number;
}

export async function knowAdd(
  runner: Runner,
  fetcher: Fetcher,
  env: Record<string, string | undefined>,
  cwd: string,
  backend: KnowledgeBackend,
  target: string,
  opts: KnowAddOptions,
  now: () => Date,
): Promise<AddResult> {
  const warnings: string[] = [];
  const isUrl = /^https?:\/\//i.test(target);
  let body: string;
  let title: string;
  let via: string;

  if (isUrl) {
    const key = env[FIRECRAWL_KEY] ?? "";
    if (key === "" || opts.backend === "searxng" || opts.backend === "ddgs") {
      const reason = key === "" ? `${FIRECRAWL_KEY} is not set` : `--backend ${opts.backend} cannot fetch page content`;
      return {
        ok: false,
        action: "refused",
        path: null,
        source: target,
        bytes: 0,
        embedded: false,
        warnings,
        error: `cannot fetch ${target}: ${reason}. Firecrawl is the only backend that returns page content (free tier: 1000 credits/month, no card). Otherwise save the page yourself and run 'avo know add <path>'.`,
      };
    }
    const scraped = await firecrawlScrape(fetcher, key, target, opts.timeoutMs > 0 ? opts.timeoutMs : SCRAPE_TIMEOUT_MS);
    if ("error" in scraped) {
      return { ok: false, action: "failed", path: null, source: target, bytes: 0, embedded: false, warnings, error: scraped.error };
    }
    body = scraped.markdown;
    title = scraped.title === "" ? target : scraped.title;
    via = "firecrawl";
  } else {
    const abs = join(cwd, target);
    try {
      body = readFileSync(existsSync(abs) ? abs : target, "utf8");
    } catch (e) {
      return {
        ok: false,
        action: "failed",
        path: null,
        source: target,
        bytes: 0,
        embedded: false,
        warnings,
        error: `could not read ${target} — ${(e as Error).message}`,
      };
    }
    title = firstHeading(body.split("\n")) ?? target;
    via = "file";
  }

  const slug = opts.name === null ? (isUrl ? slugForUrl(target) : slugify(target.replace(/\.[^.]+$/, ""))) : slugify(opts.name);
  const rel = `${KNOWLEDGE_DIR}/${slug}${INDEXED_EXT}`;
  const path = join(cwd, rel);
  const doc = renderDoc(target, title, now().toISOString(), via, body);

  const existedBefore = existsSync(path);
  if (existedBefore) {
    const existing = readFileSync(path, "utf8");
    // Compare bodies, not whole files: `fetched-at` differs on every fetch, so comparing the
    // rendered doc would report every re-fetch of an unchanged page as a conflict (invariant 5).
    if (docBody(existing).trim() === docBody(doc).trim()) {
      return { ok: true, action: "unchanged", path: rel, source: target, bytes: body.length, embedded: false, warnings, error: null };
    }
    if (!opts.force) {
      return {
        ok: false,
        action: "refused",
        path: rel,
        source: target,
        bytes: body.length,
        embedded: false,
        warnings,
        error: `${rel} already exists with different content; pass --force to replace it, or --name <slug> to keep both`,
      };
    }
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, doc);
  } catch (e) {
    return { ok: false, action: "failed", path: rel, source: target, bytes: 0, embedded: false, warnings, error: `could not write ${rel} — ${(e as Error).message}` };
  }
  const action = existedBefore ? "updated" : "created";

  let embedded = false;
  if (!opts.noEmbed) {
    if (backend.kind !== "qmd") {
      warnings.push(`${backend.status.reason ?? "qmd is unavailable"}; ${rel} is on disk but not embedded — the local scan still finds it`);
    } else {
      const r = await reindex(runner, cwd, "knowledge");
      embedded = r.embedded;
      warnings.push(...r.warnings);
    }
  }
  return { ok: true, action, path: rel, source: target, bytes: body.length, embedded, warnings, error: null };
}

// ---------------------------------------------------------------------------
// the CLI
// ---------------------------------------------------------------------------

export type KnowSub = "init" | "query" | "add" | "search" | "reindex";

export interface KnowOptions {
  sub: KnowSub;
  json: boolean;
  cwd: string;
  args: string[];
  n: number;
  collection: string | null;
  lexical: boolean;
  minScore: number | null;
  name: string | null;
  force: boolean;
  noEmbed: boolean;
  ingest: boolean;
  backend: SearchBackendKind | null;
  timeoutMs: number;
}

/**
 * Built fresh per call, never spread from a shared constant: `args` is a mutable array, and a
 * module-level default would be the *same* array in every invocation, so two `avo know` calls in
 * one process (the Pi extension runs many) would accumulate each other's arguments.
 */
function defaultKnowOptions(): KnowOptions {
  return {
    sub: "query",
    json: false,
    cwd: process.cwd(),
    args: [],
    n: 5,
    collection: null,
    lexical: false,
    minScore: null,
    name: null,
    force: false,
    noEmbed: false,
    ingest: false,
    backend: null,
    timeoutMs: 0,
  };
}

export function parseKnowArgs(argv: readonly string[]): KnowOptions | { error: string } {
  const opts: KnowOptions = defaultKnowOptions();
  let sawSub = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const needsValue = ["--cwd", "-n", "--collection", "-c", "--min-score", "--name", "--backend", "--timeout"];
    if (a === "--json") opts.json = true;
    else if (a === "--lexical") opts.lexical = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--no-embed") opts.noEmbed = true;
    else if (a === "--ingest") opts.ingest = true;
    else if (needsValue.includes(a)) {
      const v = argv[i + 1];
      if (v === undefined) return { error: `avo know: ${a} needs a value` };
      i++;
      if (a === "--cwd") opts.cwd = v;
      else if (a === "--name") opts.name = v;
      else if (a === "--collection" || a === "-c") opts.collection = v;
      else if (a === "-n" || a === "--min-score" || a === "--timeout") {
        const num = Number(v);
        if (!Number.isFinite(num) || num < 0) return { error: `avo know: ${a} needs a non-negative number (got '${v}')` };
        if (a === "-n") opts.n = Math.floor(num);
        else if (a === "--timeout") opts.timeoutMs = Math.floor(num * 1000);
        else opts.minScore = num;
      } else {
        if (!SEARCH_BACKENDS.includes(v as SearchBackendKind)) {
          return { error: `avo know: unknown --backend '${v}'; one of ${SEARCH_BACKENDS.join(", ")}` };
        }
        opts.backend = v as SearchBackendKind;
      }
    } else if (a.startsWith("-") && a !== "-") return { error: `avo know: unknown option '${a}'` };
    else if (!sawSub && (a === "init" || a === "query" || a === "add" || a === "search" || a === "reindex")) {
      opts.sub = a;
      sawSub = true;
    } else opts.args.push(a);
  }
  if (!sawSub) return { error: `avo know: needs a subcommand — init | query "<q>" | add <url|path> | search "<q>" | reindex` };
  for (const sub of ["init", "reindex"] as const) {
    if (opts.sub === sub && opts.args.length > 0) return { error: `avo know ${sub}: unexpected argument '${opts.args[0]}'` };
  }
  if (opts.sub !== "init" && opts.sub !== "reindex" && opts.args.join(" ").trim() === "") {
    const what = opts.sub === "add" ? "a url or a path" : "a query";
    return { error: `avo know ${opts.sub}: needs ${what}, e.g. avo know ${opts.sub} ${opts.sub === "add" ? "https://example.com/doc" : '"register pressure"'}` };
  }
  if (opts.sub === "add" && opts.args.length > 1) return { error: `avo know add: one url or path at a time (got ${opts.args.length})` };
  if (opts.n === 0) return { error: `avo know: -n must be at least 1` };
  return opts;
}

export function renderKnowInit(r: KnowInitResult): string {
  const lines = ["avo know init", ""];
  for (const s of r.steps) lines.push(`  ${s.action.padEnd(10)} ${s.name.padEnd(20)} ${s.detail}`);
  lines.push("");
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  for (const e of r.errors) lines.push(`error: ${e}`);
  if (r.warnings.length > 0 || r.errors.length > 0) lines.push("");
  lines.push(r.ok ? `K is ready via ${r.backend} — 'avo know query "<q>"' searches it` : "avo know init incomplete");
  return `${lines.join("\n")}\n`;
}

export function renderQuery(r: QueryResult): string {
  const lines = [`avo know query — ${r.hits.length} hit(s) via ${r.backend}`, ""];
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  for (const e of r.errors) lines.push(`error: ${e}`);
  if (r.warnings.length > 0 || r.errors.length > 0) lines.push("");
  if (r.hits.length === 0) {
    lines.push(`nothing in K matched "${r.query}" — 'avo know add <url|path>' grows it`, "");
    return `${lines.join("\n")}\n`;
  }
  for (const h of r.hits) {
    lines.push(`  ${h.score.toFixed(2)}  ${h.file}:${h.line}${h.title === null ? "" : `  ${h.title}`}`);
    for (const l of h.snippet.split("\n").slice(0, 4)) lines.push(`        ${l}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function renderSearch(query: string, backend: SearchBackendKind, results: readonly SearchResult[], warnings: readonly string[]): string {
  const lines = [`avo know search "${query}" — ${results.length} result(s) via ${backend}`, ""];
  for (const w of warnings) lines.push(`warning: ${w}`);
  if (warnings.length > 0) lines.push("");
  for (const r of results) {
    lines.push(`  ${r.title === "" ? r.url : r.title}`);
    lines.push(`    ${r.url}`);
    if (r.snippet !== "") lines.push(`    ${r.snippet.slice(0, 200)}`);
    lines.push("");
  }
  if (results.length === 0) lines.push("no results", "");
  return `${lines.join("\n")}\n`;
}

/** Exit codes: 0 = ran, 1 = the operation was refused, 2 = usage or harness error. */
export async function knowCommand(
  argv: readonly string[],
  io: Io,
  runner: Runner = spawnRunner,
  fetcher: Fetcher = globalFetcher,
  env: Record<string, string | undefined> = process.env,
  now: () => Date = () => new Date(),
): Promise<number> {
  const parsed = parseKnowArgs(argv);
  if ("error" in parsed) {
    io.err(`${parsed.error}\n`);
    return 2;
  }
  const opts = parsed;

  if (opts.sub === "init") {
    const r = await runKnowInit(opts.cwd, runner);
    if (opts.json) io.out(`${JSON.stringify(r)}\n`);
    else {
      io.out(renderKnowInit(r));
      for (const e of r.errors) io.err(`avo know init: ${e}\n`);
    }
    return r.ok ? 0 : 2;
  }

  if (opts.sub === "reindex") {
    const backend = await resolveKnowledge(runner, opts.cwd);
    const names = opts.collection === null ? COLLECTIONS.map((c) => c.name) : [opts.collection];
    const warnings = [...backend.warnings];
    const done: string[] = [];
    if (backend.kind === "qmd") {
      for (const name of names) {
        const r = await reindex(runner, opts.cwd, name);
        warnings.push(...r.warnings);
        if (r.warnings.length === 0) done.push(name);
      }
    }
    const result = { ok: backend.kind === "qmd", backend: backend.kind, reindexed: done, warnings };
    if (opts.json) io.out(`${JSON.stringify(result)}\n`);
    else {
      for (const w of warnings) io.err(`warning: ${w}\n`);
      io.out(
        backend.kind === "qmd"
          ? `reindexed ${done.length === 0 ? "nothing" : done.join(", ")}\n`
          : `nothing to reindex — the local scan reads ${COLLECTIONS.map((c) => `${c.dir}/`).join(" and ")} directly\n`,
      );
    }
    // Not an error without qmd: the fallback reads the files live, so it is never stale.
    return 0;
  }

  const query = opts.args.join(" ").trim();

  if (opts.sub === "query") {
    const backend = await resolveKnowledge(runner, opts.cwd);
    const r = await knowQuery(runner, opts.cwd, backend, query, {
      n: opts.n,
      collection: opts.collection,
      lexical: opts.lexical,
      minScore: opts.minScore,
      timeoutMs: opts.timeoutMs,
    });
    if (opts.json) io.out(`${JSON.stringify(r)}\n`);
    else {
      for (const w of r.warnings) io.err(`warning: ${w}\n`);
      io.out(renderQuery({ ...r, warnings: [] }));
    }
    return r.errors.length > 0 ? 2 : 0;
  }

  if (opts.sub === "add") {
    const backend = await resolveKnowledge(runner, opts.cwd);
    const r = await knowAdd(runner, fetcher, env, opts.cwd, backend, query, opts, now);
    const warnings = [...r.warnings];
    if (opts.json) io.out(`${JSON.stringify({ ...r, warnings })}\n`);
    else {
      for (const w of warnings) io.err(`warning: ${w}\n`);
      if (r.ok) io.out(`${r.action} ${r.path} (${r.bytes} bytes from ${r.source})${r.embedded ? ", embedded" : ""}\n`);
      else io.err(`avo know add: ${r.error ?? "failed"}\n`);
    }
    if (r.ok) return 0;
    return r.action === "refused" ? 1 : 2;
  }

  const found = await webSearch(query, { backend: opts.backend, limit: opts.n, timeoutMs: opts.timeoutMs, scrape: opts.ingest }, env, fetcher, runner);
  if ("error" in found) {
    if (opts.json) io.out(`${JSON.stringify({ backend: opts.backend, query, results: [], warnings: [], error: found.error })}\n`);
    else io.err(`avo know search: ${found.error}\n`);
    return 2;
  }
  const warnings = [...found.warnings];
  const ingested: AddResult[] = [];
  if (opts.ingest) {
    const backend = await resolveKnowledge(runner, opts.cwd);
    for (const result of found.results) {
      if (result.markdown === null) continue;
      const r = await ingestResult(runner, opts.cwd, backend, result, opts, now);
      warnings.push(...r.warnings);
      if (!r.ok && r.error !== null) warnings.push(r.error);
      ingested.push(r);
    }
    if (ingested.length === 0 && found.results.length > 0) {
      warnings.push(`--ingest wrote nothing: ${found.backend} returned no page content`);
    }
  }
  if (opts.json) io.out(`${JSON.stringify({ ...found, warnings, ingested })}\n`);
  else {
    for (const w of warnings) io.err(`warning: ${w}\n`);
    io.out(renderSearch(query, found.backend, found.results, []));
    for (const r of ingested) io.out(`  ${r.action} ${r.path ?? ""}\n`);
  }
  return 0;
}

/** Writes one already-fetched search result into `K`, without re-fetching it. */
async function ingestResult(
  runner: Runner,
  cwd: string,
  backend: KnowledgeBackend,
  result: SearchResult,
  opts: KnowOptions,
  now: () => Date,
): Promise<AddResult> {
  const rel = `${KNOWLEDGE_DIR}/${slugForUrl(result.url)}${INDEXED_EXT}`;
  const path = join(cwd, rel);
  const doc = renderDoc(result.url, result.title === "" ? result.url : result.title, now().toISOString(), "firecrawl", result.markdown ?? "");
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    if (docBody(existing).trim() === docBody(doc).trim()) {
      return { ok: true, action: "unchanged", path: rel, source: result.url, bytes: (result.markdown ?? "").length, embedded: false, warnings: [], error: null };
    }
    if (!opts.force) {
      return { ok: false, action: "refused", path: rel, source: result.url, bytes: 0, embedded: false, warnings: [], error: `${rel} already exists with different content; --force to replace` };
    }
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, doc);
  } catch (e) {
    return { ok: false, action: "failed", path: rel, source: result.url, bytes: 0, embedded: false, warnings: [], error: `could not write ${rel} — ${(e as Error).message}` };
  }
  const warnings: string[] = [];
  let embedded = false;
  if (!opts.noEmbed && backend.kind === "qmd") {
    const r = await reindex(runner, cwd, "knowledge");
    embedded = r.embedded;
    warnings.push(...r.warnings);
  }
  return { ok: true, action: "created", path: rel, source: result.url, bytes: (result.markdown ?? "").length, embedded, warnings, error: null };
}
