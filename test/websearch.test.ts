import assert from "node:assert/strict";
import { readdirSync, writeFileSync } from "node:fs";
import test from "node:test";
import type { RunOpts, Runner, RunResult } from "../src/score.ts";
import {
  ddgsSearch,
  FIRECRAWL_KEY,
  firecrawlScrape,
  firecrawlSearch,
  noBackendMessage,
  resolveSearchBackend,
  searxngSearch,
  SEARXNG_URL_VAR,
  webSearch,
  type Fetcher,
  type HttpRequest,
} from "../src/websearch.ts";

interface HttpCall {
  url: string;
  req: HttpRequest;
}

/** A fetcher that answers a canned response and records the request, so no test touches a network. */
function http(answer: Partial<{ status: number; ok: boolean; body: string; error: string | null }>): Fetcher & { calls: HttpCall[] } {
  const calls: HttpCall[] = [];
  const fetcher = (url: string, req: HttpRequest) => {
    calls.push({ url, req });
    return Promise.resolve({ status: 200, ok: true, body: "{}", error: null, ...answer });
  };
  return Object.assign(fetcher, { calls });
}

function stubRunner(answer: Partial<RunResult>, onCall?: (opts: RunOpts) => void): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner = (cmd: string, args: readonly string[], opts: RunOpts): Promise<RunResult> => {
    calls.push([cmd, ...args]);
    onCall?.(opts);
    return Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: false, spawnError: null, ...answer });
  };
  return Object.assign(runner, { calls });
}

const bad = <T,>(r: T | { error: string }): { error: string } => {
  assert.ok(typeof r === "object" && r !== null && "error" in r, `expected an error, got ${JSON.stringify(r)}`);
  return r as { error: string };
};
const good = <T,>(r: T | { error: string }): T => {
  assert.ok(!(typeof r === "object" && r !== null && "error" in r), `expected success, got ${JSON.stringify(r)}`);
  return r as T;
};

// --------------------------------------------------------------- backend choice

test("auto-selection prefers firecrawl, then searxng, then the keyless ddgs", () => {
  const pick = (env: Record<string, string | undefined>) => good(resolveSearchBackend(null, env));
  assert.deepEqual(pick({ [FIRECRAWL_KEY]: "fc-x", [SEARXNG_URL_VAR]: "https://s" }), { kind: "firecrawl", explicit: false });
  assert.deepEqual(pick({ [SEARXNG_URL_VAR]: "https://s" }), { kind: "searxng", explicit: false });
  assert.deepEqual(pick({}), { kind: "ddgs", explicit: false });
  // An empty string is not a key: exporting FIRECRAWL_API_KEY= must not select a backend that 401s.
  assert.deepEqual(pick({ [FIRECRAWL_KEY]: "" }), { kind: "ddgs", explicit: false });
});

test("an explicitly requested backend with no credentials names all three alternatives", () => {
  const fc = bad(resolveSearchBackend("firecrawl", {}));
  assert.match(fc.error, /FIRECRAWL_API_KEY/);
  assert.match(fc.error, /searxng/);
  assert.match(fc.error, /ddgs/);
  assert.match(bad(resolveSearchBackend("searxng", {})).error, /SEARXNG_URL/);
  // ddgs needs nothing from the environment, so selecting it always succeeds.
  assert.deepEqual(good(resolveSearchBackend("ddgs", {})), { kind: "ddgs", explicit: true });
});

test("the no-backend message names each backend's free path", () => {
  const m = noBackendMessage();
  assert.match(m, /1000 credits\/month/);
  assert.match(m, /pip install ddgs/);
  assert.match(m, /format=json/);
});

// ------------------------------------------------------------------- firecrawl

test("firecrawl search posts the documented v2 payload and only scrapes when asked", async () => {
  const f = http({ body: JSON.stringify({ success: true, data: { web: [] } }) });
  await firecrawlSearch(f, "fc-key", "register pressure", 7, 1000, false);
  const first = f.calls[0];
  assert.equal(first?.url, "https://api.firecrawl.dev/v2/search");
  assert.equal(first?.req.headers["authorization"], "Bearer fc-key");
  const sent = JSON.parse(first?.req.body ?? "{}") as Record<string, unknown>;
  assert.equal(sent["query"], "register pressure");
  assert.equal(sent["limit"], 7);
  assert.equal(sent["scrapeOptions"], undefined);

  await firecrawlSearch(f, "fc-key", "q", 3, 1000, true);
  const withScrape = JSON.parse(f.calls[1]?.req.body ?? "{}") as Record<string, unknown>;
  assert.deepEqual(withScrape["scrapeOptions"], { formats: ["markdown"], onlyMainContent: true });
});

test("firecrawl results are read from either the nested-by-source or the flat data shape", async () => {
  const row = { title: "AVO", url: "https://arxiv.org/abs/1", description: "a paper", markdown: "# AVO\nbody" };
  const nested = good(await firecrawlSearch(http({ body: JSON.stringify({ data: { web: [row] } }) }), "k", "q", 5, 1000, true));
  assert.equal(nested.results.length, 1);
  assert.equal(nested.results[0]?.markdown, "# AVO\nbody");
  const flat = good(await firecrawlSearch(http({ body: JSON.stringify({ data: [row] }) }), "k", "q", 5, 1000, true));
  assert.deepEqual(flat.results, nested.results);
});

test("a result with no url is dropped, and a missing markdown becomes null rather than an empty string", async () => {
  const body = JSON.stringify({ data: { web: [{ title: "no url" }, { title: "ok", url: "https://x", description: "d" }] } });
  const r = good(await firecrawlSearch(http({ body }), "k", "q", 5, 1000, false));
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0]?.markdown, null);
});

test("firecrawl transport, HTTP and body failures each become a named error, never a throw", async () => {
  assert.match(bad(await firecrawlSearch(http({ error: "ECONNREFUSED" }), "k", "q", 5, 1000, false)).error, /ECONNREFUSED/);
  assert.match(bad(await firecrawlSearch(http({ ok: false, status: 402, body: "insufficient credits" }), "k", "q", 5, 1000, false)).error, /402.*insufficient credits/);
  assert.match(bad(await firecrawlSearch(http({ body: "<html>" }), "k", "q", 5, 1000, false)).error, /not JSON/);
  assert.match(bad(await firecrawlSearch(http({ body: JSON.stringify({ success: false, error: "bad key" }) }), "k", "q", 5, 1000, false)).error, /bad key/);
});

test("firecrawl scrape returns the markdown and its title, and reports an empty page", async () => {
  const ok = good(await firecrawlScrape(http({ body: JSON.stringify({ data: { markdown: "# t\nb", metadata: { title: "t" } } }) }), "k", "https://x", 1000));
  assert.deepEqual(ok, { markdown: "# t\nb", title: "t" });
  assert.match(bad(await firecrawlScrape(http({ body: JSON.stringify({ data: {} }) }), "k", "https://x", 1000)).error, /no markdown/);
});

// ---------------------------------------------------------------------- searxng

test("searxng builds a format=json url, strips a trailing slash and maps content to snippet", async () => {
  const f = http({ body: JSON.stringify({ results: [{ title: "t", url: "https://u", content: "c" }, { title: "n", url: "https://v", content: "" }] }) });
  const r = good(await searxngSearch(f, "https://searx.example/", "cap theorem", 1, 1000));
  assert.equal(f.calls[0]?.url, "https://searx.example/search?q=cap%20theorem&format=json");
  assert.equal(r.results.length, 1, "limit applies before filtering");
  assert.deepEqual(r.results[0], { title: "t", url: "https://u", snippet: "c", markdown: null });
});

test("a searxng instance with json disabled says exactly that", async () => {
  assert.match(bad(await searxngSearch(http({ ok: false, status: 403, body: "" }), "https://s", "q", 5, 1000)).error, /search\.formats/);
  assert.match(bad(await searxngSearch(http({ body: "<html>" }), "https://s", "q", 5, 1000)).error, /format=json enabled/);
});

// ------------------------------------------------------------------------- ddgs

test("ddgs is invoked with the verified argv and never in the repo directory", async () => {
  // ddgs 9.15.0 writes text_<query>_<ts>.json into CWD, so running it in the repo would litter the
  // working tree with files `avo commit` would then read as a variation.
  let seenCwd = "";
  const runner = stubRunner({}, (opts) => {
    seenCwd = opts.cwd;
    writeFileSync(`${opts.cwd}/text_q_1.json`, JSON.stringify([{ title: "T", href: "https://h", body: "B" }]));
  });
  const r = good(await ddgsSearch(runner, "avo paper", 4, 1000));
  assert.deepEqual(runner.calls[0], ["ddgs", "text", "-q", "avo paper", "-m", "4", "-o", "json"]);
  assert.notEqual(seenCwd, process.cwd());
  assert.deepEqual(r.results, [{ title: "T", url: "https://h", snippet: "B", markdown: null }]);
  assert.throws(() => readdirSync(seenCwd), "the temp dir is removed afterwards");
});

test("ddgs writing no json file is reported instead of silently returning nothing", async () => {
  const r = bad(await ddgsSearch(stubRunner({ stdout: "no results found" }), "q", 3, 1000));
  assert.match(r.error, /wrote no json file/);
  assert.match(r.error, /no results found/);
});

test("a missing ddgs binary names the other two backends", async () => {
  const r = bad(await ddgsSearch(stubRunner({ code: -1, spawnError: "spawn ddgs ENOENT" }), "q", 3, 1000));
  assert.match(r.error, /not installed/);
  assert.match(r.error, /FIRECRAWL_API_KEY/);
  assert.match(r.error, /SEARXNG_URL/);
});

test("the ddgs temp dir is removed even when the run fails", async () => {
  let seenCwd = "";
  await ddgsSearch(stubRunner({ code: 2, stderr: "boom" }, (o) => (seenCwd = o.cwd)), "q", 3, 1000);
  assert.throws(() => readdirSync(seenCwd));
});

// --------------------------------------------------------------------- dispatch

test("webSearch dispatches to the resolved backend and warns when --ingest cannot work", async () => {
  const fc = http({ body: JSON.stringify({ data: { web: [{ url: "https://x", markdown: "m" }] } }) });
  const viaKey = good(await webSearch("q", { backend: null, limit: 5, timeoutMs: 1000, scrape: true }, { [FIRECRAWL_KEY]: "k" }, fc));
  assert.equal(viaKey.backend, "firecrawl");
  assert.deepEqual(viaKey.warnings, [], "firecrawl can honour --ingest, so it warns about nothing");

  const runner = stubRunner({}, (o) => writeFileSync(`${o.cwd}/r.json`, "[]"));
  const viaDdgs = good(await webSearch("q", { backend: null, limit: 5, timeoutMs: 1000, scrape: true }, {}, fc, runner));
  assert.equal(viaDdgs.backend, "ddgs");
  assert.match(viaDdgs.warnings[0] ?? "", /links and snippets only/);
});

test("webSearch surfaces the selection error rather than falling through to another backend", async () => {
  const f = http({});
  const r = bad(await webSearch("q", { backend: "firecrawl", limit: 5, timeoutMs: 1000, scrape: false }, {}, f));
  assert.match(r.error, /FIRECRAWL_API_KEY/);
  assert.equal(f.calls.length, 0, "no request is made when the backend cannot be used");
});
