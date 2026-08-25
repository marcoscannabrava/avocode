# PLAN.md — `avocode`: an AVO-inspired agent harness

> Read this first every Ralph cycle. `PROGRESS.jsonl`'s last `next` is the default task.
> Slices are ordered; each is independently shippable and verifiable. Don't skip ahead.

---

## 1. What we are building

The [AVO paper](avo-paper.md) replaces classical evolutionary variation operators with an
autonomous coding agent: `Vary(P_t) = Agent(P_t, K, f)`. Its result (SOTA attention kernels on
B200) is domain-specific; its **harness** is not. `avocode` extracts that harness and makes it
general and agent-agnostic.

Four contracts, one loop:

| Symbol | Meaning | Our implementation |
| --- | --- | --- |
| `f` | scoring function (correctness + a metric) | a repo-local executable `.avo/score` emitting one JSON line |
| `P_t` | lineage of committed solutions + scores | git commits w/ score trailers + `git notes` + `lineage/*.md` + beads graph |
| `K` | domain knowledge base | `knowledge/` indexed by **qmd** (hybrid BM25 + vector + local rerank) |
| Agent | the variation operator itself | any coding agent, driven by our skills + `avo` CLI |
| Supervisor | stagnation detection + steering | `avo supervise` (agnostic) / Pi extension (native) |

**Non-goal:** CUDA kernels. The demo target (Slice 9) is a scorer-driven optimization task, but
`f` is pluggable — bench time, eval pass-rate, bundle size, token cost, whatever emits JSON.

**Non-goal:** re-implementing an evolutionary framework. AVO's thesis is that the rigid
`Generate(Sample(P_t))` pipeline is the thing to delete. OpenEvolve (7.2k★) and ShinkaEvolve
(1.4k★) both implement exactly that pipeline; adopting either would reintroduce what AVO removes.
Their **archive/MAP-Elites** code is worth revisiting only if we ever do Slice 10 (population
branching), which the paper itself leaves as future work.

---

## 2. Composition decisions (researched 2026-08-22)

Rule applied: prefer existing software; highest-star credible option wins; reject a popular tool
only with a stated reason.

| Need | Chosen | ★ | Runner-up (why not) |
| --- | --- | --- | --- |
| Knowledge base `K` | **qmd** (`@tobilu/qmd`, v2.8.3) | 29.1k | Firecrawl-only RAG (no local index, no rerank); LlamaIndex (framework, not a CLI) |
| Memory / task graph | **beads** (`bd`, `@beads/bd` v1.2.2, Dolt-backed) | 26.5k | plain markdown TODOs (what beads exists to replace); SQLite by hand |
| Agent harness (reference impl) | **Pi** (`@earendil-works/pi-coding-agent` v0.84.2) | 95.6k | Claude Code (not extensible in-process); opencode |
| Online search + fetch | **Firecrawl** `/v2/search` w/ `scrapeOptions.formats:[markdown]` | 171k (MCP 7.3k) | Exa MCP (4.9k, search only); Tavily (2.3k); needs key |
| Keyless search fallback | **mcp-searxng** (1.2k) or `ddgs` (PyPI v9.15) | — | — |
| Skill format | **Agent Skills open standard** (agentskills.io, Linux Foundation AAF) | 40+ tools | proprietary `.claude/skills` only |
| Wall-clock scoring | **hyperfine** | 28.7k | hand-rolled timing loops |
| Task running | **just** | 35.4k | make (fine too, but `just` is what agents read best) |
| Structured output | **jq** | 35.5k | — |
| Parallel fan-out | **thin `avo fan` over `git worktree` + headless agent procs** | — | see below |

### Why fan-out is ours (~150 LOC) and not adopted

Every high-star candidate is the wrong *shape* for an autonomous loop:

- **vibe-kanban** (27.9k) — human-in-the-loop kanban UI.
- **claude-squad** (8.4k) — tmux TUI session manager.
- **uzi** (582) — right CLI shape (`--agents claude:2,codex:1`, worktree per agent) but **requires
  tmux, has no headless mode and no structured result collection**. Verified from its docs.
- **bernstein** (960) — closest functionally (worktrees, per-step agent/model, JSON, CI) but its
  headline is *"No LLM in the coordination loop."* That is the inverse of AVO. Solo-maintained beta.

Validated prior art we copy the *pattern* from, not the code: `mjakl/pi-subagent` (76★) spawns
**child `pi` processes in headless mode** — OS-level isolation, no shared state, depth + cycle
guards. `avo fan` does the same with a configurable command template, so it drives `pi`,
`claude -p`, `codex exec`, or anything else. (`pi-subagents`/`pi-crew` explicitly ruled out by
[avo-pi.md](avo-pi.md); we take inspiration only.)

### Deliberately rejected

- **MCP as the primary transport.** Pi has **no built-in MCP** (it gives the model four tools by
  default — `read`, `write`, `edit`, `bash`; `ls`/`grep`/`find` also ship built-in, and MCP is
  listed only as something an *extension* could add). CLI-first is strictly more agent-agnostic:
  `qmd`, `bd`, and `avo` work through `bash` in every agent that exists. qmd's own MCP server
  stays available as an opt-in nicety.
- **absurd** (2.4k, same org as Pi) — Postgres-backed durable execution. Real fit for multi-day
  crash recovery, but Postgres is too much for MVP. Revisit if the loop proves fragile (Slice 7 note).

---

## 3. Architecture

```
avocode/
  bin/avo                  # single entrypoint, dispatches subcommands
  src/
    cli.ts                 # dispatcher
    score.ts               # f  — run + validate .avo/score
    config.ts              # .avo/config.json — the reduction, the floor, declared configs
    compare.ts             # the commit rule's comparator over the score vector
    lineage.ts             # Pt — git trailers, notes, lineage/*.md, beads mirror
    mem.ts                 # memory — bd (beads) with a lineage/memory.jsonl fallback
    init.ts                # avo init — idempotent scaffolding, including bd init
    knowledge.ts           # K  — qmd wrapper, local-scan fallback, ingest with provenance
    websearch.ts           # K  — the three web-search backends behind one Fetcher seam
    steps.ts               # the created/unchanged/skipped step report shared by init and know init
    skills.ts              # the Agent Skills frontmatter parser + spec validator
    install.ts             # avo install — wires pi | claude | codex to .agents/skills, no copying
    fan.ts                 # concurrency — worktrees, probes, guards, promote, resume
    supervise.ts           # stagnation detection + steering directive
    run.ts                 # avo run — the continuous loop, its manifest, the intervention record
    agents.ts              # agent command templates + driveAgent (one turn, as fan and run see it)
  .agents/skills/          # THE agent-agnostic layer (Agent Skills standard)
    avo-vary/SKILL.md      #   how to perform one variation step
    avo-lineage/SKILL.md   #   how to read/extend Pt
    avo-knowledge/SKILL.md #   how to search K and grow it from the web
    avo-score/SKILL.md     #   the f contract, how to author a scorer
    avo-fanout/SKILL.md    #   when and how to parallelize with small models
  AGENTS.md                # always-on rules + the skills index; only the marked block is managed
  pi/extensions/
    avo/index.ts           # the entry point Pi discovers; registers what tools.ts defines
    avo/tools.ts           # native Pi tools (thin wrappers over src/); typebox schemas
    avo-supervisor/        # steers from inside the session: index.ts + supervisor.ts
                           #   (tool_result -> supervise() -> pi.sendMessage), episode-scoped
  templates/score/         # reference scorers: hyperfine, pytest, vitest, evals
  bench/
    init.sh                # materializes a target into ITS OWN repo; --verify audits f afterwards
    fuzzysearch/           # the S9 target: edit-distance retrieval, median ms, lower is better
                           #   src/search.js is the candidate; bench/ + test/ + avo/score are f
  test/fixtures/fuzzysearch/  # the six-step ladder — the headroom proof, deliberately NOT in bench/
  knowledge/               # K corpus (markdown; qmd collection)
  lineage/                 # rendered vNNN.md per committed version (qmd collection)
  justfile                 # lint / typecheck / test / e2e
```

**Stack:** TypeScript on Node 22 (already installed), `tsx` for execution, `node:test` for tests,
`typebox` for tool schemas (what Pi uses). One package. Rationale: the Pi extension and the CLI
share `src/` verbatim — write the lineage/score logic once.

### The `f` contract (frozen in Slice 1, never break it)

Full authoring guide: [templates/score/README.md](templates/score/README.md).

`.avo/score` is any executable, run from the repo root. It **always exits 0**; failures are
reported *in* the JSON so the agent receives a diagnosable payload instead of a crash. stdout,
one line:

```json
{"ok":true,"correct":true,"primary":1668.2,"unit":"TFLOPS","higher_is_better":true,
 "scores":{"b1_s4096":1668.2,"b8_s1024":1421.7},"log":"...","duration_s":42.1}
```

Required: `ok` (the scorer itself worked), `correct` (**the gate**), `primary` (`number|null`),
`unit` (non-empty), `higher_is_better`. Optional: `scores`, `log`, `duration_s`. Unknown fields are
allowed but warned about, so a misspelled `higherIsBetter` reads as both "required field missing"
and "unknown field".

Two optional invocations enable `avo score --parallel`: `--configs` lists config names (one per
line, `[A-Za-z0-9][A-Za-z0-9._-]*`), `--config <name>` scores one of them. Anything else printed by
`--configs` means "unsupported" and degrades to a single serial run with one warning.

`ok:false` or `correct:false` ⇒ `primary` is forced to the failing sentinel, which is **`null`**,
regardless of the measured value (paper §3.1: "a candidate that fails correctness is assigned zero
score"). `null` rather than literal zero because zero is the *best* possible value for a
lower-is-better metric, so it cannot also mean failure. `avo score` additionally emits
`normalized` — `primary` flipped so higher is always better, `null` compares worse than any number
— so no consumer branches on direction.

`avo score` exit codes: `0` pass, `1` ran but failed, `2` harness error (no scorer, malformed
output, timeout). Every run appends one normalized attempt to `.avo/attempts.jsonl`; attempts are
not commits.

### The commit rule (paper §3.2)

Persist a new version **only** when it passes correctness **and** beats the best committed version
under the configured reduction (§6 Q1: no config regresses, at least one improves). Failed attempts
stay in the agent's trajectory and in beads (as insight beads), never in the committed lineage.
`avo commit` enforces this — it is the only writer.

A committed version is a commit carrying `Avo-Version: N` and `Avo-Score: <compact json>` trailers,
with the full attempt in `git notes --ref=avo` and a rendered `lineage/vNNN.md`. `avo commit` stages
everything (`git add -A`) *except* the trajectory paths `.avo/attempts.jsonl` and `.avo/worktrees/`,
which it also writes into `.avo/.gitignore`: committing the attempt log would put the record of how
a version was reached inside the version itself, and would leave the tree permanently dirty — which
would in turn defeat the no-op check that makes `avo commit` idempotent.

A wider set — `HARNESS_PATHS` = the trajectory plus `.avo/.gitignore` and `lineage/memory.jsonl` —
is excluded from the *dirtiness* check but still staged. Those files belong in the repository; they
are simply not evidence of a variation, and counting them would make avo's own writes look like a
candidate the agent never produced (S3).

The lineage is therefore monotone by construction, so **`avo best` is simply the
highest-numbered version**; there is no separate ranking pass.

### Where small models and concurrency are mandatory, not optional

1. `avo fan` probes — N candidate directions explored in parallel worktrees on a **small model**
   (`AVO_PROBE_MODEL`, e.g. Cerebras/Groq/Haiku). Only the winning direction gets the big model.
   Pi natively supports Groq, Cerebras, DeepSeek, OpenRouter, ZAI, llama.cpp — no adapter needed.
2. qmd's reranker is a **local GGUF small model**. Free semantic search over `K` and over our own
   lineage.
3. `avo score --parallel` fans configs out concurrently.
4. `avo lineage summarize` — small model compacts old versions (mirrors beads' "memory decay").
5. Triage/verification of a failed attempt → small model, parallel, before the big model re-plans.

### The synergy worth protecting

`lineage/` is a **qmd collection**. The agent can semantically search its own history
("what did I already try about register pressure?") with the same tool it uses for docs. That is
exactly the behavior the paper observes in §3.2 — the agent examining multiple prior
implementations within one variation step — and it costs us nothing extra.

---

## 4. Slices

Each slice: build → verify with the stated command → commit → update `PROGRESS.jsonl`.

### S0 — Skeleton + health check `[x]`
- `package.json`, `tsconfig.json`, `bin/avo` → `src/cli.ts` via `tsx`.
- `justfile`: `lint` (tsc --noEmit + eslint or oxlint), `typecheck`, `test` (node:test), `e2e`.
- `avo --version`, `avo doctor` (reports presence/version of `git`, `qmd`, `bd`, `hyperfine`, `jq`,
  chosen agent CLI, and which API keys are set — never prints key values).
- GitHub Actions running `just lint typecheck test`.
- **Verify:** `just lint typecheck test` green on a clean clone; `avo doctor` exits non-zero with a
  readable list when a dep is missing.
- **Shipped (iter 1):** lint = `oxlint` (+ `shellcheck`, skipped when absent); tests = `node:test`
  via `tsx --test`. `just check` = lint+typecheck+test is the Ralph health check; `just e2e` runs
  `test/e2e.sh` against the real `bin/avo` and writes `evidence/s0-e2e.txt`.
  `avo doctor` classifies deps `required` (git, jq) / `agent` (pi|claude|codex, **at least one**) /
  `optional` (qmd, bd, hyperfine, just), and exits 1 only on a `required` or agent-group failure —
  optional gaps are reported without failing. Dep probing is injected (`Prober`), so the
  missing-dependency paths are unit-tested without touching the filesystem.

### S1 — `f`: scoring `[x]`
- `avo score [--parallel] [--json]` — runs `.avo/score`, validates against the typebox schema,
  normalizes, records the attempt (not a commit).
- Schema violation ⇒ actionable error naming the offending field.
- `templates/score/`: `hyperfine.sh` (wall-clock), `pytest.sh` + `vitest.sh` (pass-rate),
  `README.md` on authoring one. `avo score --init <template>` scaffolds `.avo/score`.
- **Verify:** unit tests for the validator incl. malformed/`correct:false`/non-zero-exit cases; a
  fixture repo where `avo score --json | jq -e '.correct == false'` passes.
- **Shipped (iter 2):** `src/score.ts` — typebox schema + semantic checks (`primary` must be finite
  when passing; every `scores` value finite), normalization into an `Attempt` appended to
  `.avo/attempts.jsonl`, `--parallel` fan-out over `--configs` at `min(8, cpus-2)`, `--timeout <s>`,
  `--init <template>`, `--no-record`, `--cwd <dir>`. Also `--json` everywhere and a pretty renderer.
  `main()` is now `async` (every later slice needs it). Contract details moved into §3 above and
  [templates/score/README.md](templates/score/README.md).
  Two things worth remembering: stdout parsing takes the *last* JSON-object line and warns about the
  rest, because scorers that echo build noise are too common to reject; and the scorer is spawned
  `detached` so a `--timeout` kills its whole process group — killing only the scorer leaves its
  benchmark children holding our stdio pipes and we wait out the full run anyway (caught by e2e,
  regression-tested in `test/score.test.ts`).

### S2 — `P_t`: lineage `[x]`
- `avo commit` — atomic: score → compare vs best → on pass, `git commit` with trailers
  `Avo-Version: N` / `Avo-Score: <compact json>`, write `git notes --ref=avo`, render
  `lineage/vNNN.md` (score table, diffstat, agent's rationale from `--why`), print the decision.
  On fail: refuse, explain, exit non-zero.
- `avo lineage [--json]`, `avo lineage show <n>`, `avo lineage diff <a> <b>`, `avo best`.
- Idempotent: re-running `avo commit` with no working-tree change is a no-op, not a duplicate.
- **Verify:** integration test on a throwaway git repo — commit v1, attempt a regression (must be
  refused), commit an improvement (v2), `avo lineage --json | jq 'length == 2'`.
- **Shipped (iter 3):** `src/config.ts` (`.avo/config.json`: `reduce`, `floor`, `weights`,
  `configs`; malformed ⇒ defaults + a warning naming the field, never a disabled gate),
  `src/compare.ts` (the Q1 comparator, pure and unit-tested at every branch), `src/lineage.ts`
  (`avo commit`, `avo lineage [show|diff]`, `avo best`). `avo commit` gained `--why`, `--dry-run`
  (action `would-commit`, writes nothing) and the `avo score` flags; exit codes 0 committed/no-op,
  1 refused, 2 harness error. `runScore` was extracted from `scoreCommand` so commit and score share
  one scoring path — you cannot commit a score you did not measure.
  Three things worth remembering: **trajectory must not enter the lineage** — committing
  `.avo/attempts.jsonl` left the tree permanently dirty and turned every no-op into a real commit,
  so the trajectory paths are gitignored *and* explicitly unstaged after `git add -A`; a refused or
  failed commit **rolls back the rendered `lineage/vNNN.md`**, so a refusal leaves nothing behind;
  and the direction check (`higher_is_better` flipping between versions) is refused outright rather
  than compared as if it had not, which the vector comparison alone would silently get backwards.
  Also closed #4 (declared `configs` skip the `--configs` probe) and fixed CI, which was running
  only `test/e2e.sh` and so had never executed the S1 or S2 e2e suites.

### S3 — beads memory `[x]`
- `bd init` on `avo init`. `avo mem add "<insight>"` → `bd remember`; `avo mem` → the memories,
  `avo mem prime` → `bd prime`.
- Each committed version gets a bead linked to its parent (`bd dep add`); each *failed* attempt
  gets an insight bead so the agent stops re-trying dead ends across sessions.
- Graceful degradation: if `bd` is absent, fall back to `lineage/memory.jsonl` and warn once.
- **Verify:** `avo mem add` then `avo mem | grep` the insight; lineage beads show correct parent
  chain via `bd show`; the no-`bd` fallback path has a test.
- **Shipped (iter 4):** `src/mem.ts` (the memory layer) and `src/init.ts` (`avo init`). One `bd
  context --json` call answers both "is bd installed" and "does this repo have a database", which is
  what makes *installed-but-uninitialized* degrade instead of fail. Both backends return the same
  `Memory` shape, so `avo mem --json` does not change with the environment — an agent must not have
  to know whether `bd` was installed. Ids are deterministic (`<prefix>-v<N>` for a version,
  `<prefix>-x<hash8>` for a dead end keyed by content), so re-recording updates one record instead
  of piling up. `avo commit` mirrors its own decision: a commit writes a version bead linked to its
  parent, a refusal writes a dead end; `--dry-run`/`--no-record`/a no-op/a harness error write
  nothing, because there is no candidate to learn from.
  Deviation from the sketch above, recorded because code wins: `avo mem` lists the memories rather
  than shelling out to `bd prime`, whose bulk is the bd command reference; `bd prime` is
  `avo mem prime`. The list is the parseable, stable thing an agent wants mid-loop.
  The bug this slice caught is worth remembering: **avo's own writes must not read as a variation.**
  `lineage/memory.jsonl` is written *after* a commit, so with only `TRAJECTORY_PATHS` filtered, the
  next `avo commit` saw a change the agent never made — it scored an unchanged tree, refused it as
  no improvement, and remembered *that* refusal, which dirtied the tree again. `HARNESS_PATHS`
  (trajectory + `.avo/.gitignore` + the memory log) now covers the dirtiness check, while staying
  *staged*: those files belong in the repo, they are just not evidence of a variation.

### S4 — `K`: knowledge `[x]`
- `avo know init` — `qmd collection add knowledge/ --name knowledge`, same for `lineage/`, plus
  `qmd context add` descriptions (qmd's README calls contexts its key feature — use them).
- `avo know query "<q>" [--json]` → `qmd query` (hybrid + rerank).
- `avo know add <url|path>` — Firecrawl `POST /v2/search` or scrape → markdown → `knowledge/<slug>.md`
  with provenance frontmatter (url, fetched-at) → `qmd embed`.
- `avo know search "<q>"` — web search only, results as JSON; `--ingest` to pipe straight into `K`.
- Backends behind one flag: `firecrawl` (default, `FIRECRAWL_API_KEY`) | `searxng` | `ddgs`.
  No key configured ⇒ clear message naming the alternatives, not a stack trace.
- **Verify:** ingest a fixed doc, `avo know query` returns it above a score threshold; search
  backend selection unit-tested with a stubbed HTTP layer (no network in CI).
- **Shipped (iter 5):** `src/knowledge.ts` (K: the qmd wrapper, the fallback, `know init|query|add|
  reindex`) and `src/websearch.ts` (the three backends behind one injected `Fetcher`, so every one
  of them is tested with no network). `avo know init` folds into `avo init` the way `bd init` did.
  qmd is optional, so — as with `bd` in S3 — its absence is the *common* path: `localSearch` answers
  the same query over the same files, and both backends return the identical `Hit` shape, so an
  agent never branches on whether qmd was installed. `score` means the same thing in both: 0..1,
  higher is better (qmd's own relevance; term coverage in the fallback).
  Three deviations from the sketch above, recorded because code wins:
  1. **`avo know reindex` exists** (and `avo know add` runs `qmd update` before `qmd embed`).
     `qmd embed` only vectorizes documents the index already knows about, so a doc written *after*
     `qmd collection add` stays invisible — `qmd ls` reports "No files found" and every search
     returns nothing — until `qmd update` re-scans. `avo commit` writes into `lineage/` without
     going through `avo know add`, so the lineage collection needs the same re-scan (#14).
  2. **`.qmd/` is gitignored with a `*`.** `index.yml` records collection paths as *absolute*
     paths, so a committed index is wrong on every other machine; `index.sqlite` is a
     multi-megabyte binary. Ignoring the whole directory also keeps it out of the tree-dirtiness
     check `avo commit` reasons about, at no cost to either.
  3. **`--min-score` is meaningless on `--lexical`.** `qmd search` reports every BM25 hit with
     `score: 0` (verified against 2.8.3), so a threshold would silently discard all of them; the
     hits are returned with a warning naming the reason instead.
  The bug this slice caught is worth remembering: **`spawn` sets `cwd` but not `$PWD`.** A shell
  always sets both; Node does not, and qmd resolves its project root from `$PWD`. So `avo know init
  --cwd <target>` reported success while writing the qmd index into **avo's own repo** instead —
  found only by running the e2e against a real qmd. `spawnRunner` now sets `PWD` alongside `cwd`,
  which fixes it for every child avo spawns (`bd`, git, and every scorer), with a regression test.

### S5 — Agent-agnostic skills `[x]`
- Author the `SKILL.md` files against the **agentskills.io spec** (valid frontmatter: `name`,
  `description`; progressive disclosure; relative paths to scripts).
- `avo install --agent pi|claude|codex|all` — wires discovery without copying:
  - Pi: `.agents/skills/` is discovered natively; also write `.pi/settings.json`
    (`skills`, `defaultTools`).
  - Claude Code: symlink `.claude/skills` → `.agents/skills`.
  - Codex: append the beads/avo snippet to `AGENTS.md` (idempotent, marker-delimited).
- `AGENTS.md` at repo root: the always-on rules (use `avo`, use `bd`, never markdown TODOs).
- **Verify:** a validator test asserting every `SKILL.md` parses and has a non-empty description;
  `avo install --agent all` twice produces no diff on the second run (idempotency).
- **Shipped (iter 6):** `src/skills.ts` (the spec's frontmatter subset, parsed without a YAML
  dependency, plus the validator) and `src/install.ts`. Four skills — `avo-vary`, `avo-score`,
  `avo-lineage`, `avo-knowledge` — each holding the judgement an agent needs and not just the flags
  (one idea per candidate; never edit `.avo/score` to pass; a refusal is a measurement).
  `avo install` is one command for all three agents: nothing to install for Pi beyond
  `.pi/settings.json`, one directory symlink for Claude Code, the `AGENTS.md` index for Codex.
  Recorded deviations, each with its reason:
  - **Four skills, not five.** `avo-fanout` moved to S6, where `avo fan` actually lands. A skill
    that tells an agent to run a command that does not exist is worse than no skill — and the
    concurrency guidance is not writable before the guards it describes exist. S6 now owns it.
  - **`.pi/settings.json` does not declare `skills`.** Pi discovers project `.agents/skills/`
    natively *and* warns on a name collision between two skill locations, so declaring it again
    buys a warning and nothing else. What Pi needs from us is `bash` in `defaultTools` — `avo`,
    `bd` and `qmd` are CLIs, which is the whole reason the harness is agent-agnostic (§2).
  - **`AGENTS.md` is unconditional, not Codex-only.** Every agent here reads it, and it carries the
    rules that hold whether or not a skill got loaded. Codex's *wiring* is the skills index inside
    it: Codex has no discovery mechanism, so naming the files is the mechanism.
  - **An existing real `.claude/skills` gets avo's skills linked inside it** rather than a bare
    refusal — the shape `qmd skill install` also uses, verified against qmd 2.8.3. Replacing the
    directory would delete skills a human wrote. `avo install` deletes nothing, ever; a symlink or
    file in the way needs `--force`, and a real directory is never touched even with it.
  - **Cross-repo links are absolute, in-repo links relative.** A relative link reaching *out* of the
    repo encodes the repo's own location and breaks the moment it is checked out elsewhere —
    including into the `git worktree`s S6 creates. `.claude/skills → ../.agents/skills` stays
    relative so the pair survives cloning.
  - **No skill links outside `.agents/skills/`.** The first draft of `avo-score` pointed at
    `../../../templates/score/README.md`; in a repo that symlinks the skill in, that resolves
    against *that* repo and is missing. A test now enforces the rule for every skill.
- **The trap S6 must handle:** Pi ignores project-local skills and settings until the project is
  trusted, and headless runs (`-p`, `--mode json`) never prompt — without a saved decision they
  ignore `.agents/skills/` and `.pi/settings.json` entirely. So `avo fan`'s `pi` template must pass
  `--approve`, or the skills silently do not load in exactly the mode it drives. `avo install`
  warns about this every time it wires pi.

### S6 — Concurrency: `avo fan` `[x]`
- Author `.agents/skills/avo-fanout/SKILL.md` (deferred from S5) alongside the command, so the skill
  and the guards it documents ship together. `src/skills.ts` validates it; `avo install` picks it up
  with no change — that is what the one-directory symlink for Claude Code buys.
- The `pi` command template must pass `--approve`: headless pi never prompts for project trust, and
  without it the skills `avo install` wired do not load at all (recorded in S5).
- `avo fan --n <k> --prompt-file <f> [--model <m>] [--agent <name>] [--timeout <s>]`
  → k `git worktree`s under `.avo/worktrees/<runid>/<i>`, k headless agent processes, JSON array of
  `{i, ok, score, diffstat, summary, worktree, tokens, wall_s}`.
- Command templates in `src/agents.ts`: `pi --mode json`, `claude -p --output-format stream-json`,
  `codex exec`, plus `custom` from config.
- Guards (from `pi-subagent`): max depth (`AVO_FAN_DEPTH`, default 3), cycle prevention,
  concurrency cap = `min(8, cpus-2)`, hard timeout, output truncated to 50KB/2000 lines with the
  overflow written to a file and its path returned.
- `avo fan --promote <i>` merges the chosen worktree back; cleanup removes untouched worktrees.
- Crash-safety: worktrees and a run manifest survive a kill; `avo fan --resume <runid>` reattaches.
- **Verify:** e2e with a stub agent binary (a script that edits a file and exits) — 4 parallel
  probes, all four results returned, worktrees cleaned, `git worktree list` back to baseline;
  timeout and depth-guard tests.
- **Shipped (iter 7):** `src/agents.ts` (the command templates and the output readers) and
  `src/fan.ts` (worktrees, probes, guards, promote, resume, clean), plus
  `.agents/skills/avo-fanout/SKILL.md`. `avo install` picked the fifth skill up with **no code
  change** — that is what the one-directory symlink from S5 bought. Every agent surface was read off
  the real binary before being coded against: pi 0.84.3 (`--approve`, `--mode json`, and the
  `message_end` / `message_update` events in its `docs/json.md`), claude 2.1.241 (`--print
  --output-format stream-json --verbose`, whose single `{"type":"result"}` line carries both the
  final message and the usage), codex-cli 0.147.0 (`exec --json`, `item.completed` /
  `turn.completed`). Recorded deviations, each with its reason:
  - **`--promote <i>` applies a patch and stops.** It does not score and does not commit: `avo
    commit` is the only writer of a version (invariant 1) and promotion is the explicit, separate
    step invariant 7 asks for. The patch is written to `.avo/worktrees/<run>/promote-<i>.patch`
    *before* it is applied, so a rejected promotion still leaves something to inspect; a `--3way`
    fallback is used only when the plain apply fails, and says so.
  - **Probes are scored automatically**, so the returned `score` is comparable across probes without
    N extra commands. `--no-score` opts out. A probe is scored even when its agent process failed —
    a half-finished edit that still passes `f` is a real result, and one that no longer builds is
    exactly what the operator needs to see. Hence `ok` (the process) and `score` (the candidate) are
    separate fields.
  - **`--list` and `--clean <id|all>` were added.** "Cleanup removes untouched worktrees" leaves the
    *touched* ones by design — they are the only copy of that work — so without an explicit cleaner
    `git worktree list` fills up and the feature becomes annoying enough to stop using.
  - **codex gets `--sandbox workspace-write`, not the bypass flag.** The worktree *is* the writable
    workspace, which is the whole point of fanning out into one; reads stay unrestricted so `avo
    score` works. The cost is that `avo commit` inside a codex probe is blocked (it would write to
    the parent repo's `.git`) — and promotion is the intended path anyway.
  - **The guards travel in the environment as three variables, not one.** `AVO_FAN_DEPTH` is the
    *cap*; `AVO_FAN_LEVEL` is how deep this agent already is and `AVO_FAN_CHAIN` the prompt hashes
    above it. The environment is the only channel that survives `spawn` into an arbitrary agent
    binary, and a cap with nothing counting against it is not a guard.
  - **A guard is a refusal (exit 1), not a harness error.** Depth and cycle refusals are the harness
    telling an agent it should be editing files itself — the same shape `avo commit` uses when it
    declines a candidate.
  - **Default `--timeout 900`, where `avo score`'s default is 0 (no limit).** A scorer that runs long
    is a slow benchmark; a headless agent that runs long is a process that never returns.
  - **A custom agent is declared in `.avo/config.json` under `agent`** (`{prompt}` / `{model}`
    substituted per argument) and may not shadow a built-in name — `--agent claude` meaning
    different things in different repos is exactly the divergence the templates exist to prevent.
  - **Agent auto-detection is a `$PATH` scan, not `<agent> --version`.** Probing three binaries
    costs three node startups before any work begins. Which agent was chosen, and why, is reported.
- **The bug the first run of the new tests caught:** `avo fan`'s own worktrees read as a variation.
  The dirty-tree warning ran on raw `git status --porcelain`, so the *second* fan-out in a repo
  warned the operator about `.avo/worktrees/` — a change the agent never made. Same class as the S3
  memory-log bug, same fix: filter through `withoutTrajectory`, and write `.avo/.gitignore` on the
  way in the way `avo commit` does, since `avo fan` may well be the first avo command a repo sees.

### S7 — Supervisor + continuous loop `[x]`
- `avo supervise [--json]` `[x]` — reads lineage + attempt log, detects (a) **stall**: ≥N attempts
  with no committed improvement; (b) **thrash**: ≥K consecutive attempts that failed the *same way*
  (the signature, not the file region — see the deviation below and #24). Emits a steering directive
  citing specific prior versions, the dead ends in memory, and the docs in `K` no version has
  mentioned.
- `avo run` `[x]` — the continuous evolution driver: prompt → agent turn → `avo commit` →
  `avo supervise` → inject directive if triggered → repeat. Replaces the hand-rolled `ralph.sh`
  polling for the AVO loop specifically (`ralph.sh` stays as the *meta* loop building `avocode`).
- Every intervention is logged (memory + bead) so the trajectory is auditable — the paper's 7-day
  run is only interpretable because interventions are recorded.
- **Verify:** unit tests driving the detector off synthetic lineage fixtures (stall fires at exactly
  N, resets on improvement, thrash fires on repeated same-signature failures) `[x]`; `avo run
  --dry-run --max-iters 3` against the stub agent produces the expected transcript `[x]`.
- **Shipped (iter 8) — the detector half.** `src/supervise.ts`: `readAttempts` (the first reader of
  `.avo/attempts.jsonl` — until now only `avo score` wrote it), the pure `detect`, the citation
  builder and `avo supervise`. Split from `avo run` on this plan's own instruction to build the
  detector first and separately: it is pure, testable off fixtures, and shippable on its own, while
  `avo run` needs the stub agent and a crash-safe iteration log. Recorded deviations, each with its
  reason:
  - **Thrash is "the same failure signature", not "the same file region".** `Attempt` records no file
    list, and adding one meant moving `withoutTrajectory`/`HARNESS_PATHS` out of `lineage.ts` to
    break a `score.ts` → `lineage.ts` cycle — a refactor across four modules for a slice that is
    already two commands. The signature (harness errors first, else the scorer's own first log line,
    with temp paths, shas and numbers folded to placeholders) is the region information the scorer
    already reports: a compiler error names the file. Filed as an issue rather than done quietly.
  - **Which attempts count as "since the best version" is decided by `attempt.git.head`, not by the
    clock.** An attempt scored *on top of* v3 carries v3's sha; the attempt that *became* v3 was
    scored before that commit existed and carries its parent's. Time cannot separate them: git
    truncates author dates to the second, so the committing attempt's millisecond `ts` can read as
    *later* than the commit it produced. This was a real bug, caught by the e2e failing
    intermittently — flooring to the second (the first fix) made a fast scorer's attempts vanish into
    the commit's own second instead. The clock stays as the fallback for an attempt whose head
    matches neither, with a full second of margin.
  - **Exit 1 means "a signal fired", not "refused".** `avo supervise || inject` is then the whole
    integration for a shell loop, and `avo run` will read the same two codes. Note it makes the
    command unusable at the head of a `set -o pipefail` pipeline, which cost two e2e checks before
    the output was captured first.
  - **Thresholds live in `.avo/config.json` (`supervise.stall`, `supervise.thrash`)**, because they
    are repo policy: a scorer that takes an hour wants a smaller `stall` than one that takes a
    second. A flag overrides. `loadConfig` now hands out a *fresh* defaults object — spreading
    `DEFAULT_CONFIG` is shallow and would have shared one `supervise` object across every caller,
    which is exactly S4's shared-`args` bug.
  - **`avo supervise` reads memory and `K` only when a signal has already fired.** Nothing to steer
    means no `bd` call, no directory walk, and no directive at all — the command a loop runs every
    iteration must be cheap in the common case.
  - **No sixth skill.** `avo supervise` went into `avo-vary`'s "when you are stuck" section instead:
    it is a step in a variation turn, not a separate capability, and the plan's skill list has five.
  - `knowledge.ts` gained `listDocs`: "what is in `K` at all" is a different question from "what
    matches this query", and a search cannot find what nobody thought to query for.

- **Shipped (iter 9) — the driver half.** `src/run.ts`: the loop, its crash-safe manifest and the
  intervention record. `avo fan`'s probe loop with the worktree taken away. Recorded deviations,
  each with its reason:
  - **`ensureTrajectoryIgnored` is now additive**, not write-once. It returned early whenever
    `.avo/.gitignore` existed, so `.avo/runs/` would have been ignored *only in repos created after
    this slice* — the worst kind of divergence, since it works on the machine that added it. A file
    carrying our marker (matched by the `# written by avo` prefix, so files written before `avo run`
    existed still qualify) gains the entries it is missing; a file without the marker is the
    operator's and is never touched. `IGNORE_ENTRIES` is asserted against `TRAJECTORY_PATHS` by a
    test, because the two drifting apart is silent.
  - **The manifest *is* the `--json` report.** One shape, not two: a manifest that can drift from
    what the command reports is one nobody trusts after a crash, and after a crash is the only time
    anybody reads it. Rewritten after every iteration.
  - **`MemoryKind` gained `intervention`, and it is a labelled bead, not a `bd remember` insight.**
    Insights are injected at prime time, so every future session would open with a stale directive
    from a run that ended days ago. `avo mem` lists interventions; `avo mem prime` does not.
  - **A no-op only counts as one when HEAD did not move.** An agent that ran `avo commit` itself
    leaves a clean tree, and calling that "nothing happened" would stop a loop that is working.
  - **`avo run` shares `avo fan`'s guard budget** (`AVO_FAN_DEPTH`/`LEVEL`/`CHAIN`) rather than
    getting its own. A turn is an agent that can call `avo run`, and a loop inside a loop is the same
    exponential hazard as a fan-out inside one; two separate budgets would each permit three levels.
  - **`MAX_CONSECUTIVE_NOOPS` is a stop condition the supervisor cannot express.** An unchanged tree
    is never scored, so it records no attempt and the stall detector never sees it — an idle agent
    would otherwise burn the whole budget invisibly. Related to but distinct from #25.
  - **`driveAgent`/`capOutput` moved into `agents.ts`** and `fan.ts` now calls them. `avo fan` and
    `avo run` must report a timeout, a crash and a missing binary in the same words; two copies of
    "how does an agent turn end" is how they start disagreeing.
  - **`--model` does not default to `AVO_PROBE_MODEL`.** Probes explore on a small model; `avo run`
    is the exploitation path (§3) and takes the agent's own default unless told otherwise.
  - **#8 measured before making `readLineage` an inner-loop call**, as this plan asked: the `git log`
    it runs costs ~14ms at 5,000 commits and ~3µs/commit, against an agent turn measured in seconds
    to minutes. Not a problem for the loop; the e2e asserts it at 2,000 commits so a regression is
    caught rather than assumed away.
  - Two real bugs the loop caught by being run, not by being read — see PROGRESS.jsonl iter 9.

### S8 — Pi implementation `[x]`
- `pi/extensions/avo/index.ts` — `pi.registerTool` for `avo_score`, `avo_commit`, `avo_lineage`,
  `avo_know_query`, `avo_know_add`, `avo_fan`. Thin wrappers over `src/`; typebox schemas; use
  `promptSnippet`/`promptGuidelines` so they land in the system prompt properly. Persist state in
  `tool_result.details` (docs are explicit: required for correct session branching).
- `pi/extensions/avo-supervisor/index.ts` — subscribe to `tool_result`; on `avo_score`/`avo_commit`
  update running state; on trigger call `avo supervise` and `pi.sendMessage(directive)`;
  `ctx.ui.setStatus("avo", "v12 · 1668 TFLOPS · 3 since best")` for a live footer;
  `ctx.ui.notify` on a new best. Close resources in `session_shutdown`, not the factory.
- ~~`pi.registerProvider` / `pi.setModel` used only to pin `AVO_PROBE_MODEL` for fan-out~~ —
  **dropped in S8b, and the reason is worth keeping.** Both act on the *current session's* model
  registry. `AVO_PROBE_MODEL` never reaches that registry: `runFan` reads it into `--model` on a
  *subprocess* (`pi --mode json --print --model X`), which resolves its own models from its own
  settings and auth. There is nothing for `registerProvider` to pin. Filed as #35 in case the
  intent was a different feature (defaulting `avo_fan`'s `model` from the live session), which is a
  new decision rather than the one this bullet described.
- **Verify:** an SDK-driven test (`createAgentSession` + `SessionManager.inMemory()` +
  `tools: [...]`) that scripts a stalling sequence and asserts the steering message is injected
  exactly once; extension loads cleanly under `pi --mode json` in the fixture repo.

- **Shipped (iter 10) — the tools half.** `pi/extensions/avo/{index.ts,tools.ts}`: the six tools,
  registered and discovered by real Pi 0.84.3. Split from the supervisor extension the way S7 split
  detector from driver — the tools are testable with no session at all, the supervisor needs a
  scripted stalling sequence. Recorded deviations, each with its reason:
  - **The tools live in `pi/`, never `src/`.** They need `typebox` at *runtime* for the schemas, and
    `typebox` (v1 — the package Pi resolves, a different package from the `@sinclair/typebox` v0.34
    `src/` uses, with a different `TSchema`) is a devDependency. Everything under `src/` is reachable
    from `bin/avo`, and `avo` must keep working in a checkout that never installed Pi.
  - **A harness error throws; a refusal does not.** Pi marks a tool result failed only when
    `execute` throws, so a thrown refusal would teach the model that a losing candidate is a
    malfunction. Same split as the CLI's exit codes (2 = harness error, 1 = refused). Both branches
    are tested per tool.
  - **`ctx.cwd` is the only source of the repo root** — no tool takes a `cwd`, `repo`, `dir` or
    `path` parameter, and a test asserts none ever gains one. An agent that can retarget the repo
    can write a version into a repo nobody is watching.
  - **`why` is required on `avo_commit`** while the CLI's `--why` is optional. A Pi turn is the one
    caller that always has the rationale in hand, and S7's directive is only worth reading because
    it can quote a real one back.
  - **`avo install --agent pi` now links `.pi/extensions/avo`**, which is where Pi discovers a
    project-local extension. A symlink, like the skills — a copy is a fork that stops receiving
    fixes, and two copies of the commit rule is what invariant 1 forbids. `skills.ts` exports
    `avocodeRoot()` so the skills link and the extension link cannot disagree about which checkout
    is ours.
  - **Ownership means "this repo IS the source", not "the link already points there"** — a bug the
    e2e caught: installing into avocode's own checkout linked it to itself and left avo's working
    tree dirty, which is the S3/S6 self-perturbation bug a fourth time.
  - **Project trust is resolved by the CALLER**, not read from settings by the loader: `reload()`
    takes a `resolveProjectTrust` callback, which is the seam `pi` fills from `defaultProjectTrust`,
    a saved `trust.json`, or `--approve`. The first e2e attempt asserted against the wrong layer and
    passed for the wrong reason until it was driven.
  - **`test/pi-drive.ts` is a checked-in harness**, not a file the e2e writes into the repo root at
    run time: a stray file in avocode's own tree is that same self-perturbation bug.
  - **Not yet built (at iter 10):** the supervisor extension. Shipped in iter 12, below.
  - **Decided early, as the handoff asked:** the Pi supervisor will count the same attempts
    `avo supervise` counts — `.avo/attempts.jsonl`, read through `supervise()` — rather than keeping
    its own in-session tally, so an operator running both cannot be steered twice for one stall.

- **Shipped (iter 12) — the supervisor half.** `pi/extensions/avo-supervisor/{index.ts,supervisor.ts}`,
  a SECOND extension rather than a second half of the first: the tools are useful without steering,
  and an operator already running `avo run` wants exactly that pairing. `avo install --agent pi`
  links both. Decisions worth keeping:
  - **The unit of steering is the EPISODE, not the attempt.** `episodeKeys()` names the run of
    consecutive readings that are the same problem — a stall by the best version it is stuck under
    plus the attempt index it began at, a thrash by its failure signature plus where the streak
    began — and one episode gets one directive. Steering every attempt burns context and teaches
    the model to skim the one message meant to change its mind. A new best, or a thrash appearing
    *during* a stall, is new information and does steer.
  - **The anchor is `analyzed - since_best`, not `attempts - since_best`.** Past `ANALYSIS_WINDOW`
    the detector only sees a window, so the untruncated total creeps up once per attempt while the
    window's own numbers hold still — the episode key would change every attempt and re-steer
    forever. Tested at the saturated boundary.
  - **Answered episodes are reconstructed from the injected messages on the branch**, via
    `ctx.sessionManager.getBranch()` in `session_start`. Pi's docs say to persist extension state in
    tool-result `details`, but this extension owns no tool, and a `tool_result` handler that
    returned `details` would CLOBBER the avo tool's own. The injected `custom_message` already
    carries everything and is already branch-scoped: a branch that never saw the directive is a
    model that never read it, and is steered again. `getBranch()`, never `getEntries()`.
  - **Only `avo_score` and `avo_commit` are watched.** `avo_fan` scores in disposable worktrees with
    `record: false`, so a fan-out moves no counter in this repo (invariant 7).
  - **Degrading is tested, not asserted.** A `supervise()` that throws, and a memory backend that
    throws, each cost one `ctx.ui.notify` warning and nothing else — the directive still lands in
    the second case, because it is already in the session file (invariant 4).
  - **Every steer is also an intervention memory**, keyed by the episode, so a Pi-driven trajectory
    audits exactly like an `avo run` one and re-recording is idempotent (invariant 5).
  - **`test/pi-supervise-drive.ts` is the SDK-driven acceptance**, and what it scripts is the MODEL,
    not the harness: real `DefaultResourceLoader`, real `ExtensionRunner`, real
    `SessionManager.inMemory()`, real `emitToolResult`, with the tool calls executed through the
    definitions Pi registered. A stalling sequence driven by an actual LLM is neither deterministic
    nor offline, and the extension reacts to tool results, not to prose. Six worsening scores, one
    directive; then `resetLeaf()` and a seventh, steered again.

### S9 — End-to-end validation `[~]`
Split the way S7 and S8 were: the target is testable with no agent at all, the run is not.

#### S9a — the optimization target `[x]`
- One real target with a real `.avo/score`, materialized into **its own git repo** by
  `bench/init.sh`. Not CUDA — we are validating the harness, not chasing FlashAttention.
- **Verify:** a scripted optimizer walking a known path commits ≥5 versions with a monotonically
  non-decreasing best score, and every committed version reproduces its recorded score from its own
  commit. `test/e2e-bench.sh`, 41 checks, `evidence/s9a-e2e.txt`.

**Shipped, with five deviations from the sketch above, each measured rather than argued:**
- **The target is not `hyperfine`-timed, and it is not a "hot function in a benchmark repo".** It is
  `bench/fuzzysearch` — thresholded edit-distance retrieval over a seeded pseudo-lexicon, timed
  in-process. Two reasons. `hyperfine` is not installed here or on the CI runner, and pinning the
  metric to a tool the harness cannot run would make "reproduces its recorded score" unverifiable
  in the one place it has to hold. And process-granular timing cannot see a candidate that ends up
  at 0.9ms, which this one does.
- **Matmul was tried first and rejected on measurement.** A naive nested-array triple loop against
  flat `Float64Array`, i-k-j order, transposed B, 64×64 tiling and a 2×-unrolled micro-kernel: the
  whole ladder is **1.7×**, and most steps are noise or regressions, because V8's JIT already does
  that work. A curve on that target would have proved only that the commit rule refuses things,
  which is exactly what §S9 warned against. Edit distance is **385×** across six steps.
- **`f` has three gates, not one.** (1) the protected files hash to what `bench/init.sh` recorded,
  (2) the unit suite passes, (3) `bench/run.js` re-checks the candidate against an independent
  reference **on the exact input it is about to be timed on**, and that it did not mutate its
  arguments. Gate 3 is the expensive one (it runs the naive reference every score, ~0.7s) and it
  is the one that earns its cost: `test/e2e-bench.sh` §4 ships a candidate that passes the entire
  unit suite and returns `[]` for any corpus over 1000 words. A unit suite cannot see that, and
  templates/score/README.md's own rule — keep the correctness check independent of the code under
  optimization — is unenforceable without it.
- **The gate is honest about its limits.** `.avo/gate.sha256` is generated at materialization time
  (so the template stays the single source of truth) and covers `.avo/score` itself, but an agent
  editing both the scorer and the hash file defeats it from inside. `bench/init.sh --verify` is the
  external audit that does not, and S9b must run it after the loop. Claiming more than that would
  be worse than the gate.
- **Sample counts are adaptive, and `spread_pct` is an interquartile range, not max−min.** A ladder
  spanning 385× makes any fixed rep count wrong at one end. `minReps: 3, maxReps: 500,
  budgetMs: 300` gives the 556ms baseline 3 samples and the 0.9ms candidate 469. With max−min the
  fast end reported 51% "spread" — a single GC pause, growing with the sample count, i.e. reading
  as *noisier* precisely because the measurement got *better*. On the IQR every step is 0–2.5%,
  which is what makes `floor: 0.03` the right band and not a guess.

Measured ladder (`test/fixtures/fuzzysearch/v{1..6}.js`, one reference machine, both configs):

| step | small | large | vs previous |
| --- | --- | --- | --- |
| v0 baseline (full DP, nested arrays) | 155.7ms | 556.4ms | — |
| v1 two-row rolling DP over `Int32Array` | 61.3ms | 237.4ms | 2.4× |
| v2 + length-difference prefilter | 30.6ms | 109.9ms | 2.1× |
| v3 + common prefix/suffix trim | 29.1ms | 104.8ms | 1.05× |
| v4 + Ukkonen band, row-minimum early exit | 8.2ms | 24.7ms | 3.9× |
| v5 + length-bucketed corpus index | 6.8ms | 20.7ms | 1.2× |
| v6 + letter-set bitmask prefilter | 0.66ms | 1.31ms | 13× |

v3 is kept deliberately: at ~5% it is the borderline case `floor: 0.03` exists to adjudicate. v6
was added because five steps left no slack — with only the first five, one marginal step falling
under the floor on a slower machine would drop the lineage to 4 versions and fail the ≥5 criterion
for a reason that has nothing to do with the harness.

#### S9b — the run `[ ]`
- Seed `K` with the relevant docs via `avo know add`, then run the loop on `bench/fuzzysearch` for a
  bounded budget.
- Record in `evidence/`: the score curve across versions, the number of supervisor interventions,
  token/cost split between probe (small) and commit (big) models, wall-clock.
- **Verify:** the same two criteria S9a proves are reachable — ≥5 versions, non-decreasing best,
  every score reproducible — now earned by an agent rather than by a script. Plus
  `bench/init.sh --verify` clean at the end: if `f` was edited, the curve means nothing.
- **Decided in S9a, do not re-open:** the target is `bench/fuzzysearch`; it must be materialized
  outside this checkout (`bench/init.sh` refuses otherwise, because `avo commit` would otherwise
  write the loop's whole lineage into avocode's own history — the S3/S6/S8 self-perturbation bug in
  its worst form); the ladder fixtures live in `test/fixtures/`, never in the template, so the
  optimizer is not handed the answer.
- **Still open, and this is where §6 Q3 gets answered:** run it BOTH ways — `avo run`
  (agent-agnostic, one process per turn) and a `pi` session with both extensions loaded — because
  the intervention counts and token splits are the only way to settle whether the native supervisor
  is worth its complexity, and #35 says the probe/commit split is what should settle the fan-out
  model question too.

### S10 — Population branching `(deferred, not scheduled)`
Paper §3.3 leaves it as future work; so do we. If we take it, this is where OpenEvolve's
MAP-Elites archive gets a second look — read it, don't depend on it.

---

## 5. Invariants

1. **`avo commit` is the only writer of committed lineage.** Nothing else creates an `Avo-Version`.
2. **A failing `f` never yields a commit.** Correctness gates everything.
3. **Every subcommand supports `--json`.** Agents parse; humans read the pretty form.
4. **Degrade, never crash.** Missing `qmd`/`bd`/API key ⇒ named fallback + one warning.
5. **Idempotent by construction.** Every `avo init`/`install`/`commit` is safe to re-run.
6. **Never leak secrets.** `avo doctor` reports *presence* of keys only. No key in any log, bead,
   lineage file, or prompt.
7. **Worktrees are disposable, `main` is not.** `avo fan` never writes outside its worktree;
   promotion is an explicit, separate step.
8. **CLI-first.** Any capability must be reachable from `bash` before it gets an MCP or Pi binding.
9. **The skills are the product.** If a workflow only works in Pi, it is unfinished.

## 6. Open questions (resolve in-slice, record the answer here)

- **Q1 (S1) — answered:** `f` is a vector; the commit decision compares `scores`, never the scalar
  `primary` (which is just their mean, for humans). Default reduction is **dominate-or-tie**: a
  candidate commits iff `normalized` is `>=` the best version on *every* config they share and `>`
  on at least one. Why not a weighted mean: a mean lets a large win on one config pay for a
  regression on another, which is precisely the silent regression the commit rule exists to stop.
  Configurable in `.avo/config.json` — `{"reduce":"mean","floor":0.02,"weights":{...}}` — for the
  real case where configs genuinely trade off. Two anti-gaming rules come with it: a config present
  in the best version but *missing* from the candidate blocks the commit (you cannot improve by
  measuring less), while a *new* config does not. **Landed in S2** as `src/compare.ts`, with two
  details the sketch left open: `floor` is a *symmetric* relative band (a change inside it counts as
  neither better nor worse, so noise cannot commit and cannot block), and a candidate whose
  `higher_is_better` differs from the best version's is refused as incomparable rather than ranked.
- **Q2 (S4) — answered:** yes. Firecrawl's free plan is **1,000 credits/month, no card**, and
  `/v2/search` costs 2 credits per 10 results, so the default is usable without paying. It stays the
  default for one reason beyond the tier: it is the only backend of the three that returns *page
  content*, which is what `avo know search --ingest` and `avo know add <url>` need. `searxng`
  (`SEARXNG_URL`, instance must enable `format=json`) and `ddgs` (keyless) are links-and-snippets
  fallbacks, and `--ingest` against them warns rather than half-ingesting. **Landed in S4.** One
  trap worth keeping: `ddgs text -o json` does *not* print to stdout — it writes
  `text_<query>_<timestamp>.json` into the current directory, so `avo` runs it in a temp dir that is
  removed either way, or it would litter the working tree with files `avo commit` reads as a
  variation.
- **Q3 (S7):** stall threshold N — the paper doesn't publish theirs. Start at 5 (the value in
  [avo-pi.md](avo-pi.md)'s sketch), make it configurable, tune with S9 evidence. **Still open, and
  now unblocked:** S9a built the target the tuning run needs, and left `.avo/config.json` in
  `bench/fuzzysearch` at the defaults precisely so S9b can move `supervise.stall` and see what it
  costs. What S9a did settle is the *other* threshold: `floor: 0.03`, from a measured 0–2.5%
  interquartile spread across the whole 385× ladder.
- **Q4 (S7):** if the loop proves fragile across days, adopt **absurd** (Postgres durable execution)
  for checkpointing rather than growing our own resume logic.
