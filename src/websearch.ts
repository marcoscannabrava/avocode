import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnRunner, type Runner } from "./score.ts";

/**
 * Online search — how `K` grows from the web. Three backends, one shape.
 *
 * Firecrawl is the default because it alone returns *page content*, which `--ingest` needs. PLAN §6
 * Q2: its free tier is 1,000 credits/month with no card and search costs 2 credits per 10 results,
 * so the default is usable unpaid. The other two are keyless, links and snippets only.
 */
export type SearchBackendKind = "firecrawl" | "searxng" | "ddgs";

export const SEARCH_BACKENDS: readonly SearchBackendKind[] = ["firecrawl", "searxng", "ddgs"];

export const FIRECRAWL_KEY = "FIRECRAWL_API_KEY";
export const SEARXNG_URL_VAR = "SEARXNG_URL";
export const FIRECRAWL_API = "https://api.firecrawl.dev/v2";
export const DDGS = "ddgs";

const DEFAULT_TIMEOUT_MS = 60_000;

/** One web result. `markdown` is non-null only when the backend actually fetched the page. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  markdown: string | null;
}

export interface WebSearch {
  backend: SearchBackendKind;
  query: string;
  results: SearchResult[];
  warnings: string[];
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  body: string;
  /** Transport-level failure (DNS, refused, timeout); the caller reports it instead of throwing. */
  error: string | null;
}

export interface HttpRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

/** The one network seam. Injected so every backend is testable with no network (invariant 3). */
export type Fetcher = (url: string, req: HttpRequest) => Promise<HttpResponse>;

export const globalFetcher: Fetcher = async (url, req) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  try {
    const init: RequestInit = { method: req.method, headers: req.headers, signal: controller.signal };
    if (req.body !== undefined) init.body = req.body;
    const res = await fetch(url, init);
    return { status: res.status, ok: res.ok, body: await res.text(), error: null };
  } catch (e) {
    const message = (e as Error).name === "AbortError" ? `timed out after ${req.timeoutMs}ms` : (e as Error).message;
    return { status: 0, ok: false, body: "", error: message };
  } finally {
    clearTimeout(timer);
  }
};

export interface BackendChoice {
  kind: SearchBackendKind;
  /** How it was chosen — surfaced so `--json` consumers can tell auto from explicit. */
  explicit: boolean;
}

/**
 * No key configured names the alternatives rather than throwing (S4 acceptance). `ddgs` is last: a
 * binary, so its availability is unknowable from the environment and it fails at call time.
 */
export function noBackendMessage(): string {
  return [
    `no web search backend configured. pick one:`,
    `  firecrawl  export ${FIRECRAWL_KEY}=<key>   (free tier: 1000 credits/month, no card — https://firecrawl.dev/pricing)`,
    `  searxng    export ${SEARXNG_URL_VAR}=https://<instance>   (any instance with format=json enabled)`,
    `  ddgs       pip install ddgs                (keyless; links and snippets only)`,
  ].join("\n");
}

export function resolveSearchBackend(
  explicit: SearchBackendKind | null,
  env: Record<string, string | undefined>,
): BackendChoice | { error: string } {
  const hasKey = (env[FIRECRAWL_KEY] ?? "") !== "";
  const hasSearx = (env[SEARXNG_URL_VAR] ?? "") !== "";
  if (explicit === "firecrawl") {
    if (!hasKey) return { error: `avo know search --backend firecrawl needs ${FIRECRAWL_KEY}.\n${noBackendMessage()}` };
    return { kind: "firecrawl", explicit: true };
  }
  if (explicit === "searxng") {
    if (!hasSearx) return { error: `avo know search --backend searxng needs ${SEARXNG_URL_VAR}.\n${noBackendMessage()}` };
    return { kind: "searxng", explicit: true };
  }
  if (explicit === "ddgs") return { kind: "ddgs", explicit: true };
  if (hasKey) return { kind: "firecrawl", explicit: false };
  if (hasSearx) return { kind: "searxng", explicit: false };
  return { kind: "ddgs", explicit: false };
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function str(o: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v !== "") return v;
  }
  return "";
}

/**
 * Firecrawl `POST /v2/search`. `scrapeOptions.formats:["markdown"]` is what makes `--ingest`
 * possible: the response carries the page body, so ingesting costs no extra scrape.
 */
export async function firecrawlSearch(
  fetcher: Fetcher,
  apiKey: string,
  query: string,
  limit: number,
  timeoutMs: number,
  scrape: boolean,
): Promise<WebSearch | { error: string }> {
  const payload: Record<string, unknown> = { query, limit };
  if (scrape) payload["scrapeOptions"] = { formats: ["markdown"], onlyMainContent: true };
  const res = await fetcher(`${FIRECRAWL_API}/search`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
    timeoutMs,
  });
  if (res.error !== null) return { error: `firecrawl search failed — ${res.error}` };
  if (!res.ok) return { error: `firecrawl search returned HTTP ${res.status}${firstLine(res.body)}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    return { error: `firecrawl search returned a body that is not JSON${firstLine(res.body)}` };
  }
  const root = asRecord(parsed);
  if (root["success"] === false) return { error: `firecrawl search reported failure${firstLine(String(root["error"] ?? ""))}` };
  // v2 nests by source ({data: {web, news}}); older shapes put an array at data. Accept both, so a
  // shape change degrades to zero results.
  const data = root["data"];
  const rows: unknown[] = Array.isArray(data)
    ? data
    : Object.values(asRecord(data)).flatMap((v) => (Array.isArray(v) ? v : []));
  const results: SearchResult[] = rows.map((r) => {
    const o = asRecord(r);
    const markdown = str(o, "markdown");
    return {
      title: str(o, "title", "name"),
      url: str(o, "url", "link"),
      snippet: str(o, "description", "snippet"),
      markdown: markdown === "" ? null : markdown,
    };
  });
  return { backend: "firecrawl", query, results: results.filter((r) => r.url !== ""), warnings: [] };
}

/** Firecrawl `POST /v2/scrape` — one URL to markdown. What `avo know add <url>` runs. */
export async function firecrawlScrape(
  fetcher: Fetcher,
  apiKey: string,
  url: string,
  timeoutMs: number,
): Promise<{ markdown: string; title: string } | { error: string }> {
  const res = await fetcher(`${FIRECRAWL_API}/scrape`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
    timeoutMs,
  });
  if (res.error !== null) return { error: `firecrawl scrape failed — ${res.error}` };
  if (!res.ok) return { error: `firecrawl scrape returned HTTP ${res.status}${firstLine(res.body)}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    return { error: `firecrawl scrape returned a body that is not JSON${firstLine(res.body)}` };
  }
  const data = asRecord(asRecord(parsed)["data"]);
  const markdown = str(data, "markdown");
  if (markdown === "") return { error: `firecrawl scrape returned no markdown for ${url}` };
  return { markdown, title: str(asRecord(data["metadata"]), "title", "ogTitle") };
}

/** SearXNG `GET /search?format=json`. Instances must opt into the json format; say so if it 403s. */
export async function searxngSearch(
  fetcher: Fetcher,
  base: string,
  query: string,
  limit: number,
  timeoutMs: number,
): Promise<WebSearch | { error: string }> {
  const url = `${base.replace(/\/+$/, "")}/search?q=${encodeURIComponent(query)}&format=json`;
  const res = await fetcher(url, { method: "GET", headers: { accept: "application/json" }, timeoutMs });
  if (res.error !== null) return { error: `searxng search failed — ${res.error}` };
  if (res.status === 403) {
    return { error: `searxng at ${base} refused format=json (HTTP 403) — the instance must list 'json' in search.formats` };
  }
  if (!res.ok) return { error: `searxng search returned HTTP ${res.status}${firstLine(res.body)}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    return { error: `searxng returned a body that is not JSON — is format=json enabled on ${base}?` };
  }
  const rows = asRecord(parsed)["results"];
  const results: SearchResult[] = (Array.isArray(rows) ? rows : []).slice(0, limit).map((r) => {
    const o = asRecord(r);
    return { title: str(o, "title"), url: str(o, "url"), snippet: str(o, "content"), markdown: null };
  });
  return {
    backend: "searxng",
    query,
    results: results.filter((r) => r.url !== ""),
    warnings: [],
  };
}

/**
 * `ddgs text -q <q> -m <n> -o json`.
 *
 * Verified against ddgs 9.15.0: `-o json` does **not** print to stdout — it writes
 * `text_<query>_<timestamp>.json` into the *current directory*. In the repo that prints nothing and
 * litters the tree with files `avo commit` reads as a variation, so it runs in a temp dir.
 */
export async function ddgsSearch(
  runner: Runner,
  query: string,
  limit: number,
  timeoutMs: number,
): Promise<WebSearch | { error: string }> {
  let dir: string;
  try {
    dir = mkdtempSync(join(tmpdir(), "avo-ddgs-"));
  } catch (e) {
    return { error: `could not create a temp dir for ddgs — ${(e as Error).message}` };
  }
  try {
    const r = await runner(DDGS, ["text", "-q", query, "-m", String(limit), "-o", "json"], { cwd: dir, timeoutMs });
    if (r.spawnError !== null) {
      return { error: `ddgs is not installed (${r.spawnError}). ${noBackendMessage()}` };
    }
    if (r.timedOut) return { error: `ddgs timed out after ${timeoutMs}ms` };
    if (r.code !== 0) return { error: `ddgs exited ${r.code}${firstLine(`${r.stderr}${r.stdout}`)}` };
    const file = readdirSync(dir).find((f) => f.endsWith(".json"));
    if (file === undefined) {
      return { error: `ddgs wrote no json file (it reported: ${firstLine(`${r.stdout}${r.stderr}`).trim() || "nothing"})` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch (e) {
      return { error: `ddgs wrote a json file we could not parse — ${(e as Error).message}` };
    }
    const results: SearchResult[] = (Array.isArray(parsed) ? parsed : []).map((r2) => {
      const o = asRecord(r2);
      return { title: str(o, "title"), url: str(o, "href", "url"), snippet: str(o, "body"), markdown: null };
    });
    return { backend: "ddgs", query, results: results.filter((r2) => r2.url !== ""), warnings: [] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function firstLine(body: string): string {
  const line = body.trim().split("\n")[0]?.slice(0, 200) ?? "";
  return line === "" ? "" : ` — ${line}`;
}

export interface WebSearchOptions {
  backend: SearchBackendKind | null;
  limit: number;
  timeoutMs: number;
  /** Ask the backend for page content too. Only firecrawl can honour it. */
  scrape: boolean;
}

/** Dispatches to the resolved backend. Never throws: every failure is `{ error }` (invariant 4). */
export async function webSearch(
  query: string,
  opts: WebSearchOptions,
  env: Record<string, string | undefined>,
  fetcher: Fetcher = globalFetcher,
  runner: Runner = spawnRunner,
): Promise<WebSearch | { error: string }> {
  const choice = resolveSearchBackend(opts.backend, env);
  if ("error" in choice) return choice;
  const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  if (choice.kind === "firecrawl") {
    return await firecrawlSearch(fetcher, env[FIRECRAWL_KEY] ?? "", query, opts.limit, timeoutMs, opts.scrape);
  }
  if (choice.kind === "searxng") {
    const out = await searxngSearch(fetcher, env[SEARXNG_URL_VAR] ?? "", query, opts.limit, timeoutMs);
    return "error" in out ? out : withScrapeWarning(out, opts.scrape);
  }
  const out = await ddgsSearch(runner, query, opts.limit, timeoutMs);
  return "error" in out ? out : withScrapeWarning(out, opts.scrape);
}

function withScrapeWarning(out: WebSearch, scrape: boolean): WebSearch {
  if (!scrape) return out;
  return {
    ...out,
    warnings: [
      ...out.warnings,
      `${out.backend} returns links and snippets only, never page content; set ${FIRECRAWL_KEY} to ingest pages, or 'avo know add <url>' the ones you want`,
    ],
  };
}
