# Code notes: the core of avocode

Auxiliary notes for the article "An implementation of NVIDIA's Agentic Variation Operators (AVO)
for Autonomous Evolutionary Search". All references are `file:line` against the tree at commit
`d05177c`. Code excerpts are verbatim. Where the code and the docs disagree, the code wins and the
note says so.

Scope: `src/score.ts`, `src/compare.ts`, `src/config.ts`, `src/lineage.ts`, `src/mem.ts`,
`src/knowledge.ts`, `src/websearch.ts`, `src/cli.ts`, `src/main.ts`, `src/io.ts`, `src/steps.ts`,
`src/init.ts`, `src/doctor.ts`, `src/install.ts`, `src/skills.ts`, `src/version.ts`,
`templates/score/*`, `.agents/skills/*/SKILL.md`, and the tests in `test/`. `fan.ts`, `run.ts`
and `supervise.ts` are touched only where the core depends on them.

---

## 0. Shape of the program

- `bin/avo` is a bash shim that runs `src/main.ts` through `tsx`. There is no build step
  (`docs/architecture.md:60-62`).
- `src/main.ts:1-3` is the whole entry point:

  ```ts
  import { main } from "./cli.ts";
  process.exitCode = await main(process.argv.slice(2));
  ```

- `src/cli.ts:120-162` is a flat `switch` over the first argument. Each subcommand owns its own
  flag parser (`parseScoreArgs`, `parseCommitArgs`, ...). Unknown command → usage on stderr, exit 2.
- `src/io.ts:2-25` defines an injectable `Io { out, err }` sink plus `bufferIo()` for tests. Every
  `*Command` takes `io`, and every external process goes through an injectable `Runner`
  (`src/score.ts:108`). The network goes through an injectable `Fetcher` (`src/websearch.ts:55`).
  This is why the whole CLI is unit-testable without a terminal, a scorer, git, or a network.
- `src/steps.ts:9-15`: `StepAction = "created" | "unchanged" | "skipped" | "failed"`, shared by
  `init`, `know init` and `install` so idempotency is visible in the output.
- `src/version.ts:6-8`: the version is read from `package.json` at load time.
- Exit-code convention, used by almost every command: `0` success, `1` refused / ran-but-failed,
  `2` harness or usage error (`src/score.ts:612`, `src/lineage.ts:621`, `src/knowledge.ts:835`).

---

## 1. Mapping AVO's formal objects to code

The paper (`docs/avo-paper.md:27-29`) defines `Vary(P_t) = Agent(P_t, K, f)` with
`P_t = {(x_1, f(x_1)), …, (x_t, f(x_t))}`, `K` a knowledge base, and `f` a vector-valued scorer.
avocode's mapping (`docs/architecture.md:12-18`):

| Symbol | avocode artifact | Owner |
| --- | --- | --- |
| `f` | executable `.avo/score`, one JSON line | `src/score.ts` |
| `f`'s order | vector comparator + config | `src/compare.ts`, `src/config.ts` |
| `P_t` | git commits with `Avo-Version` / `Avo-Score` trailers, `git notes --ref=avo`, `lineage/vNNN.md` | `src/lineage.ts` |
| `K` | `knowledge/` + `lineage/`, indexed by qmd or scanned locally; web ingest | `src/knowledge.ts`, `src/websearch.ts` |
| agent memory | beads (`bd`) or `lineage/memory.jsonl` | `src/mem.ts` |
| Agent | any coding agent (pi, Claude Code, Codex) driven by `.agents/skills/` | `src/install.ts`, `src/skills.ts` |
| trajectory (not in paper's `P_t`) | `.avo/attempts.jsonl`, `.avo/worktrees/`, `.avo/runs/` | `src/score.ts`, `src/lineage.ts:16` |

### 1.1 `f` — the `.avo/score` contract

**Invocation.** `.avo/score` is any executable, run with the repo root as cwd. Three forms
(`src/score.ts:31-42`):

```
.avo/score                   score everything; print one JSON line
.avo/score --configs         print config names, one per line (optional; enables --parallel)
.avo/score --config <name>   score one config; print one JSON line
```

**Schema** (`src/score.ts:43-55`), TypeBox:

```ts
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
```

- Required: `ok`, `correct`, `primary` (`number | null`), `unit` (non-empty), `higher_is_better`.
- Optional: `scores` (the vector), `log`, `duration_s`.
- Unknown keys are allowed but each produces `unknown field '<k>' ignored`
  (`src/score.ts:248-250`). A typo such as `higherIsBetter` thus reports both "missing" and
  "unknown" (test: `test/score.test.ts:69`).
- Extra semantic checks the schema cannot express (`src/score.ts:253-260`): when
  `ok && correct`, `primary` must be finite; every `scores.<cfg>` must be finite (rejects `1e999`,
  test `test/score.test.ts:88`).

**Meaning of the two booleans** (`templates/score/README.md:44-56`): `ok` = the scorer itself
worked (not a verdict on the candidate); `correct` = **the gate**. `pass = ok && correct`
(`src/score.ts:325-327`).

**Parsing tolerance.** stdout may carry build noise. The parser scans *backwards* for the last line
that parses as a JSON object and warns that it used line *k* of *n* (`src/score.ts:206-239`).

**Harness errors vs results.** `interpret()` (`src/score.ts:300-309`) maps a raw process run to
either a validated output or a list of *harness errors*:

- spawn failure → `could not execute .avo/score — …`
- timeout → `.avo/score exceeded the timeout and was killed`
- parse/schema failure → field-level messages, with `(it also exited N)` if the exit code was
  non-zero.

A non-zero exit with a valid JSON line is *not* an error; the contract says "always exit 0" but the
code tolerates violations (`src/score.ts:37-38`).

**Normalization into an `Attempt`** (`src/score.ts:62-90`, `315-364`):

```ts
const ok = errors.length === 0 && outputs.length > 0 && outputs.every((o) => o.ok);
const correct = outputs.length > 0 && outputs.every((o) => o.correct);
const pass = ok && correct;
...
const primary = pass && primaries.length > 0 ? primaries.reduce((a, b) => a + b, 0) / primaries.length : null;
...
normalized: primary === null ? null : higherIsBetter ? primary : -primary,
```

- **Failing sentinel.** If `!pass`, `primary` is forced to `null` whatever was measured. This is
  the paper's "a candidate that fails correctness is assigned zero score" (`docs/avo-paper.md:31`),
  generalized: zero is the *best* value of a lower-is-better metric, so it cannot mean failure
  (`src/score.ts:69-73`; test `test/score.test.ts:145`).
- `normalized` flips the sign so higher is always better. It is informative only; the commit rule
  uses the `scores` vector (§2).
- With several configs, `primary` is the arithmetic mean of per-config primaries
  (`src/score.ts:311-314`). It is a headline, not the criterion.
- **Vector assembly** (`src/score.ts:329-334`): a part's own `scores` map is merged in
  (`Object.assign`); otherwise, if the part was a named config run, its `primary` becomes
  `scores[config]`. One failing config fails the whole attempt (`test/score.test.ts:180`).
- `higher_is_better` is taken from the *first* output only (`src/score.ts:338`). Mixed directions
  across per-config runs are not detected (edge case, see §5.4).
- `duration_s`: the scorer's own value if there was exactly one output, else avo's wall clock
  (`src/score.ts:354-355`).

**Multi-config / parallel scoring** (`src/score.ts:552-583`). With `--parallel`:

1. If `.avo/config.json` declares `configs`, use them and skip the probe (issue #4; test
   `test/score.test.ts:587`).
2. Else run `.avo/score --configs`. Names must match `CONFIG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/`
   (`src/config.ts:11`); anything else ⇒ "unsupported" ⇒ one serial run plus one warning
   (`src/score.ts:266-274`, `563-568`).
3. Run `.avo/score --config <name>` for each, at most `concurrencyCap()` at a time:
   `Math.max(1, Math.min(8, availableParallelism() - 2))` (`src/score.ts:291-293`), order-preserving
   via `mapLimit` (`src/score.ts:277-289`).

Without `--parallel`, a single run labelled `"*"`.

**Timeouts and process groups** (`src/score.ts:110-151`). The child is spawned `detached: true` so it
leads its own process group; on timeout avo sends `SIGKILL` to `-pid`, killing benchmarks the scorer
spawned too (test `test/score.test.ts:548`). `PWD` is set to the cwd as well, because some tools
(qmd) trust `$PWD` over the real cwd (`src/score.ts:116-121`). `--timeout` defaults to `0` = no
limit for `score`/`commit` (`src/score.ts:456`, `src/cli.ts:38`); `fan` and `run` default to 900 s.

**Output cap** (`src/score.ts:17-28`, `160-181`). 200 000 chars per stream: a 150 000 head plus a
rolling 50 000 tail, with a plain-text marker `--- avo elided N bytes of output here ---`. The tail
exists because the payload (the JSON line, or an agent's final `result` event) is printed *last*. A
head-only cap once lost token counts: 44 tokens reported for a run that sent 985 039 (issues #43,
#22; test `test/score.test.ts:515`).

**Attempt log.** Unless `--no-record`, every run appends one JSON line to `.avo/attempts.jsonl`
(`src/score.ts:16`, `600-607`). The attempt includes `git: {head, dirty}` (`src/score.ts:513-518`),
which the supervisor later uses to decide "since the best version" by SHA rather than clock
(`docs/commands.md:268-270`).

**Exit codes** (`src/score.ts:612-644`): `0` pass, `1` ran but failed, `2` harness error (no
executable scorer, malformed output, timeout, usage).

**Gates such as tests and lint.** avocode has no built-in test or lint gate. Gating is the scorer's
job, expressed through `correct`. The shipped templates show the patterns:

| Template | `correct` | `primary` | Direction |
| --- | --- | --- | --- |
| `hyperfine.sh` | `CORRECTNESS_CMD` (default `npm test`) exits 0 (`templates/score/hyperfine.sh:17-18`, `53-56`) | mean seconds per config | lower |
| `pytest.sh` | suite runnable, ≥1 test collected; or all-pass with `REQUIRE_ALL_PASS=true` (`templates/score/pytest.sh:84-87`, `155-158`) | pass rate | higher |
| `vitest.sh` | same as pytest, from vitest's JSON reporter (`templates/score/vitest.sh:106-108`, `172-174`) | pass rate | higher |

All templates emit `primary: null` on failure via an `emit()` helper and `exit 0`
(`templates/score/hyperfine.sh:26-31`). Note `hyperfine.sh:67` reports `ok:false, correct:true` when
the benchmark tool itself fails: a harness failure, not a verdict.

`avo score --init <t>` copies a template to `.avo/score` with mode `0755`. Identical content →
`unchanged`; different content is never overwritten without `--force` (`src/score.ts:415-441`).

### 1.2 `P_t` — the lineage as git

**Definition.** A version exists iff a commit reachable from `HEAD` carries a readable
`Avo-Version` trailer *and* a readable `Avo-Score` trailer (`src/lineage.ts:170-178`). Nothing else
(not `lineage/`, not notes) defines a version.

**Constants** (`src/lineage.ts:10`, `42-44`):

```ts
export const LINEAGE_DIR = "lineage";
export const NOTES_REF = "avo";
export const VERSION_TRAILER = "Avo-Version";
export const SCORE_TRAILER = "Avo-Score";
```

**Exact commit message** written by `writeCommit` (`src/lineage.ts:526-529`):

```ts
const subject = `avo v${version}: ${fmt(score.primary, score.unit)}`;
const why = opts.why !== null && opts.why.trim() !== "" ? [opts.why] : [];
const trailers = `${VERSION_TRAILER}: ${version}\n${SCORE_TRAILER}: ${JSON.stringify(score)}`;
const commit = await git(runner, opts.cwd, ["commit", "-m", subject, ...why.flatMap((w) => ["-m", w]), "-m", trailers]);
```

So the message is three paragraphs:

```
avo v2: 8 bytes

dropped the padding comment

Avo-Version: 2
Avo-Score: {"primary":8,"unit":"bytes","higher_is_better":false,"scores":{"*":8}}
```

The `Avo-Score` payload is a `VersionScore` = `{primary, unit, higher_is_better, scores}`
(`src/lineage.ts:51-56`). `toVersionScore` stores the *raw* (not sign-flipped) scores, and
synthesizes `{"*": primary}` when the scorer sent no `scores`, so the stored keys match what the
comparator will build (`src/lineage.ts:80-89`).

**Three records per version:**

1. The commit + trailers (minimal: exactly what the comparator reads back).
2. `git notes --ref=avo add -f` with `{version, attempt, comparison, why}`: the full attempt,
   including logs and deltas (`src/lineage.ts:538-549`). A failed note is a warning, not a failed
   commit.
3. `lineage/vNNN.md` (`v` + 3-digit zero pad, `src/lineage.ts:512`), rendered by
   `renderLineageFile` (`src/lineage.ts:248-300`): score, parent version and SHA, decision and
   reason, timestamp, a per-config table `| config | v<best> | v<new> | delta |`, new configs, the
   `--why` rationale, and the staged `git diff --cached --stat HEAD` taken *before* the lineage file
   is added (`src/lineage.ts:508-510`). This file is plain markdown on purpose: it is also a `K`
   collection (§1.3).

**Reading `P_t`** (`src/lineage.ts:178-223`). One `git log --format=%H<US>%aI<US>%B<RS> HEAD`, with
ASCII unit/record separators `\x1f` / `\x1e` that cannot appear in typed text
(`src/lineage.ts:46-48`). Robustness rules:

- Trailer lookup is "last line wins" (`src/lineage.ts:91-99`), because a rebase can prepend an older
  body.
- A non-integer or `< 1` `Avo-Version`, or an `Avo-Score` that fails `isVersionScore`
  (`src/lineage.ts:68-78`), is skipped with a warning, never trusted (test
  `test/lineage.test.ts:375`).
- Duplicate version numbers: `git log` is newest-first, so the newest commit wins, with a warning
  (`src/lineage.ts:206-210`).
- `rev` may be a range (`before..after`); `avo run` uses this to find versions the agent committed
  itself during a turn (`src/lineage.ts:175-177`).
- `extractWhy` returns the body minus subject and avo trailers (`src/lineage.ts:102-110`).

Because the lineage is read from `HEAD`'s ancestry, each git branch carries its own lineage, and
checking out an old commit resets `avo best`.

**`avo best`** (`src/lineage.ts:225-231`):

```ts
export function bestVersion(versions: readonly Version[]): Version | null {
  return versions.length === 0 ? null : (versions.reduce((a, b) => (b.version > a.version ? b : a)) as Version);
}
```

The best version is the *highest-numbered*, not the highest-scoring. This is sound only because the
commit rule admits only non-regressions (§2.4). `avo best` exits 1 when the lineage is empty
(`src/lineage.ts:782-805`).

**Lineage vs trajectory** (`src/lineage.ts:12-40`). Two path sets:

```ts
export const TRAJECTORY_PATHS: readonly string[] = [".avo/attempts.jsonl", ".avo/worktrees", ".avo/runs"];
...
export const HARNESS_PATHS: readonly string[] = [...TRAJECTORY_PATHS, TRAJECTORY_IGNORE, MEMORY_PATH];
```

- `TRAJECTORY_PATHS` are never committed: they are gitignored by `.avo/.gitignore`
  (`ensureTrajectoryIgnored`, `src/lineage.ts:140-163`) and also explicitly unstaged with
  `git reset -q HEAD -- …` after `git add -A` (`src/lineage.ts:503-506`), covering repos where the
  log was already tracked.
- `HARNESS_PATHS` (trajectory + `.avo/.gitignore` + `lineage/memory.jsonl`) are excluded from the
  *dirtiness* check only (`withoutTrajectory`, `src/lineage.ts:122-132`). They are still staged.
  Without this, the memory record avo writes after v1 would make the next run see a "change" the
  agent never made, score it, refuse it, record the refusal, and dirty the tree again
  (`src/lineage.ts:31-39`).
- `.avo/.gitignore` is extended additively only when its first line starts with `# written by avo`;
  an operator-written file is left alone (`src/lineage.ts:24-30`, `140-163`).

### 1.3 `K` — the knowledge base

**Collections** (`src/knowledge.ts:43-54`): `knowledge/` ("what we were told") and `lineage/`
("what we learned"). Both are qmd collections, each with a `qmd context add` description the
reranker reads (`src/knowledge.ts:396-399`). Only `*.md` is indexed (`src/knowledge.ts:33`).

The design point: because `avo commit` already writes `lineage/vNNN.md`, *"what did I already try
about register pressure?"* is the same query as *"what do the docs say about it?"*. This realizes the
paper's §3.2 observation that the agent "frequently examines multiple prior implementations in
`P_t`" (`docs/avo-paper.md:41`, `docs/architecture.md:194-197`).

**Backend selection** (`src/knowledge.ts:129-162`). qmd is usable only if `qmd --version` works
*and* the repo has `.qmd/index.yml`. Without a project index qmd silently uses the global
`~/.cache/qmd`, which would mix repos (`src/knowledge.ts:124-128`). Otherwise the backend is
`"files"`, with one warning.

**`avo know query`** (`src/knowledge.ts:462-498`):

- qmd: `qmd query <q> --format json --full-path -n N [-c coll]` = hybrid BM25 + vector + LLM query
  expansion + local GGUF rerank. `--lexical` swaps `query` for `qmd search` (BM25 only, fast,
  deterministic).
- qmd failure or non-JSON output → falls back to the local scan, with a warning.
- Fallback `localSearch` (`src/knowledge.ts:240-290`) is *not* BM25 and says so: `score =
  matched_distinct_terms / query_terms`, ties broken by total hits, then path. Stopwords are removed
  unless the query is all stopwords (`src/knowledge.ts:169-178`).
- Both backends return the same `Hit {file, line, title, score∈[0,1], snippet, collection}`
  (`src/knowledge.ts:77-86`), so an agent never branches on backend (invariants 3, 4).
- Quirk handled: qmd 2.8.3's `search` reports score 0, so `--lexical --min-score s>0` would drop
  every hit; the code returns the hits unfiltered with a warning (`src/knowledge.ts:480-485`).

**`avo know add <url|path>`** (`src/knowledge.ts:592-695`) — ingest with provenance:

```ts
const front = [
  "---",
  `source: "${escape(source)}"`,
  `title: "${escape(title)}"`,
  `fetched-at: "${fetchedAt}"`,
  `via: "${escape(via)}"`,
  "---",
  "",
].join("\n");
```

(`src/knowledge.ts:531-544`). `via` is `firecrawl` or `file`. Body capped at 400 000 chars
(`src/knowledge.ts:40`). Target path `knowledge/<slug>.md`; slug from URL path/host or file name, or
`--name` (`src/knowledge.ts:508-528`, `650-651`).

- URLs need `FIRECRAWL_API_KEY`; with no key, or with `--backend searxng|ddgs`, the add is *refused*
  (exit 1) and the message says to save the page and add the file (`src/knowledge.ts:608-622`).
- Idempotency compares *bodies* (`docBody` strips frontmatter), so a changing `fetched-at` is not a
  conflict. Same body → `unchanged`; different body → `refused` unless `--force`
  (`src/knowledge.ts:655-674`).
- After writing, `reindex()` runs `qmd update -c knowledge` then `qmd embed -c knowledge`. Order
  matters: `qmd embed` only vectorizes documents the index already knows (`src/knowledge.ts:552-570`).
- `avo know reindex` must be run after `avo commit` writes a new `lineage/vNNN.md`; `commit` does
  not reindex (`docs/commands.md:171-173`). The fallback reads live files and never needs it
  (`src/knowledge.ts:883-884`).

**`avo know init`** (`src/knowledge.ts:339-403`): creates both dirs, `qmd init` (project-local),
writes `.qmd/.gitignore` with `*` (the index holds absolute paths and a binary sqlite;
`src/knowledge.ts:322-333`), adds missing collections. qmd absent ⇒ `skipped`, not failed.

**Web search** (`src/websearch.ts`). Three backends behind one `Fetcher` seam:

| Backend | Selected when | Returns | Code |
| --- | --- | --- | --- |
| `firecrawl` | `--backend firecrawl`, or auto if `FIRECRAWL_API_KEY` set | links + page markdown (with `--ingest`) | `src/websearch.ts:128-171`; scrape `174-198` |
| `searxng` | `--backend searxng`, or auto if `SEARXNG_URL` set | links + snippets | `src/websearch.ts:201-232` |
| `ddgs` | `--backend ddgs`, or auto fallback | links + snippets | `src/websearch.ts:241-278` |

Auto-selection order is firecrawl → searxng → ddgs (`src/websearch.ts:92-110`). `ddgs -o json`
writes a file into the cwd, so it runs in a temp dir; otherwise it would litter the repo with a file
`avo commit` reads as a variation (`src/websearch.ts:234-240`). `avo know search --ingest` writes
each result that carries markdown into `K` without a second fetch (`src/knowledge.ts:928-940`,
`951-985`). Every backend returns `{error}` rather than throwing (`src/websearch.ts:293`).

### 1.4 Memory — `avo mem`

The paper's agent has "persistent memory" (`docs/avo-paper.md:39`). avocode makes it external and
agent-agnostic (`src/mem.ts`).

- **Backends** (`src/mem.ts:75-115`): beads (`bd`) if `bd context --json` succeeds; else the file
  store `lineage/memory.jsonl` (`src/mem.ts:12`) with one warning per command.
- **Kinds** (`src/mem.ts:23`): `insight | version | failure | intervention`.
- **One shape** for both backends: `Memory {ts, kind, key, text, version, bead, parent}`
  (`src/mem.ts:30-42`).
- **File store** is append-only on write, last-write-wins per `key` on read
  (`src/mem.ts:134-177`). Corrupt lines are skipped with a warning.
- **Beads mapping** (`src/mem.ts:220-278`):
  - `insight` → `bd remember <text> --key <key>` (injected by `bd prime`).
  - `version` → `bd create … --id <prefix>-v<N> -l avo,avo-version -t task`, then
    `bd dep add <prefix>-v<N> <prefix>-v<parent>`: the lineage chain mirrored as a dependency graph
    (`src/mem.ts:211-214`, `252-261`).
  - `failure` → bead `<prefix>-x<sha8(key)>`, label `avo,avo-insight`, type `chore`.
  - `intervention` → label `avo,avo-intervention`; deliberately not an insight, so it is not primed
    into future sessions (`src/mem.ts:16-22`).
  - Any bd failure degrades to the file store with a warning (`src/mem.ts:239`, `249`).
- **`avo mem prime`** (`src/mem.ts:315-345`): `bd prime` or avo's own digest, grouped as insights,
  "dead ends (do not re-try these)", committed versions. Interventions are omitted.
- **Automatic writes by `avo commit`** (`src/lineage.ts:566-619`): see §2.6.

Memory is "a cache of *why*, never the source of truth" (`src/lineage.ts:566-569`): `remember()`
never throws, and a failed memory write is a warning on a good commit.

---

## 2. The commit rule, precisely

### 2.1 The pipeline in `decideCommit` (`src/lineage.ts:417-485`)

Order of checks. The first that fires decides.

| # | Check | Outcome | Exit | Code |
| --- | --- | --- | --- | --- |
| 1 | cwd is a git repo | refused + error | 2 | `:418-422` |
| 2 | `HEAD` exists | refused + error | 2 | `:423-429` |
| 3 | tree dirty, ignoring `HARNESS_PATHS` | else **noop** (nothing scored, nothing recorded) | 0 | `:430-439` |
| 4 | load `.avo/config.json` | malformed ⇒ defaults + warning | — | `:441` |
| 5 | `runScore` pre-flight (executable scorer) | refused + error | 2 | `:442-445` |
| 6 | read `P_t`, take best | — | — | `:448-451` |
| 7 | attempt has harness errors | refused + errors | 2 | `:453-460` |
| 8 | `attempt.pass` (`ok && correct`) | refused ("failed correctness" or "ok:false") | 1 | `:461-469` |
| 9 | `compareVectors(candidate, best)` | refused with `cmp.reason` | 1 | `:471-479` |
| 10 | `--dry-run` | `would-commit`, nothing written | 0 | `:480-483` |
| 11 | `writeCommit` | `committed` | 0 | `:484`, `:488-563` |

Key properties:

- **Always re-measures.** `avo commit` calls `runScore` itself; there is no way to commit a number
  supplied by the agent (`src/lineage.ts:412-416`; `.agents/skills/avo-vary/SKILL.md:33`).
- **The best is not re-measured.** Its vector comes from the stored `Avo-Score` trailer
  (`src/lineage.ts:472`). The candidate is measured now, on today's machine; the incumbent was
  measured when it was committed.
- **The noop check precedes scoring**, so `avo commit` on an unchanged tree is idempotent and records
  no attempt (invariant 5; test `test/lineage.test.ts:182`, "again … noop").

### 2.2 The comparator (`src/compare.ts`)

**Direction normalization** (`src/compare.ts:20-29`):

```ts
export function scoreVector(s: Scored): Vector {
  const sign = s.higher_is_better ? 1 : -1;
  const keys = Object.keys(s.scores);
  if (keys.length > 0) {
    const v: Vector = {};
    for (const k of keys) v[k] = (s.scores[k] as number) * sign;
    return v;
  }
  return s.primary === null ? {} : { "*": s.primary * sign };
}
```

**Relative delta** (`src/compare.ts:35-41`):

```ts
export function relDelta(candidate: number, best: number): number {
  const d = candidate - best;
  if (d === 0) return 0;
  const scale = Math.abs(best);
  if (scale === 0) return d > 0 ? Infinity : -Infinity;
  return d / scale;
}
```

**Decisions** (`src/compare.ts:43-49`): `first | improved | regressed | tie | missing-configs |
direction-changed`.

**`compareVectors`** (`src/compare.ts:91-233`), in order:

1. `best === null` → commit, `first` (`:107-115`).
2. Both directions known and different → refuse, `direction-changed` (`:117-132`).
3. Any key of `best` absent from `candidate` → refuse, `missing-configs` (`:134-151`). Keys only in
   the candidate are `added`, and ignored by the verdict.
4. Per shared config, verdict with symmetric floor φ (`:153-164`):

   ```ts
   verdict: rel > cfg.floor ? "improved" : rel < -cfg.floor ? "regressed" : "same",
   ```

5. `reduce: "mean"` → weighted mean branch (`:170-205`).
6. `reduce: "dominate"` (default): any `regressed` → refuse (`:207-217`); no `improved` → refuse,
   `tie` (`:218-225`); else commit, `improved` (`:226-232`).

### 2.3 The rule as mathematics

Notation. Let `C_t` be the config set of the best version `x_t`, and `C'` the config set of the
candidate `x'`. Let `σ = +1` if `higher_is_better`, else `−1`. Direction-normalized scores:
`s_c = σ·f_c(x_t)`, `s'_c = σ'·f_c(x')`. Let `φ ≥ 0` be `floor` (default 0). Define

```
            ⎧ 0                         if s'_c = s_c
  ρ_c  =    ⎨ (s'_c − s_c) / |s_c|      if s_c ≠ 0
            ⎩ sign(s'_c − s_c) · ∞      if s_c = 0, s'_c ≠ s_c
```

Let `pass(x') = ok(x') ∧ correct(x')`, and let `E(x')` be "the scorer produced a usable result"
(no harness errors).

**Default rule (`reduce = "dominate"`).** Accept `x'` as `x_{t+1}` iff

```
  Δ(x') ≠ ∅                                   (tree changed outside HARNESS_PATHS)
∧ E(x') ∧ pass(x')                            (correctness gate)
∧ ( P_t = ∅
    ∨ ( σ' = σ
      ∧ C_t ⊆ C'                              (no measuring less)
      ∧ ∀c ∈ C_t : ρ_c ≥ −φ                   (no config regresses beyond the band)
      ∧ ∃c ∈ C_t : ρ_c >  φ ) )               (some config improves beyond the band)
```

With `φ = 0` this reduces to weak Pareto dominance on the shared configs plus strict improvement on
at least one: `∀c ∈ C_t: s'_c ≥ s_c ∧ ∃c ∈ C_t: s'_c > s_c`. Equivalently, `x'` must Pareto-dominate
`x_t` restricted to `C_t`. The docs call this *dominate-or-tie* (`docs/architecture.md:139-142`),
but note that a full tie (no config improves) is **refused** (`src/compare.ts:218-225`; test
`test/compare.test.ts:80`). "Tie" in that name refers to individual configs, not to the whole
vector.

**Opt-in rule (`reduce = "mean"`).** With weights `w_c ≥ 0` (default 1, `src/compare.ts:171`) and
`W = Σ_{c∈C_t} w_c`:

```
  M(s) = (1/W) · Σ_{c∈C_t} w_c · s_c
  accept iff  [same preconditions: Δ≠∅, E, pass, σ'=σ, C_t ⊆ C']
           ∧ W > 0
           ∧ ρ(M(s'), M(s)) > φ
```

`W = 0` is refused with a message, not divided by (`src/compare.ts:173-180`; test
`test/compare.test.ts:158`). Per-config verdicts are still computed and stored, so a regression
accepted by the mean is visible in the record (`test/compare.test.ts:128-136`). The mean ranges over
`C_t` only; added configs carry no weight.

**Configs and noise.** `φ` is a *relative* band, applied symmetrically: noise inside the band can
neither commit nor block (`test/compare.test.ts:112-118`). A regression outside the band still
blocks an improvement inside it (`test/compare.test.ts:120`). There is no repeated measurement,
confidence interval, or re-scoring of the incumbent; `φ` is the only noise mechanism.

### 2.4 Consequences and invariants

- **Monotone lineage.** Under a fixed reduction and floor, every accepted step satisfies
  `s'_c ≥ s_c·(1 − φ·sign(s_c))` on all incumbent configs. With `φ = 0` the per-config sequence is
  non-decreasing, and `avo best = max version number` is correct (`src/lineage.ts:225-228`). With
  `φ > 0`, a chain of within-band losses could drift downward on one config over many versions;
  each step is only compared to the immediate best. With `reduce: "mean"`, only the weighted mean is
  monotone. The code does not re-check this; it relies on construction.
- **Configs can only grow.** `C_t ⊆ C_{t+1}` always holds, since a missing config blocks. Each new
  config enters with no baseline, then becomes binding for all later versions.
- **Direction is frozen per lineage.** A flip is refused with "start a fresh lineage rather than
  reinterpreting the old scores" (`src/compare.ts:127-130`).
- **Zero baselines.** Any move off `s_c = 0` is `±∞`, so no floor can swallow it
  (`test/compare.test.ts:49`).

### 2.5 Edge cases worth stating

- **Strictness at φ = 0:** `10.000001` over `10` commits (`test/compare.test.ts:164-168`). Floating
  noise of a deterministic-looking scorer can therefore commit unless a floor is set.
- **Version numbering** is `best.version + 1` (`src/lineage.ts:497`). If the newest version's
  trailer becomes unreadable, `best` falls back to an older version and the next commit reuses a
  number; `readLineage` then keeps the newest commit with a warning.
- **Mixed directions inside one attempt** (per-config runs with different `higher_is_better`) are
  not detected; the first output's direction applies to all (`src/score.ts:338`).
- **Failing-config sentinel.** A failing attempt has an empty vector (`test/compare.test.ts:35`),
  but `compareVectors` is never reached for it: the pass gate fires first.
- **`--why` accepts any value**, including one starting with `-` (`src/lineage.ts:344-348`; test
  `test/lineage.test.ts:122`).
- **Commit failure rollback.** If `git commit` fails, the just-written `lineage/vNNN.md` is deleted;
  the index keeps what was staged (`src/lineage.ts:530-534`). A refused commit writes nothing: no
  lineage file, empty index (`test/lineage.test.ts:241`).

### 2.6 What happens on refusal

A refusal is a `CommitDecision {action: "refused", reason, comparison, attempt, best, …}`
(`src/lineage.ts:233-244`, `396-410`). It is recorded in three places, none of them git:

1. **Trajectory.** The attempt was already appended to `.avo/attempts.jsonl` by `runScore`
   (unless `--no-record`). The supervisor reads this for stall/thrash (`docs/commands.md:241-248`).
2. **Memory as a dead end** (`src/lineage.ts:602-615`):

   ```ts
   input = {
     kind: "failure",
     // Keyed by content: re-attempting one dead end updates one record.
     key: `avo-dead-end-${shortHash(`${d.reason}${vector}`)}`,
     text: `dead end from ${from}: ${d.reason}`,
     version: d.best?.version ?? null,
     detail,
   };
   ```

   The key is `sha256(reason ‖ vector)[0:8]`, so an identical refusal updates one record.
3. **Output.** The reason names configs and deltas, e.g. `'b' regressed (worst: b -90.00%), and
   'a' improved — a win on one config cannot pay for a loss on another` (`src/compare.ts:207-216`).

Not recorded: no-ops, `--dry-run`, `--no-record`, and refusals caused by harness errors ("a harness
error taught us nothing about the candidate", `src/lineage.ts:576-580`; test
`test/mem.test.ts:415`).

On success, memory gets a `version` record keyed `avo-v<N>` with `parentVersion = best.version`
(`src/lineage.ts:589-601`).

The refused candidate stays in the working tree for the agent to keep iterating on
(`.agents/skills/avo-vary/SKILL.md:44-45`).

### 2.7 Protected files and scorer tampering

There is **no code-level protection** of `.avo/score`, `lineage/`, or any other path. `writeCommit`
stages with `git add -A` (`src/lineage.ts:503`), so an edit to `.avo/score` is staged and committed
with the candidate. The test suite itself edits the scorer between commits
(`test/lineage.test.ts:286-312`). Protection is layered instead:

| Threat | Mechanism | Kind |
| --- | --- | --- |
| Commit a number not measured | `avo commit` always re-scores (`src/lineage.ts:442`) | enforced |
| Wrong but fast candidate | `pass = ok ∧ correct` gate before ranking (`src/lineage.ts:461-469`) | enforced |
| Win on one config pays for loss on another | dominance default (`src/compare.ts:207-217`) | enforced |
| Improve by dropping a slow config | `missing-configs` (`src/compare.ts:140-151`) | enforced |
| Flip the metric direction | `direction-changed` (`src/compare.ts:117-132`) | enforced |
| Noise commits | `floor` (`src/compare.ts:162`) | enforced, opt-in |
| Typo disables the gate | malformed config ⇒ defaults (`src/config.ts:103-132`) | enforced |
| Hand-written version commit | only trailer-bearing commits count; skills forbid it | convention |
| Edit `.avo/score` to pass | AGENTS.md rule (`src/install.ts:175-176`); skills (`avo-vary/SKILL.md:58-60`, `avo-fanout/SKILL.md:140-141`) | convention |
| Edit `lineage/` | AGENTS.md rule; `lineage/vNNN.md` is not read by the comparator | convention + design |
| Gameable correctness check | authoring guidance (`templates/score/README.md:99-102`) | convention |

The structural checks make some tampering visible but not impossible. For example, a scorer edit
that drops a config is caught by `missing-configs`; one that flips direction is caught by
`direction-changed`. A scorer edit that simply inflates numbers is not caught. This is the main
reward-hacking gap and should be stated as such in the article.

---

## 3. Configuration, init/doctor/install, skills distribution

### 3.1 `.avo/config.json` (`src/config.ts:13-57`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `reduce` | `"dominate" \| "mean"` | `"dominate"` | vector → decision reduction |
| `floor` | number ≥ 0 | `0` | symmetric relative noise band |
| `weights` | `{cfg: number ≥ 0}` | `{}` (each 1) | for `reduce: "mean"` |
| `configs` | `string[]` | `null` (probe) | declared config names; skips `--configs` probe |
| `supervise.stall` | int ≥ 1 | `5` | attempts since last improvement before a directive |
| `supervise.thrash` | int ≥ 2 | `3` | consecutive same-signature failures before a directive |
| `agent` | `{name, command, args[], format?}` | `null` | custom headless agent for `fan`/`run`; `{prompt}`/`{model}` substituted |

Loading rules (`src/config.ts:108-172`):

- Missing file → defaults, silently.
- Invalid JSON or any schema violation → **all defaults** plus a warning naming the field. The gate
  can never be disabled by a typo, and the CLI never crashes on one.
- `agent.name` may not shadow `pi|claude|codex`; `agent.args` must mention `{prompt}`
  (`src/config.ts:147-159`).
- Invalid or empty `configs` are dropped with a warning (`src/config.ts:161-170`).
- `defaults()` returns a fresh deep-ish copy to avoid shared mutable state across calls in one
  process (the pi extension runs many) (`src/config.ts:87-94`).

`avo init` writes only `{"reduce":"dominate","floor":0}` (`src/init.ts:79-83`).

### 3.2 `avo init` (`src/init.ts:57-147`)

Steps, each reported as `created/unchanged/skipped/failed`:

1. Refuse outside a git repo, writing nothing (`:63-67`).
2. `.avo/.gitignore` via `ensureTrajectoryIgnored`; `.avo/config.json` if absent (`:70-88`).
3. `.avo/score` from `--scorer <t>` (never `--force`), else report present/absent (`:90-105`).
4. `runKnowInit`: `knowledge/`, `lineage/`, qmd index and collections (`:107-111`).
5. beads last: `bd init --non-interactive --init-if-missing --skip-agents --skip-hooks -q
   [--prefix p]` (`:129`). `--skip-agents` leaves `AGENTS.md` to `avo install`; `--skip-hooks`
   keeps a git hook from dirtying the tree during `avo commit`. Side effect: `bd init` makes its own
   git commit of `.beads` config (`src/init.ts:53-56`).

### 3.3 `avo doctor` (`src/doctor.ts`)

Three dependency kinds (`src/doctor.ts:4-9`, `51-63`):

- **required:** `git`, `jq`.
- **agent (≥ 1 required):** `pi`, `claude`, `codex` — "the variation operator".
- **optional:** `qmd`, `ddgs`, `bd`, `hyperfine`, `just`, `shellcheck`; each has a named fallback.

API keys are reported as present/unset only, never values (invariant 6;
`src/doctor.ts:35-40`, `65-74`): `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `FIRECRAWL_API_KEY`,
`SEARXNG_URL`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `OPENROUTER_API_KEY`, `ARC_API_KEY`.
Exit 1 iff a required dependency is missing or no agent is present (`src/doctor.ts:84-116`, `175`).

### 3.4 `avo install` and skills distribution (`src/install.ts`, `src/skills.ts`)

**Source of truth.** Skills live in avocode's own checkout at `.agents/skills/<name>/SKILL.md`
(`src/skills.ts:11-25`), the Agent Skills standard's shared location. Install *links*, never copies:
"a copy is a fork that stops receiving fixes, and two copies of the commit rule is what invariant 1
forbids" (`src/install.ts:339-346`).

**Validation before install** (`src/skills.ts:90-122`). A skill is rejected (install fails, exit 2)
unless: frontmatter parses (minimal YAML subset, no dependency, `src/skills.ts:43-77`); `name`
matches `^[a-z0-9]+(?:-[a-z0-9]+)*$`, ≤ 64 chars, and equals the directory name; `description` is
non-empty and ≤ 1024 chars; body non-empty. Rationale: Pi is lenient, Claude Code is strict, and a
skill must load everywhere (`src/install.ts:277-284`).

**Per-target wiring** (`src/install.ts:255-329`):

| Step | What | Code |
| --- | --- | --- |
| skills | per-skill symlinks `.agents/skills/<name>` → avocode's skill dirs; skipped when the target *is* avocode | `:286-299` |
| `AGENTS.md` | always; a managed block between `<!-- BEGIN avo … -->` and `<!-- END avo -->` with the rules and a skills index; content outside the markers preserved; unmarked file gets the block appended | `:29-30`, `165-219`, `301-320` |
| pi | discovers `.agents/skills` natively; links `.pi/extensions/avo` and `.pi/extensions/avo-supervisor`; merges `.pi/settings.json` (`defaultTools` incl. `bash`, `enableSkillCommands: true`); warns that headless pi ignores project skills until the project is trusted | `:369-403` |
| claude | one symlink `.claude/skills` → `.agents/skills`; if `.claude/skills` is a real dir, links each skill inside it | `:405-420` |
| codex | nothing to link; "discovers skills through the AGENTS.md index" | `:325` |

Link mechanics: `linkState` compares resolved targets, so an equivalent absolute link counts as a
match (`src/install.ts:95-113`). `ensureLink` never replaces a real directory, and replaces a file or
foreign symlink only with `--force` (`:116-134`). Links are relative inside one repo and absolute
when they reach out of it, so they survive clones and `avo fan` worktrees (`:143-146`).

Removal (#18): `ownedLink` reads a link's raw target, so a dangling link into avocode's checkout
is still known as avo's. `avo install` removes such dangling skill links. `avo install
--uninstall` (`runUninstall`) removes avo's links and the marked `AGENTS.md` block (`removeBlock`).
It deletes `.pi/settings.json` only when the file holds nothing but avo's keys with avo's values
(`unmergePiSettings`); otherwise the keys stay, because avo cannot prove it wrote them. In a repo
with a real copy of avo's skills (avocode itself), it removes nothing. It also drops the entries of
removed links from the exclude block, and the block itself when no entry is left (`unexcludeLinks`).

**Absolute links stay out of the lineage (#32).** An absolute link names a path on this machine.
`avo install` lists each one in a managed block in the repo's local ignore file, which
`git rev-parse --git-path info/exclude` finds (`excludeLocalLinks`). The entries are anchored at the
repo root, and all worktrees share the file. Thus `git add -A` in `avo commit` does not stage the
links, and a clone has none. `avo fan` copies the listed links into each probe worktree
(`mirrorLinks`).

**The five skills** (`.agents/skills/`): `avo-vary` (one variation step: prime → best → know query →
one change → score → commit), `avo-score` (the `f` contract and authoring rules), `avo-lineage`
(reading `P_t` and the commit rule), `avo-knowledge` (`K`), `avo-fanout` (`avo fan`). They are
"the product" (invariant 9): the CLI does the enforcement, the skills teach the agent the loop.

Note: `avo-lineage/SKILL.md:70` shows an illustrative refusal string
(`refused: b8_s1024 regressed 4.2% … dominate requires no config to regress`) that does not match the
actual format produced by `src/compare.ts:213-215`.

---

## 4. CLI surface

From `src/cli.ts:15-118` and each parser. Every command accepts `--json` (invariant 3) and most
accept `--cwd <dir>`.

| Command | Purpose | Key flags | Exit codes |
| --- | --- | --- | --- |
| `avo init` | scaffold `.avo/`, `knowledge/`, `lineage/`, qmd, beads | `--scorer <t>`, `--prefix <p>` | 0 ok, 2 error |
| `avo install` | wire skills + `AGENTS.md` for agents | `--agent pi\|claude\|codex\|all` (repeatable, comma list), `--force`, `--uninstall` | 0, 2 |
| `avo doctor` | dependency + key presence report | `--json` only | 0 ok, 1 missing required/agent, 2 usage |
| `avo score` | run `f`, validate, record attempt | `--parallel`, `--timeout <s>` (0 = none), `--init <t>`, `--force`, `--no-record` | 0 pass, 1 fail, 2 harness |
| `avo commit` | score, compare, persist iff better | `--why <text>`, `--dry-run`, `--parallel`, `--timeout <s>`, `--no-record` | 0 committed/noop/would-commit, 1 refused, 2 harness |
| `avo lineage` | list `P_t`; `show <n>`; `diff <a> <b>` | — | 0, 2 |
| `avo best` | the incumbent | — | 0, 1 none, 2 |
| `avo mem` | list; `add "<insight>"`; `prime` | `--key <k>` (add only) | 0, 2 |
| `avo know` | `init`, `query "<q>"`, `add <url\|path>`, `search "<q>"`, `reindex` | `--lexical`, `-n N` (default 5), `-c <coll>`, `--min-score s`, `--name`, `--force`, `--no-embed`, `--ingest`, `--backend firecrawl\|searxng\|ddgs`, `--timeout <s>` | 0, 1 refused, 2 |
| `avo fan` | N worktrees × N headless probes, scored | `--n k` (3), `--prompt`/`--prompt-file`, `--agent`, `--model` (`$AVO_PROBE_MODEL`), `--timeout` (900), `--keep`, `--no-score`, `--promote i [--run id]`, `--resume id`, `--list`, `--clean id\|all` | 0, 1 guard/all failed, 2 |
| `avo run` | continuous loop: turn → commit → supervise → steer | `--prompt`/`--prompt-file`, `--max-iters` (10), `--agent`, `--model`, `--timeout` (900), `--stall`, `--thrash`, `--dry-run` | 0, 1, 2 |
| `avo supervise` | stall/thrash detection, citing directive | `--stall n`, `--thrash k` | 0 none, 1 directive, 2 |
| `avo version` / `help` | — | `-v`, `--version`, `-h`, `--help` | 0 |

Environment variables of note: `AVO_FAN_DEPTH` (3), `AVO_FAN_LEVEL`, `AVO_FAN_CHAIN`,
`AVO_FAN_RUN`, `AVO_FAN_PROBE`, `AVO_PROBE_MODEL`, `AVO_AGENT` (`src/fan.ts:31-39`);
`FIRECRAWL_API_KEY`, `SEARXNG_URL` (`src/websearch.ts:17-18`). File-based control: `.avo/STOP`
stops `avo run` (`src/run.ts:50`).

---

## 5. Design decisions, invariants, failure modes

### 5.1 The nine invariants (`docs/architecture.md:170-184`)

1. `avo commit` is the only writer of committed lineage.
2. A failing `f` never yields a commit.
3. Every subcommand supports `--json`.
4. Degrade, never crash (named fallback + one warning).
5. Idempotent by construction (`init`, `install`, `commit`).
6. Never leak secrets (presence only).
7. Worktrees are disposable; `main` is not.
8. CLI-first: any capability reachable from `bash` before any binding.
9. The skills are the product.

How the code enforces 1: a version is *defined* as a trailer-bearing commit (`readLineage`), and
`avo run` commits through the same `decideCommit` the CLI calls, "so the rule cannot differ"
(`src/run.ts:641-658`). A plain `git commit` without trailers moves `HEAD` but is not a version
(`docs/commands.md:313`). Nothing stops a human from forging the trailers by hand; invariant 1 is
about avo's own code paths.

### 5.2 Failure modes guarded against

- **Reward hacking / gaming `f`:** see the table in §2.7. Enforced: re-measure, correctness gate,
  dominance, no measuring less, no direction flip. Not enforced: scorer edits that inflate numbers.
- **Silent regressions:** dominance is the default precisely because "a mean lets a large win on
  one config pay for a regression on another" (`src/config.ts:15-20`).
- **Noise:** symmetric relative `floor`. No repeated sampling or incumbent re-measurement.
- **Self-perturbation:** avo's own writes (attempt log, gitignore, memory log, qmd index, ddgs
  output) must not look like a candidate change. Handled by `HARNESS_PATHS`
  (`src/lineage.ts:31-40`), `.qmd/.gitignore` with `*` (`src/knowledge.ts:322-333`), and ddgs in a
  temp dir (`src/websearch.ts:234-240`). The memory-induced loop is pinned by
  `test/mem.test.ts:382`.
- **Runaway scorers:** process-group `SIGKILL` on timeout, 200 KB head+tail output cap.
- **Misconfiguration:** malformed config ⇒ full defaults; scorer typos diagnosed per field.
- **Recursive agents:** `avo fan` and `avo run` share depth and cycle guards in the environment
  (`src/fan.ts:282-317`), because a probe is itself an agent that can call `avo fan`.
- **Lost work in long runs:** run and fan manifests are rewritten after every iteration/probe
  (`docs/commands.md:344-347`).
- **Silent idle loops:** `avo run` stops after 3 consecutive no-op iterations with `HEAD` unmoved,
  because an unchanged tree records no attempt and the supervisor cannot see it
  (`src/run.ts:53-56`, `687-697`).

### 5.3 Engineering trade-offs

- **Git as the database.** `P_t` needs no extra store, survives clones, and is diffable
  (`avo lineage diff` = score comparison + `git diff`, `src/lineage.ts:760-779`). Cost: the lineage
  is per-branch, and rebases can duplicate trailers (handled with "newest wins").
- **Three records per version** (trailers minimal, notes full, markdown readable). Trailers hold
  only what the comparator needs, so a corrupt note or deleted markdown cannot change a decision.
- **Highest number = best.** Avoids a ranking pass; correct only because of monotone admission.
- **Strict improvement required.** Equal-scoring rewrites are refused: "the lineage records
  progress, not equal-scoring rewrites" (`src/compare.ts:223`). The paper accepts "matches or
  improves" (§6).
- **`null` failure sentinel instead of 0.** Direction-safe.
- **Optional dependencies everywhere.** qmd, bd, firecrawl are all optional with same-shape
  fallbacks. Cost: the fallback search is term coverage, not BM25.
- **No build step, injectable seams.** `tsx` runs source directly; the pi extension imports the
  same `src/` files, so scoring and lineage logic exist once (`docs/architecture.md:60-62`).
- **Links, not copies, for skills and the pi extension.** Upgrades propagate; a broken avocode
  checkout breaks all installed repos.
- **Prompts as policy for scorer integrity.** Simpler than hashing/locking `.avo/score`, but leaves
  the reward-hacking gap of §2.7.

### 5.4 Known gaps (from reading the code)

- No enforcement against editing `.avo/score` or protected paths.
- Incumbent score is never re-measured; machine drift goes unnoticed.
- Mixed `higher_is_better` across per-config runs is not detected (`src/score.ts:338`).
- With `φ > 0`, small within-band losses can accumulate across versions.
- `avo commit` does not reindex qmd; `lineage/vNNN.md` is invisible to qmd until
  `avo know reindex` (the file fallback sees it at once).

---

## 6. Differences from the paper's AVO (`docs/avo-paper.md`)

| Aspect | Paper | avocode |
| --- | --- | --- |
| Domain | CUDA attention kernels on B200 (`:31`) | domain-agnostic; any repo with `.avo/score` |
| `f` output | vector `(f_1,…,f_n)`, one per test config (`:31`) | JSON with optional `scores` vector plus scalar `primary`; `ok`, `correct`, `unit`, direction |
| Failed correctness | score 0 (`:31`) | `primary = null` sentinel and outright refusal before ranking |
| Acceptance | "passes correctness checks and **matches or improves**" the best (`:43`) | passes correctness **and strictly improves** on ≥ 1 config with no regression (dominance); exact ties refused |
| Vector reduction | not specified | Pareto dominance by default; weighted mean opt-in; relative noise floor |
| Anti-gaming | not discussed | missing-config block, direction-flip block, always re-score |
| `P_t` storage | "persisted as a git commit along with its score" (`:47`) | commit + `Avo-Version`/`Avo-Score` trailers + `git notes --ref=avo` + `lineage/vNNN.md` |
| Failed attempts | "remain part of the agent's internal search trajectory" (`:43`) | persisted outside the lineage: `.avo/attempts.jsonl` and dead-end memory records, readable by later sessions |
| `K` | CUDA guides, PTX ISA, FA4 source (`:31`) | `knowledge/` with provenance + the repo's own `lineage/`, hybrid-searched by qmd; web ingest |
| Agent | one general-purpose agent with persistent memory, continuous for 7 days (`:39`, `:51`) | any of pi / Claude Code / Codex via skills; `avo run` spawns a **fresh process per turn**, continuity via prompt, lineage and `avo mem` |
| Supervisor | self-supervision that "reviews the overall evolutionary trajectory and steers" (`:49`) | deterministic `stall` (N attempts since last version) and `thrash` (K same-signature failures) detectors; the directive cites prior versions, dead ends, and unread docs in `K`; interventions recorded as labelled memory |
| Population | single lineage; branching left to future work (`:47`) | still a single lineage, but `avo fan` adds N parallel worktree probes on a small model, one promoted by hand, then committed through the same rule |
| Noise | not discussed | `floor`, symmetric relative band |
| Scale evidence | 40 versions over 7 days | not in scope of the core; see `docs/bench.md` |

Points to stress in the article:

1. The acceptance rule is **stricter** than the paper's (`>` on some config, not `≥`), and it is
   **specified** where the paper is not (dominance over the vector).
2. The paper's lost trajectory is **kept** in avocode as a first-class, searchable record of dead
   ends; the paper's lineage-as-context idea is extended so the lineage is itself part of `K`.
3. Memory moves from the agent to the harness, which is what makes the operator agent-agnostic and
   restartable.
4. Integrity of `f` rests on convention, not enforcement; this is the main open threat.
