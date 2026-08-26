---
name: avo-knowledge
description: Search and grow `K`, an avocode repo's knowledge base — `avo know query` for hybrid search over local docs and the repo's own lineage, `avo know search` for the web, and `avo know add` to ingest a page or file with provenance. Use before proposing a technical approach, when you need documentation or a paper, or when asked what the repo already knows about something.
---

# avo know — `K`, the knowledge base

`K` is two markdown collections indexed for search:

- `knowledge/` — docs, papers, API references, anything ingested from the web or a local file.
- `lineage/` — the repo's **own** rendered version history. Searching your own past is the point:
  "what did I already try about X?" is answered by the same command as "how does this API work?".

## Search `K` first

```bash
avo know query "flash attention tiling"         # hybrid search + rerank
avo know query "register pressure" --json       # for jq
avo know query "..." -n 10                      # more hits (default 5)
avo know query "..." -c lineage                 # one collection only
avo know query "..." --min-score 0.5            # drop weak hits
avo know query "..." --lexical                  # BM25 only: no LLM expansion, no rerank
```

Scores are `0..1`, higher is better, and mean the same thing whether or not `qmd` is installed —
without it the same query runs as a local scan over the same files. **Never branch on the backend.**

`--lexical` with `--min-score` returns the hits plus a warning: the lexical backend reports score `0`
for everything, so a threshold would silently discard the lot.

## Grow it from the web

```bash
avo know search "cuda warp specialization"              # links + snippets
avo know search "..." --ingest                          # also write the pages into K
avo know search "..." --backend ddgs                    # keyless
```

Backends: `firecrawl` (needs `FIRECRAWL_API_KEY`; the only one returning page *content*, so the only
one `--ingest` works with), `searxng` (needs `SEARXNG_URL`), `ddgs` (keyless, links only). With
nothing configured it names all three and how to enable each rather than failing.

## Ingest one specific thing

```bash
avo know add https://arxiv.org/abs/2506.xxxxx           # fetch -> knowledge/<slug>.md
avo know add ./notes/kernel-design.md                   # a local file
avo know add <url> --name flash-attn-3                  # name the doc
avo know add <url> --force                              # replace a differing existing doc
```

Every ingested doc carries provenance frontmatter — `source`, `title`, `fetched-at`, `via`. **A doc in
`K` with no source is one you cannot re-check**, so do not hand-write files into `knowledge/`; run
`avo know add` on the local file instead.

Ingest is idempotent on the doc **body**: identical content is `unchanged`, differing content is
refused until `--force`. The comparison ignores `fetched-at`, which would otherwise make every
re-fetch look like a conflict.

## Keep the index current

```bash
avo know reindex          # re-scan the collections; needed after files land in lineage/
avo know init             # create the collections (folded into `avo init`)
```

`avo commit` writes `lineage/vNNN.md` directly, so run `avo know reindex` before searching the lineage
for something committed in this session.

## Judgement

- **Query `K` before you propose an approach**, and again when an approach keeps failing. It costs one
  command and holds everything past sessions learned.
- **Prefer `query` to `search`.** The web costs credits and latency; `K` is local. Go online when `K`
  has nothing, then ingest what you find so the next session does not have to.
- `avo know query` can be slow cold (tens of seconds while the reranker loads). Use `--lexical` for a
  fast keyword pass.
