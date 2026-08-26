# Architecture

How avocode is put together, and why each piece is where it is. For *what a command does*, see
[commands.md](commands.md); this is the map underneath it.

## The idea in one table

The [AVO paper](avo-paper.md) replaces classical evolutionary variation operators with an autonomous
coding agent: `Vary(P_t) = Agent(P_t, K, f)`. Its result is domain-specific (attention kernels on
B200); its **harness** is not. avocode extracts that harness.

| Symbol | Meaning | How avocode implements it |
| --- | --- | --- |
| `f` | scoring function — correctness **and** a metric | a repo-local executable `.avo/score` printing one JSON line |
| `P_t` | the lineage of committed solutions and their scores | git commits with score trailers + `git notes` + `lineage/vNNN.md` |
| `K` | the domain knowledge base | `knowledge/` + `lineage/`, indexed by qmd (hybrid BM25 + vector + rerank) |
| Agent | the variation operator itself | any coding agent, driven by the skills in `.agents/skills/` |
| Supervisor | stagnation detection and steering | `avo supervise` (agnostic) and a native pi extension |

## The loop

```
  ┌───────────────────────────────────────────────────────────────────────────┐
  │                                                                           │
  ▼                                                                           │
 ┌─────────────────┐                                                          │
 │  Agent = Vary() │  reads the past, then changes the code                   │
 │                 │  avo mem prime · avo best · avo know query               │
 └────────┬────────┘                                                          │
          ▼                                                                   │
 ┌─────────────────┐                                                          │
 │    avo score    │  runs .avo/score — one JSON line, always exit 0          │
 │                 │  correctness is a gate, not a crash                      │
 └────────┬────────┘                                                          │
          ▼                                                                   │
 ┌─────────────────┐                                                          │
 │    avo commit   │  better on some config, worse on none?                   │
 │                 │  yes → a new version in P_t.  no → a recorded dead end   │
 └────────┬────────┘                                                          │
          ▼                                                                   │
 ┌─────────────────┐                                                          │
 │  avo supervise  │  N attempts with no improvement? same failure K times?   │
 │                 │  → a directive citing prior versions and unread docs     │
 └────────┬────────┘                                                          │
          └───────────────────────────────────────────────────────────────────┘
```

`avo run` is this cycle automated — one fresh agent process per turn.

## Three layers

| Layer | Where | What it is |
| --- | --- | --- |
| **CLI** | `bin/avo` → `src/main.ts` → `src/cli.ts` | the only interface that must exist. Invariant 8: any capability is reachable from `bash` before it gets a binding |
| **Skills** | `.agents/skills/*/SKILL.md` | the agent-agnostic layer — *the product*. Portable markdown, [Agent Skills standard](https://agentskills.io/specification), wired in by `avo install` without copying |
| **Bindings** | `pi/extensions/` | native pi tools + the in-session supervisor. Convenience, never capability — see [agents.md](agents.md) |

## `src/` — one file, one contract

`bin/avo` is a bash shim running `src/main.ts` through `tsx`. **There is no build step.** The pi
extension and the CLI import the same `src/` files verbatim, so scoring and lineage logic is written
once.

| File | Owns |
| --- | --- |
| `cli.ts` | subcommand dispatch, flag parsing, exit codes |
| `score.ts` | **`f`** — run `.avo/score`, validate the JSON, normalize it into an attempt |
| `config.ts` | `.avo/config.json` — the reduction, the noise floor, declared configs |
| `compare.ts` | the commit rule's comparator over the score *vector* |
| `lineage.ts` | **`P_t`** — `avo commit`, `avo lineage`, `avo best`; trailers, notes, `lineage/vNNN.md` |
| `mem.ts` | memory — beads (`bd`) with a `lineage/memory.jsonl` fallback |
| `knowledge.ts` | **`K`** — qmd collections, the local-scan fallback, ingest with provenance |
| `websearch.ts` | `K` from the web — firecrawl / searxng / ddgs behind one injectable `Fetcher` |
| `init.ts` | `avo init` — idempotent scaffolding, including `bd init` |
| `install.ts` | `avo install` — wires pi / claude / codex to `.agents/skills` without copying |
| `skills.ts` | the Agent Skills frontmatter parser and spec validator |
| `agents.ts` | headless agent command templates + `driveAgent` — one turn, as both `fan` and `run` see it |
| `fan.ts` | `avo fan` — worktrees, probes, the four guards, promote, resume |
| `supervise.ts` | `avo supervise` — the stall/thrash detector and the directive it cites with |
| `run.ts` | `avo run` — the continuous loop, its manifest, the intervention record |
| `doctor.ts` | dependency and API-key report |
| `steps.ts` | the `created`/`unchanged`/`skipped` step report `init` and `know init` share |
| `io.ts` | an injectable output sink, so every command is unit-testable without a terminal |
| `version.ts` | the version, read from `package.json` |

**Rest of the tree:**

```
bin/avo            the entrypoint; walks its own symlink chain so `avo` works from anywhere
install.sh         deps + the PATH link; see install.md
.agents/skills/    avo-vary, avo-score, avo-lineage, avo-knowledge, avo-fanout
AGENTS.md          always-on rules + the skills index (managed block; hand edits preserved)
pi/extensions/     avo/ registers the six native tools; avo-supervisor/ steers from inside
templates/score/   reference scorers (hyperfine, pytest, vitest) + the authoring guide
bench/             the optimization targets and the scripts that audit a run — see bench.md
test/              node:test unit tests + the e2e shell suites — see testing.md
evidence/          artifacts proving user-facing behavior works end to end
knowledge/         K corpus (markdown; a qmd collection)
lineage/           one rendered vNNN.md per committed version (also a qmd collection)
PLAN.md            the slice order, the invariants, the open questions
PROGRESS.jsonl     one line per iteration of the meta loop — see meta-loop.md
```

**Stack:** TypeScript on Node 22, `tsx` for execution, `node:test` for tests, `typebox` for the pi
tool schemas. One package, no bundler.

## The `f` contract (frozen — never break it)

Full authoring guide: [../templates/score/README.md](../templates/score/README.md).

`.avo/score` is any executable, run from the repo root. It **always exits 0** — failures are reported
*in* the JSON, so the agent receives a diagnosable payload instead of a crash. One line on stdout:

```json
{"ok":true,"correct":true,"primary":1668.2,"unit":"TFLOPS","higher_is_better":true,
 "scores":{"b1_s4096":1668.2,"b8_s1024":1421.7},"log":"...","duration_s":42.1}
```

- **Required:** `ok` (the scorer itself worked), `correct` (**the gate**), `primary` (`number|null`),
  `unit` (non-empty), `higher_is_better`.
- **Optional:** `scores`, `log`, `duration_s`.
- Unknown fields are allowed but warned about, so a misspelled `higherIsBetter` reads as both
  "required field missing" and "unknown field".

Two optional invocations enable `avo score --parallel`: `--configs` lists config names one per line,
`--config <name>` scores one. Anything else printed by `--configs` means "unsupported" and degrades
to a single serial run with one warning.

`ok:false` or `correct:false` ⇒ `primary` is forced to the failing sentinel **`null`**, whatever was
measured (paper §3.1: a candidate that fails correctness scores zero). `null` rather than literal
zero, because zero is the *best* possible value for a lower-is-better metric and so cannot also mean
failure. `avo score` additionally emits `normalized` — `primary` flipped so higher is always better —
so no consumer branches on direction.

## The commit rule

Persist a new version **only** when it passes correctness **and** beats the best committed version.
`avo commit` enforces it, and is the only writer (invariant 1).

The comparison is over the score **vector**, never the scalar `primary`. The default reduction is
*dominate-or-tie*: a candidate commits iff it is `>=` the best version on every shared config and `>`
on at least one. Not a weighted mean, because a mean lets a large win on one config pay for a
regression on another — the silent regression the rule exists to stop. Two anti-gaming rules come
with it: a config present in the best version but **missing** from the candidate blocks the commit
(you cannot improve by measuring less), while a *new* config does not.

`floor` is a **symmetric** relative noise band, so noise can neither commit nor block. A candidate
whose `higher_is_better` differs from the best version's is refused as incomparable rather than
ranked.

Because the rule only admits non-regressions, **the lineage is monotone by construction** and
`avo best` is simply the highest-numbered version. There is no separate ranking pass.

## Lineage vs. trajectory — the distinction everything rests on

| | What it is | Where it lives |
| --- | --- | --- |
| **Lineage** | the versions that survived `f` | git commits (`Avo-Version`, `Avo-Score` trailers), `git notes --ref=avo`, `lineage/vNNN.md` |
| **Trajectory** | how they were reached | `.avo/attempts.jsonl`, `.avo/worktrees/`, `.avo/runs/` — all gitignored |

`avo commit` stages everything *except* the trajectory paths. Committing the attempt log would put
the record of how a version was reached inside the version itself, and would leave the tree
permanently dirty — defeating the no-op check that makes `avo commit` idempotent.

A wider set (`HARNESS_PATHS` = the trajectory plus `.avo/.gitignore` and `lineage/memory.jsonl`) is
excluded from the *dirtiness* check but still staged. Those files belong in the repository; they are
simply not evidence of a variation, and counting them would make avo's own writes look like a
candidate the agent never produced.

## Invariants

Every change is checked against these. They are the short version of the whole design.

1. **`avo commit` is the only writer of committed lineage.** Nothing else creates an `Avo-Version`.
2. **A failing `f` never yields a commit.** Correctness gates everything.
3. **Every subcommand supports `--json`.** Agents parse; humans read the pretty form.
4. **Degrade, never crash.** A missing `qmd` / `bd` / API key ⇒ a named fallback and one warning.
5. **Idempotent by construction.** Every `avo init` / `install` / `commit` is safe to re-run.
6. **Never leak secrets.** `avo doctor` reports *presence* of keys only. No key in any log, bead,
   lineage file, or prompt.
7. **Worktrees are disposable, `main` is not.** `avo fan` never writes outside its worktree;
   promotion is an explicit, separate step.
8. **CLI-first.** Any capability must be reachable from `bash` before it gets an MCP or pi binding.
9. **The skills are the product.** If a workflow only works in Pi, it is unfinished.

## Where small models are mandatory, not optional

1. `avo fan` probes — N directions explored in parallel worktrees on a small model
   (`AVO_PROBE_MODEL`: Groq, Cerebras, Haiku). Only the winning direction gets the expensive model.
2. qmd's reranker is a local GGUF small model — free semantic search over `K` and the lineage.
3. `avo score --parallel` fans configs out concurrently.
4. Triage of a failed attempt, before the big model re-plans.

## The synergy worth protecting

`lineage/` is a qmd collection. So *"what did I already try about register pressure?"* is the same
query as *"what do the docs say about it?"* — the paper's §3.2 behavior (the agent examining multiple
prior implementations within one variation step), at no extra cost, because `avo commit` already
writes `lineage/vNNN.md`.

## Further reading

- [../PLAN.md](../PLAN.md) — the slice order, the composition decisions, the open questions
- [avo-paper.md](avo-paper.md) — the paper this harness is extracted from
- [avo-pi.md](avo-pi.md) — the original pi-flavored sketch
