import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { bufferIo } from "../src/io.ts";
import {
  COLLECTIONS,
  docBody,
  ensureQmdIgnored,
  knowAdd,
  knowCommand,
  knowQuery,
  localSearch,
  parseKnowArgs,
  probeQmd,
  QMD_CONFIG,
  QMD_IGNORE,
  queryTerms,
  readQmdCollections,
  renderDoc,
  resolveKnowledge,
  runKnowInit,
  slugForUrl,
  slugify,
} from "../src/knowledge.ts";
import type { RunOpts, Runner, RunResult } from "../src/score.ts";
import { FIRECRAWL_KEY, type Fetcher, type HttpRequest } from "../src/websearch.ts";

const NOW = () => new Date("2026-08-24T12:00:00.000Z");

interface Call {
  cmd: string;
  args: string[];
}

/** Answers a script of commands and records every call, so we can assert the argv without qmd. */
function stub(answers: Record<string, Partial<RunResult>>): Runner & { calls: Call[] } {
  const calls: Call[] = [];
  const runner = (cmd: string, args: readonly string[], _opts: RunOpts): Promise<RunResult> => {
    calls.push({ cmd, args: [...args] });
    const key = [cmd, ...args].join(" ");
    const match = Object.keys(answers)
      .filter((k) => key.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    const answer = match === undefined ? {} : (answers[match] as Partial<RunResult>);
    return Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: false, spawnError: null, ...answer });
  };
  return Object.assign(runner, { calls });
}

const NO_QMD = { "qmd --version": { code: -1, spawnError: "spawn qmd ENOENT" } };
const QMD_INSTALLED = { "qmd --version": { stdout: "qmd 2.8.3 (facd35e)\n" } };

const INDEX_YML = `collections:
  knowledge:
    path: /somewhere/knowledge
    pattern: "**/*.md"
  lineage:
    path: /somewhere/lineage
    pattern: "**/*.md"
models:
  embed: hf:ggml-org/embeddinggemma-300M-GGUF/x.gguf
`;

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "avo-know-"));
}

function write(root: string, rel: string, body: string): void {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function http(answer: Partial<{ status: number; ok: boolean; body: string; error: string | null }>): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const fetcher = (url: string, _req: HttpRequest) => {
    calls.push(url);
    return Promise.resolve({ status: 200, ok: true, body: "{}", error: null, ...answer });
  };
  return Object.assign(fetcher, { calls });
}

// ------------------------------------------------------------------ pure parts

test("slugify and slugForUrl produce stable, bounded, filesystem-safe names", () => {
  assert.equal(slugify("Register Pressure & Occupancy!"), "register-pressure-occupancy");
  assert.equal(slugify("!!!"), "doc", "no letters left still yields a usable filename");
  assert.ok(slugify("x".repeat(200)).length <= 80);
  assert.equal(slugForUrl("https://arxiv.org/abs/2603.24517"), "arxiv-org-2603-24517");
  assert.equal(slugForUrl("https://example.com/docs/tuning.html"), "example-com-tuning");
  assert.equal(slugForUrl("https://example.com/"), "example-com", "a bare domain falls back to the host");
  assert.equal(slugForUrl("not a url"), "not-a-url", "a malformed url still yields a slug, not a throw");
});

test("renderDoc records provenance and docBody reads back past it", () => {
  const doc = renderDoc("https://x/y", 'a "quoted" title', "2026-08-24T12:00:00.000Z", "firecrawl", "# body\ntext");
  assert.match(doc, /^---\nsource: "https:\/\/x\/y"\n/);
  assert.match(doc, /title: "a \\"quoted\\" title"/, "quotes are escaped so the frontmatter stays parseable");
  assert.match(doc, /fetched-at: "2026-08-24T12:00:00.000Z"/);
  assert.equal(docBody(doc), "# body\ntext\n");
  assert.equal(docBody("no frontmatter"), "no frontmatter", "a plain file is all body");
});

test("a re-fetch of unchanged content compares equal even though fetched-at differs", () => {
  const a = renderDoc("u", "t", "2026-01-01T00:00:00.000Z", "firecrawl", "same");
  const b = renderDoc("u", "t", "2026-06-06T00:00:00.000Z", "firecrawl", "same");
  assert.notEqual(a, b);
  assert.equal(docBody(a), docBody(b));
});

test("queryTerms drops stopwords but never reduces a query to nothing", () => {
  assert.deepEqual(queryTerms("How do I avoid register spills"), ["avoid", "register", "spills"]);
  assert.deepEqual(queryTerms("the a of"), ["the", "a", "of"], "an all-stopword query keeps its words");
  assert.deepEqual(queryTerms("TMA TMA"), ["tma"], "terms are deduped");
});

test("readQmdCollections reads names out of index.yml and stops at the next top-level key", () => {
  const dir = scratch();
  try {
    assert.deepEqual(readQmdCollections(dir), [], "no index yet");
    write(dir, QMD_CONFIG, INDEX_YML);
    assert.deepEqual(readQmdCollections(dir), ["knowledge", "lineage"]);
    write(dir, QMD_CONFIG, "models:\n  embed: x\n");
    assert.deepEqual(readQmdCollections(dir), [], "a file with no collections block is not a crash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------- the probe

test("qmd installed but with no project index degrades and names the fix", async () => {
  const dir = scratch();
  try {
    const status = await probeQmd(stub(QMD_INSTALLED), dir);
    assert.equal(status.installed, true);
    assert.equal(status.available, false, "the global ~/.cache/qmd index would mix repos together");
    assert.equal(status.version, "qmd 2.8.3 (facd35e)");
    assert.match(status.reason ?? "", /avo know init/);

    write(dir, QMD_CONFIG, INDEX_YML);
    const ready = await probeQmd(stub(QMD_INSTALLED), dir);
    assert.equal(ready.available, true);
    assert.deepEqual(ready.collections, ["knowledge", "lineage"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing qmd yields exactly one warning naming the fallback", async () => {
  const backend = await resolveKnowledge(stub(NO_QMD), scratch());
  assert.equal(backend.kind, "files");
  assert.equal(backend.warnings.length, 1);
  assert.match(backend.warnings[0] ?? "", /not installed/);
  assert.match(backend.warnings[0] ?? "", /knowledge\/ and lineage\//);
});

// ---------------------------------------------------------------- the fallback

test("localSearch scores by term coverage across both collections", () => {
  const dir = scratch();
  try {
    write(dir, "knowledge/regs.md", "# Register pressure\n\nSpilling registers kills occupancy.\n");
    write(dir, "knowledge/tma.md", "# Async copy\n\nTMA overlaps transfers with compute.\n");
    write(dir, "lineage/v001.md", "# v1\n\nraised occupancy by capping registers\n");
    const hits = localSearch(dir, "register occupancy", 10);
    assert.equal(hits[0]?.file, "knowledge/regs.md");
    assert.equal(hits[0]?.score, 1, "both terms present");
    assert.equal(hits[0]?.title, "Register pressure");
    assert.equal(hits[0]?.collection, "knowledge");
    assert.ok(hits.some((h) => h.collection === "lineage"), "the lineage is searchable alongside K (PLAN §3)");
    assert.ok(!hits.some((h) => h.file.includes("tma")), "a document matching no term is not a hit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("localSearch indexes only markdown, ignores dotfiles, and points at the best line", () => {
  const dir = scratch();
  try {
    write(dir, "knowledge/notes.md", "intro\nfiller\nthe TMA descriptor lives in constant memory\n");
    write(dir, "knowledge/data.json", '{"tma": "should not be indexed"}');
    write(dir, "knowledge/.hidden/secret.md", "tma");
    const hits = localSearch(dir, "tma descriptor", 10);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.file, "knowledge/notes.md");
    assert.equal(hits[0]?.line, 3);
    assert.match(hits[0]?.snippet ?? "", /constant memory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("localSearch on an empty repo returns nothing rather than throwing", () => {
  assert.deepEqual(localSearch(scratch(), "anything", 5), []);
});

// -------------------------------------------------------------- avo know init

test("know init creates both collection dirs and skips qmd when it is absent", async () => {
  const dir = scratch();
  try {
    const r = await runKnowInit(dir, stub(NO_QMD));
    assert.equal(r.ok, true, "qmd's absence is a degradation, not a failure (invariant 4)");
    assert.equal(r.backend, "files");
    for (const c of COLLECTIONS) assert.ok(existsSync(join(dir, c.dir)), `${c.dir} exists`);
    assert.equal(r.steps.find((s) => s.name === "qmd")?.action, "skipped");
    assert.match(r.warnings.join(" "), /npm i -g @tobilu\/qmd/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("know init runs the verified qmd argv: init, collection add, context add", async () => {
  const dir = scratch();
  try {
    const runner = stub(QMD_INSTALLED);
    // `qmd init` writes index.yml for real; emulate that so the second phase sees an index.
    const withInit: Runner & { calls: Call[] } = Object.assign(
      (cmd: string, args: readonly string[], opts: RunOpts) => {
        if (args[0] === "init") write(dir, QMD_CONFIG, "collections:\n");
        return runner(cmd, args, opts);
      },
      { calls: runner.calls },
    );
    const r = await runKnowInit(dir, withInit);
    assert.equal(r.backend, "qmd");
    const argv = runner.calls.map((c) => c.args.join(" "));
    assert.ok(argv.includes("init"));
    assert.ok(argv.includes("collection add knowledge --name knowledge"));
    assert.ok(argv.includes("collection add lineage --name lineage"));
    assert.ok(argv.some((a) => a.startsWith("context add qmd://knowledge/ ")));
    assert.ok(argv.some((a) => a.startsWith("context add qmd://lineage/ ")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("know init is idempotent: an existing index and collections are re-used, not re-added", async () => {
  const dir = scratch();
  try {
    write(dir, QMD_CONFIG, INDEX_YML);
    const runner = stub(QMD_INSTALLED);
    const r = await runKnowInit(dir, runner);
    assert.equal(r.ok, true);
    const actions = Object.fromEntries(r.steps.map((s) => [s.name, s.action]));
    assert.equal(actions["qmd init"], "unchanged");
    assert.equal(actions["collection knowledge"], "unchanged");
    assert.equal(actions["collection lineage"], "unchanged");
    const mutating = runner.calls.filter((c) => c.args[0] === "collection" || c.args[0] === "context" || c.args[0] === "init");
    assert.deepEqual(mutating, [], "a second run must not touch the index or overwrite an edited context");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the qmd index is gitignored, because index.yml records absolute paths", () => {
  const dir = scratch();
  try {
    assert.equal(ensureQmdIgnored(dir), "created");
    assert.match(readFileSync(join(dir, QMD_IGNORE), "utf8"), /^\*$/m);
    assert.equal(ensureQmdIgnored(dir), "unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- avo know query

test("know query passes the documented qmd argv and maps its hits into our shape", async () => {
  const dir = scratch();
  try {
    write(dir, QMD_CONFIG, INDEX_YML);
    const hit = { docid: "#8b65e5", score: 0.87, file: "./knowledge/regs.md", line: 3, title: "Register pressure", snippet: "spills" };
    const runner = stub({ ...QMD_INSTALLED, "qmd query": { stdout: JSON.stringify([hit]) } });
    const backend = await resolveKnowledge(runner, dir);
    const r = await knowQuery(runner, dir, backend, "register spills", { n: 3, collection: "knowledge", lexical: false, minScore: null, timeoutMs: 1000 });
    assert.equal(r.backend, "qmd");
    assert.deepEqual(runner.calls[1]?.args, [
      "query", "register spills", "--format", "json", "--full-path", "-n", "3", "-c", "knowledge",
    ]);
    assert.deepEqual(r.hits[0], { file: "knowledge/regs.md", line: 3, title: "Register pressure", score: 0.87, snippet: "spills", collection: "knowledge" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--lexical runs qmd search instead of the LLM-expanding query", async () => {
  const dir = scratch();
  try {
    write(dir, QMD_CONFIG, INDEX_YML);
    const runner = stub({ ...QMD_INSTALLED, "qmd search": { stdout: "[]" } });
    const backend = await resolveKnowledge(runner, dir);
    await knowQuery(runner, dir, backend, "q", { n: 5, collection: null, lexical: true, minScore: null, timeoutMs: 1000 });
    assert.equal(runner.calls[1]?.args[0], "search");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a qmd that fails, times out or returns junk still answers, from the local scan", async () => {
  const dir = scratch();
  try {
    write(dir, QMD_CONFIG, INDEX_YML);
    write(dir, "knowledge/regs.md", "# Registers\n\nspilling registers hurts\n");
    const junk = stub({ ...QMD_INSTALLED, "qmd query": { stdout: "not json" } });
    const backend = await resolveKnowledge(junk, dir);
    const r = await knowQuery(junk, dir, backend, "spilling registers", { n: 5, collection: null, lexical: false, minScore: null, timeoutMs: 1000 });
    assert.equal(r.backend, "files");
    assert.equal(r.hits.length, 1, "the answer is the same shape whichever backend produced it");
    assert.match(r.warnings.join(" "), /did not return JSON/);

    const broken = stub({ ...QMD_INSTALLED, "qmd query": { code: 1, stderr: "index locked" } });
    const r2 = await knowQuery(broken, dir, await resolveKnowledge(broken, dir), "spilling registers", { n: 5, collection: null, lexical: false, minScore: null, timeoutMs: 1000 });
    assert.equal(r2.backend, "files");
    assert.match(r2.warnings.join(" "), /index locked/);

    const slow = stub({ ...QMD_INSTALLED, "qmd query": { timedOut: true } });
    const r3 = await knowQuery(slow, dir, await resolveKnowledge(slow, dir), "q", { n: 5, collection: null, lexical: false, minScore: null, timeoutMs: 1 });
    assert.match(r3.errors.join(" "), /--lexical/, "a timeout suggests the cheap path rather than just failing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("qmd's 'needs embeddings' note is surfaced, because it explains an empty vector result", async () => {
  const dir = scratch();
  try {
    write(dir, QMD_CONFIG, INDEX_YML);
    const runner = stub({ ...QMD_INSTALLED, "qmd query": { stdout: "[]", stderr: "Warning: 2 documents (100%) need embeddings.\n" } });
    const r = await knowQuery(runner, dir, await resolveKnowledge(runner, dir), "q", { n: 5, collection: null, lexical: false, minScore: null, timeoutMs: 1000 });
    assert.match(r.warnings.join(" "), /need embeddings.*qmd embed/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--min-score filters both backends the same way", async () => {
  const dir = scratch();
  try {
    write(dir, "knowledge/a.md", "alpha beta\n");
    write(dir, "knowledge/b.md", "alpha only\n");
    const runner = stub(NO_QMD);
    const backend = await resolveKnowledge(runner, dir);
    const all = await knowQuery(runner, dir, backend, "alpha beta", { n: 5, collection: null, lexical: false, minScore: null, timeoutMs: 0 });
    assert.equal(all.hits.length, 2);
    const strict = await knowQuery(runner, dir, backend, "alpha beta", { n: 5, collection: null, lexical: false, minScore: 1, timeoutMs: 0 });
    assert.deepEqual(strict.hits.map((h) => h.file), ["knowledge/a.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------- avo know add

test("know add copies a local file into K with provenance, then embeds it", async () => {
  const dir = scratch();
  try {
    write(dir, QMD_CONFIG, INDEX_YML);
    write(dir, "notes/tuning.md", "# Tuning\n\nbody\n");
    const runner = stub(QMD_INSTALLED);
    const backend = await resolveKnowledge(runner, dir);
    const r = await knowAdd(runner, http({}), {}, dir, backend, "notes/tuning.md", { name: null, force: false, noEmbed: false, backend: null, timeoutMs: 0 }, NOW);
    assert.equal(r.ok, true);
    assert.equal(r.action, "created");
    assert.equal(r.path, "knowledge/notes-tuning.md");
    assert.equal(r.embedded, true);
    const doc = readFileSync(join(dir, r.path ?? ""), "utf8");
    assert.match(doc, /source: "notes\/tuning.md"/);
    assert.match(doc, /title: "Tuning"/, "the title comes from the first heading");
    assert.match(doc, /via: "file"/);
    // `qmd embed` only vectorizes documents the index already knows about, so a doc written after
    // `collection add` needs `qmd update` first or it stays invisible to every search.
    const argv = runner.calls.map((c) => c.args.join(" "));
    assert.deepEqual(
      argv.filter((a) => a.startsWith("update") || a.startsWith("embed")),
      ["update -c knowledge", "embed -c knowledge"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-adding identical content is unchanged; differing content is refused without --force", async () => {
  const dir = scratch();
  try {
    write(dir, "src.md", "# T\n\none\n");
    const runner = stub(NO_QMD);
    const backend = await resolveKnowledge(runner, dir);
    const opts = { name: null, force: false, noEmbed: true, backend: null, timeoutMs: 0 };
    const first = await knowAdd(runner, http({}), {}, dir, backend, "src.md", opts, NOW);
    assert.equal(first.action, "created");
    const again = await knowAdd(runner, http({}), {}, dir, backend, "src.md", opts, () => new Date("2027-01-01T00:00:00.000Z"));
    assert.equal(again.action, "unchanged", "a later fetched-at must not read as a change (invariant 5)");

    write(dir, "src.md", "# T\n\ntwo\n");
    const conflict = await knowAdd(runner, http({}), {}, dir, backend, "src.md", opts, NOW);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.action, "refused");
    assert.match(conflict.error ?? "", /--force/);
    assert.match(readFileSync(join(dir, "knowledge/src.md"), "utf8"), /one/, "a refusal leaves the doc untouched");

    const forced = await knowAdd(runner, http({}), {}, dir, backend, "src.md", { ...opts, force: true }, NOW);
    assert.equal(forced.action, "updated");
    assert.match(readFileSync(join(dir, "knowledge/src.md"), "utf8"), /two/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("know add of a url scrapes via firecrawl and warns when qmd cannot embed it", async () => {
  const dir = scratch();
  try {
    const fetcher = http({ body: JSON.stringify({ data: { markdown: "# AVO\n\npaper", metadata: { title: "AVO" } } }) });
    const runner = stub(NO_QMD);
    const backend = await resolveKnowledge(runner, dir);
    const r = await knowAdd(runner, fetcher, { [FIRECRAWL_KEY]: "k" }, dir, backend, "https://arxiv.org/abs/2603.24517", { name: null, force: false, noEmbed: false, backend: null, timeoutMs: 0 }, NOW);
    assert.equal(r.ok, true);
    assert.equal(r.path, "knowledge/arxiv-org-2603-24517.md");
    assert.equal(r.embedded, false);
    assert.match(r.warnings.join(" "), /not embedded — the local scan still finds it/);
    assert.equal(fetcher.calls[0], "https://api.firecrawl.dev/v2/scrape");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("know add of a url with no key names the alternatives instead of throwing", async () => {
  const dir = scratch();
  try {
    const runner = stub(NO_QMD);
    const r = await knowAdd(runner, http({}), {}, dir, await resolveKnowledge(runner, dir), "https://x/y", { name: null, force: false, noEmbed: true, backend: null, timeoutMs: 0 }, NOW);
    assert.equal(r.action, "refused");
    assert.match(r.error ?? "", /FIRECRAWL_API_KEY is not set/);
    assert.match(r.error ?? "", /avo know add <path>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--name overrides the derived slug and an unreadable file is an error, not a crash", async () => {
  const dir = scratch();
  try {
    write(dir, "a.md", "x\n");
    const runner = stub(NO_QMD);
    const backend = await resolveKnowledge(runner, dir);
    const named = await knowAdd(runner, http({}), {}, dir, backend, "a.md", { name: "Custom Name", force: false, noEmbed: true, backend: null, timeoutMs: 0 }, NOW);
    assert.equal(named.path, "knowledge/custom-name.md");
    const missing = await knowAdd(runner, http({}), {}, dir, backend, "nope.md", { name: null, force: false, noEmbed: true, backend: null, timeoutMs: 0 }, NOW);
    assert.equal(missing.action, "failed");
    assert.match(missing.error ?? "", /could not read nope.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("a failing qmd update stops short of claiming the doc was embedded", async () => {
  const dir = scratch();
  try {
    write(dir, QMD_CONFIG, INDEX_YML);
    write(dir, "a.md", "x\n");
    const runner = stub({ ...QMD_INSTALLED, "qmd update": { code: 1, stderr: "index locked\n" } });
    const backend = await resolveKnowledge(runner, dir);
    const r = await knowAdd(runner, http({}), {}, dir, backend, "a.md", { name: null, force: false, noEmbed: false, backend: null, timeoutMs: 0 }, NOW);
    assert.equal(r.ok, true, "the doc is on disk; only the index is stale");
    assert.equal(r.embedded, false);
    assert.match(r.warnings.join(" "), /qmd update failed \(index locked\)/);
    assert.ok(!runner.calls.some((c) => c.args[0] === "embed"), "embedding an unindexed doc is pointless");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--lexical with --min-score says the scoreless BM25 path cannot honour a threshold", async () => {
  const dir = scratch();
  try {
    write(dir, QMD_CONFIG, INDEX_YML);
    const hit = { score: 0, file: "./knowledge/a.md", line: 1, title: "A", snippet: "s" };
    const runner = stub({ ...QMD_INSTALLED, "qmd search": { stdout: JSON.stringify([hit]) } });
    const r = await knowQuery(runner, dir, await resolveKnowledge(runner, dir), "q", { n: 5, collection: null, lexical: true, minScore: 0.5, timeoutMs: 1000 });
    assert.equal(r.hits.length, 1, "the hits are returned rather than silently filtered to nothing");
    assert.match(r.warnings.join(" "), /does not report a relevance score/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("avo know reindex re-scans every collection, or just the named one", async () => {
  const dir = scratch();
  try {
    write(dir, QMD_CONFIG, INDEX_YML);
    const runner = stub(QMD_INSTALLED);
    const io = bufferIo();
    assert.equal(await knowCommand(["reindex", "--cwd", dir, "--json"], io, runner, http({}), {}, NOW), 0);
    const out = JSON.parse(io.stdout) as { ok: boolean; reindexed: string[] };
    assert.deepEqual(out.reindexed, ["knowledge", "lineage"]);
    assert.equal(out.ok, true);

    const one = stub(QMD_INSTALLED);
    await knowCommand(["reindex", "-c", "lineage", "--cwd", dir, "--json"], bufferIo(), one, http({}), {}, NOW);
    assert.deepEqual(
      one.calls.map((c) => c.args.join(" ")).filter((a) => a.startsWith("update")),
      ["update -c lineage"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("avo know reindex without qmd is a successful no-op, because the local scan is never stale", async () => {
  const dir = scratch();
  try {
    const io = bufferIo();
    assert.equal(await knowCommand(["reindex", "--cwd", dir, "--json"], io, stub(NO_QMD), http({}), {}, NOW), 0);
    const out = JSON.parse(io.stdout) as { backend: string; reindexed: string[] };
    assert.equal(out.backend, "files");
    assert.deepEqual(out.reindexed, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------- argument parsing

test("parseKnowArgs requires a subcommand and an argument for the ones that need one", () => {
  const err = (argv: string[]) => (parseKnowArgs(argv) as { error: string }).error;
  assert.match(err([]), /needs a subcommand/);
  assert.match(err(["query"]), /needs a query/);
  assert.match(err(["add"]), /needs a url or a path/);
  assert.match(err(["init", "extra"]), /unexpected argument 'extra'/);
  assert.match(err(["reindex", "extra"]), /unexpected argument 'extra'/);
  assert.match(err(["add", "a", "b"]), /one url or path at a time/);
  assert.match(err(["query", "q", "--nope"]), /unknown option '--nope'/);
  assert.match(err(["query", "q", "-n"]), /-n needs a value/);
  assert.match(err(["query", "q", "-n", "x"]), /non-negative number/);
  assert.match(err(["query", "q", "-n", "0"]), /at least 1/);
  assert.match(err(["search", "q", "--backend", "bing"]), /unknown --backend 'bing'/);
});

test("parseKnowArgs joins a multi-word query and reads every flag", () => {
  const o = parseKnowArgs(["query", "register", "pressure", "--json", "-n", "9", "-c", "lineage", "--lexical", "--min-score", "0.5", "--timeout", "12"]);
  assert.ok(!("error" in o));
  assert.deepEqual(o.args, ["register", "pressure"]);
  assert.equal(o.sub, "query");
  assert.equal(o.json, true);
  assert.equal(o.n, 9);
  assert.equal(o.collection, "lineage");
  assert.equal(o.lexical, true);
  assert.equal(o.minScore, 0.5);
  assert.equal(o.timeoutMs, 12_000);
});

// -------------------------------------------------------------------- the command

test("avo know query --json emits the same keys with or without qmd", async () => {
  const dir = scratch();
  try {
    write(dir, "knowledge/x.md", "# X\n\nregister pressure notes\n");
    const io = bufferIo();
    const code = await knowCommand(["query", "register pressure", "--json", "--cwd", dir], io, stub(NO_QMD), http({}), {}, NOW);
    assert.equal(code, 0);
    const out = JSON.parse(io.stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(out).sort(), ["backend", "errors", "hits", "query", "warnings"]);
    assert.equal(out["backend"], "files");
    assert.equal((out["hits"] as unknown[]).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty result is exit 0 with a pointer at how to grow K, not an error", async () => {
  const dir = scratch();
  try {
    const io = bufferIo();
    const code = await knowCommand(["query", "nothing here", "--cwd", dir], io, stub(NO_QMD), http({}), {}, NOW);
    assert.equal(code, 0);
    assert.match(io.stdout, /avo know add/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("avo know search --ingest writes the pages firecrawl returned into K", async () => {
  const dir = scratch();
  try {
    const body = JSON.stringify({ data: { web: [{ title: "AVO", url: "https://arxiv.org/abs/1", description: "d", markdown: "# AVO\n\nbody" }] } });
    const io = bufferIo();
    const code = await knowCommand(["search", "avo paper", "--ingest", "--json", "--cwd", dir], io, stub(NO_QMD), http({ body }), { [FIRECRAWL_KEY]: "k" }, NOW);
    assert.equal(code, 0);
    const out = JSON.parse(io.stdout) as { ingested: { path: string; action: string }[] };
    assert.equal(out.ingested[0]?.action, "created");
    assert.equal(out.ingested[0]?.path, "knowledge/arxiv-org-1.md");
    assert.match(readFileSync(join(dir, "knowledge/arxiv-org-1.md"), "utf8"), /source: "https:\/\/arxiv.org\/abs\/1"/);
    // And it is immediately findable, which is the whole point of ingesting.
    assert.equal(localSearch(dir, "avo body", 5).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--ingest against a snippet-only backend writes nothing and says why", async () => {
  const dir = scratch();
  try {
    const runner = stub({ ...NO_QMD, ddgs: { code: -1, spawnError: "spawn ddgs ENOENT" } });
    const io = bufferIo();
    const code = await knowCommand(["search", "q", "--ingest", "--cwd", dir], io, runner, http({}), {}, NOW);
    assert.equal(code, 2);
    assert.match(io.stderr, /ddgs is not installed/);
    assert.ok(!existsSync(join(dir, "knowledge")), "a failed search creates nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("avo know add exits 1 when refused and 2 on a harness error", async () => {
  const dir = scratch();
  try {
    write(dir, "a.md", "one\n");
    const runner = stub(NO_QMD);
    const io = bufferIo();
    assert.equal(await knowCommand(["add", "a.md", "--cwd", dir], io, runner, http({}), {}, NOW), 0);
    write(dir, "a.md", "two\n");
    assert.equal(await knowCommand(["add", "a.md", "--cwd", dir], bufferIo(), runner, http({}), {}, NOW), 1, "refused");
    assert.equal(await knowCommand(["add", "gone.md", "--cwd", dir], bufferIo(), runner, http({}), {}, NOW), 2, "harness error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
