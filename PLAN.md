# PLAN.md — `avocode`: an AVO-inspired agent harness

> Read this first every Ralph cycle. `PROGRESS.jsonl`'s last `next` is the default task.
> Slices are ordered; each is independently shippable and verifiable. Don't skip ahead.
>
> One handoff trap, learned the hard way: **never write `fixed`, `closes` or `resolves` next to an
> issue number in a commit message unless you fixed it.** GitHub matches the keyword, not the
> sentence — iteration 18's honest `Filed, not fixed: #49` closed #49 as completed, and the bug was
> still live a full iteration later. Write `filed #49 (not fixed)` instead.

---

## 1. What we are building

The [AVO paper](docs/avo-paper.md) replaces classical evolutionary variation operators with an
autonomous coding agent: `Vary(P_t) = Agent(P_t, K, f)`. Its result (SOTA attention kernels on B200)
is domain-specific; its **harness** is not. `avocode` extracts that harness and makes it general and
agent-agnostic.

Four contracts, one loop:

| Symbol | Meaning | Our implementation |
| --- | --- | --- |
| `f` | scoring function (correctness + a metric) | a repo-local executable `.avo/score` emitting one JSON line |
| `P_t` | lineage of committed solutions + scores | git commits w/ score trailers + `git notes` + `lineage/*.md` + beads graph |
| `K` | domain knowledge base | `knowledge/` indexed by **qmd** (hybrid BM25 + vector + local rerank) |
| Agent | the variation operator itself | any coding agent, driven by our skills + `avo` CLI |
| Supervisor | stagnation detection + steering | `avo supervise` (agnostic) / Pi extension (native) |

**Non-goal:** CUDA kernels. The demo target (Slice 9) is a scorer-driven optimization task, but `f` is
pluggable — bench time, eval pass-rate, bundle size, token cost, whatever emits JSON.

**Non-goal:** re-implementing an evolutionary framework. AVO's thesis is that the rigid
`Generate(Sample(P_t))` pipeline is the thing to delete. OpenEvolve (7.2k★) and ShinkaEvolve (1.4k★)
both implement exactly that pipeline; adopting either would reintroduce what AVO removes. Their
**archive/MAP-Elites** code is worth revisiting only if we ever do Slice 10 (population branching),
which the paper itself leaves as future work.

---

## 2. Composition decisions (researched 2026-08-22)

Rule applied: prefer existing software; highest-star credible option wins; reject a popular tool only
with a stated reason.

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
guards. `avo fan` does the same with a configurable command template, so it drives `pi`, `claude -p`,
`codex exec`, or anything else. (`pi-subagents`/`pi-crew` explicitly ruled out by
[avo-pi.md](docs/avo-pi.md); we take inspiration only.)

### Deliberately rejected

- **MCP as the primary transport.** Pi has **no built-in MCP** (it gives the model `read`, `write`,
  `edit`, `bash` by default; `ls`/`grep`/`find` also ship built-in, and MCP is listed only as
  something an *extension* could add). CLI-first is strictly more agent-agnostic: `qmd`, `bd` and
  `avo` work through `bash` in every agent that exists. qmd's own MCP server stays an opt-in nicety.
- **absurd** (2.4k, same org as Pi) — Postgres-backed durable execution. Real fit for multi-day crash
  recovery, but Postgres is too much for MVP. Revisit if the loop proves fragile (Slice 7 note).

---

## 3. Architecture

Full map, the `f` contract, the commit rule, the lineage/trajectory split and the small-model policy
live in **[docs/architecture.md](docs/architecture.md)** — the single source of truth for all of it.
This section keeps only what is planning-specific.

```
avocode/
  bin/avo                  # single entrypoint; walks its own symlink chain, then dispatches
  install.sh               # deps + `avo` linked onto PATH; idempotent, --force/--uninstall
  docs/                    # install, architecture, commands, agents, testing, bench, meta-loop
  src/                     # one file per contract — see docs/architecture.md § src/
  .agents/skills/          # THE agent-agnostic layer (Agent Skills standard), five skills
  AGENTS.md                # always-on rules + the skills index; only the marked block is managed
  pi/extensions/
    avo/                   # index.ts registers what tools.ts defines (typebox schemas)
    avo-supervisor/        # tool_result -> supervise() -> pi.sendMessage, episode-scoped
  templates/score/         # reference scorers: hyperfine, pytest, vitest, evals
  bench/                   # init.sh materializes a target into ITS OWN repo; --verify audits f
  test/fixtures/           # the ladders — the headroom proofs, deliberately NOT in bench/
  knowledge/  lineage/     # K corpus and rendered versions (both qmd collections)
  justfile                 # lint / typecheck / test / e2e
```

**Stack:** TypeScript on Node 22, `tsx` for execution, `node:test` for tests, `typebox` for Pi tool
schemas. One package. Rationale: the Pi extension and the CLI share `src/` verbatim — the
lineage/score logic is written once.

Frozen contracts, stated once in [docs/architecture.md](docs/architecture.md) and never re-derived
here: the `f` JSON line and its exit codes; the commit rule and its two anti-gaming rules; the
`TRAJECTORY_PATHS` / `HARNESS_PATHS` split; the nine invariants (also §5 below).

---

## 4. Slices

Each slice: build → verify with the stated command → commit → update `PROGRESS.jsonl`.

### S0 — Skeleton + health check `[x]`
- `package.json`, `tsconfig.json`, `bin/avo` → `src/cli.ts` via `tsx`; `justfile` with
  `lint`/`typecheck`/`test`/`e2e`; GitHub Actions running them.
- `avo --version`, `avo doctor` (presence/version of `git`, `qmd`, `bd`, `hyperfine`, `jq`, the agent
  CLI, and which API keys are set — never key values).
- **Verify:** `just lint typecheck test` green on a clean clone; `avo doctor` exits non-zero with a
  readable list when a dep is missing.
- **Shipped (iter 1):** lint = `oxlint` + shellcheck; tests = `node:test` via `tsx --test`.
  `just check` is the Ralph health check; `just e2e` drives the real `bin/avo` and writes
  `evidence/s0-e2e.txt`. `avo doctor` classifies deps `required` (git, jq) / `agent` (pi|claude|codex,
  **at least one**) / `optional`, exiting 1 only on a required or agent-group failure. Dep probing is
  injected (`Prober`), so missing-dependency paths are unit-tested without the filesystem.
- **Amended (iter 17):** "skipped when absent" was the bug, not the design. The recipe ended in
  `|| echo "shellcheck: skipped (not installed)"`, which swallowed *findings* as readily as a missing
  binary — CI collected 32 findings and went green printing a false reason, for eight slices (**#2**).
  The gate is now `test/lint-sh.sh`: targets discovered from git, `npm exec -- shellcheck` fallback,
  and it **fails** when neither can run. The version is pinned in `SC_PIN` (CI derives its install
  from that line): 0.9.0, what `apt` gives on `ubuntu-latest`, reports 20 `SC2317` hits that 0.11.0
  does not — an unpinned gate is red in CI and green on the laptop, which is how the last one stayed
  ignored. `test/e2e-lint.sh` (17 checks) holds it shut.

### S1 — `f`: scoring `[x]`
- `avo score [--parallel] [--json]` — runs `.avo/score`, validates against the typebox schema,
  normalizes, records the attempt (not a commit). A schema violation names the offending field.
- `templates/score/`: `hyperfine.sh`, `pytest.sh`, `vitest.sh`, plus the authoring `README.md`.
  `avo score --init <template>` scaffolds `.avo/score`.
- **Verify:** unit tests for the validator incl. malformed / `correct:false` / non-zero-exit cases; a
  fixture repo where `avo score --json | jq -e '.correct == false'` passes.
- **Shipped (iter 2):** `src/score.ts` — typebox schema + semantic checks (`primary` finite when
  passing; every `scores` value finite), normalization into an `Attempt`, `--parallel` fan-out over
  `--configs` at `min(8, cpus-2)`, `--timeout <s>`, `--init <template>`, `--no-record`, `--cwd <dir>`,
  `--json` everywhere and a pretty renderer. `main()` became `async`.
  - stdout parsing takes the *last* JSON-object line and warns about the rest: scorers that echo
    build noise are too common to reject.
  - the scorer is spawned `detached` so `--timeout` kills its whole process group. Killing only the
    scorer leaves its benchmark children holding our stdio pipes and we wait out the full run anyway
    (caught by e2e, regression-tested in `test/score.test.ts`).

### S2 — `P_t`: lineage `[x]`
- `avo commit` — atomic: score → compare vs best → on pass, commit with `Avo-Version` /`Avo-Score`
  trailers, write `git notes --ref=avo`, render `lineage/vNNN.md`, print the decision. On fail:
  refuse, explain, exit non-zero.
- `avo lineage [--json]`, `avo lineage show <n>`, `avo lineage diff <a> <b>`, `avo best`.
- Idempotent: re-running with no working-tree change is a no-op, not a duplicate.
- **Verify:** integration test on a throwaway repo — commit v1, attempt a regression (refused),
  commit an improvement (v2), `avo lineage --json | jq 'length == 2'`.
- **Shipped (iter 3):** `src/config.ts` (`.avo/config.json`: `reduce`, `floor`, `weights`, `configs`;
  malformed ⇒ defaults + a warning naming the field, never a disabled gate), `src/compare.ts` (the Q1
  comparator, pure and unit-tested at every branch), `src/lineage.ts`. `avo commit` gained `--why`,
  `--dry-run` (action `would-commit`) and the `avo score` flags. `runScore` was extracted from
  `scoreCommand` so commit and score share one scoring path — you cannot commit a score you did not
  measure.
  - **Trajectory must not enter the lineage.** Committing `.avo/attempts.jsonl` left the tree
    permanently dirty and turned every no-op into a real commit; the trajectory paths are now
    gitignored *and* explicitly unstaged after `git add -A`.
  - A refused or failed commit **rolls back the rendered `lineage/vNNN.md`**, so a refusal leaves
    nothing behind.
  - The direction check (`higher_is_better` flipping between versions) is refused outright rather than
    compared, which the vector comparison alone would silently get backwards.
  - Also closed #4 (declared `configs` skip the `--configs` probe) and fixed CI, which was running
    only `test/e2e.sh` and so had never executed the S1 or S2 e2e suites.

### S3 — beads memory `[x]`
- `bd init` on `avo init`. `avo mem add "<insight>"` → `bd remember`; `avo mem` → the memories;
  `avo mem prime` → `bd prime`. Each committed version gets a bead linked to its parent; each failed
  attempt gets an insight bead. Absent `bd` ⇒ `lineage/memory.jsonl` + one warning.
- **Verify:** `avo mem add` then `avo mem | grep` the insight; lineage beads show the correct parent
  chain via `bd show`; the no-`bd` fallback path has a test.
- **Shipped (iter 4):** `src/mem.ts` and `src/init.ts`. One `bd context --json` call answers both "is
  bd installed" and "does this repo have a database", which is what makes *installed-but-uninitialized*
  degrade instead of fail. Both backends return the same `Memory` shape. Ids are deterministic
  (`<prefix>-v<N>`; `<prefix>-x<hash8>` for a content-keyed dead end), so re-recording updates one
  record. `avo commit` mirrors its own decision: a commit writes a version bead linked to its parent,
  a refusal writes a dead end; `--dry-run`/`--no-record`/a no-op/a harness error write nothing.
  - **Deviation:** `avo mem` lists the memories rather than shelling out to `bd prime`, whose bulk is
    the bd command reference; `bd prime` is `avo mem prime`. The list is the parseable, stable thing
    an agent wants mid-loop.
  - **The bug worth remembering: avo's own writes must not read as a variation.**
    `lineage/memory.jsonl` is written *after* a commit, so with only `TRAJECTORY_PATHS` filtered the
    next `avo commit` saw a change the agent never made — it scored an unchanged tree, refused it,
    and remembered *that* refusal, dirtying the tree again. `HARNESS_PATHS` now covers the dirtiness
    check while staying *staged*.

### S4 — `K`: knowledge `[x]`
- `avo know init` (qmd collections for `knowledge/` and `lineage/`, plus `qmd context add`
  descriptions), `avo know query`, `avo know add <url|path>` (Firecrawl → markdown → provenance
  frontmatter → `qmd embed`), `avo know search` with `--ingest`. Backends behind one flag: `firecrawl`
  (default) | `searxng` | `ddgs`; no key ⇒ a message naming the alternatives, not a stack trace.
- **Verify:** ingest a fixed doc, `avo know query` returns it above a score threshold; backend
  selection unit-tested with a stubbed HTTP layer (no network in CI).
- **Shipped (iter 5):** `src/knowledge.ts` and `src/websearch.ts` (three backends behind one injected
  `Fetcher`, so all are tested with no network). `avo know init` folds into `avo init`. qmd's absence
  is the *common* path: `localSearch` answers the same query over the same files and returns the
  identical `Hit` shape, with `score` meaning the same thing (0..1, higher better).
  - **`avo know reindex` exists** (and `avo know add` runs `qmd update` before `qmd embed`).
    `qmd embed` only vectorizes documents the index already knows about, so a doc written *after*
    `qmd collection add` stays invisible until `qmd update` re-scans. `avo commit` writes into
    `lineage/` without going through `avo know add`, so the lineage collection needs it (#14).
  - **`.qmd/` is gitignored with a `*`.** `index.yml` records absolute collection paths, so a
    committed index is wrong on every other machine; `index.sqlite` is a multi-megabyte binary.
  - **`--min-score` is meaningless on `--lexical`.** `qmd search` reports every BM25 hit with
    `score: 0` (verified against 2.8.3), so a threshold would discard all of them; the hits are
    returned with a warning naming the reason.
  - **The bug worth remembering: `spawn` sets `cwd` but not `$PWD`.** A shell sets both; Node does
    not, and qmd resolves its project root from `$PWD`. So `avo know init --cwd <target>` reported
    success while writing the qmd index into **avo's own repo** — found only by running the e2e
    against a real qmd. `spawnRunner` now sets `PWD` alongside `cwd`, with a regression test.

### S5 — Agent-agnostic skills `[x]`
- Author the `SKILL.md` files against the **agentskills.io spec**. `avo install --agent
  pi|claude|codex|all` wires discovery without copying: pi gets `.pi/settings.json`, Claude Code gets
  `.claude/skills` → `.agents/skills`, Codex gets the marker-delimited `AGENTS.md` snippet.
- **Verify:** a validator test asserting every `SKILL.md` parses with a non-empty description;
  `avo install --agent all` twice produces no diff on the second run.
- **Shipped (iter 6):** `src/skills.ts` (the spec's frontmatter subset, parsed without a YAML
  dependency, plus the validator) and `src/install.ts`. Four skills, each holding the judgement an
  agent needs and not just the flags.
  - **Four skills, not five.** `avo-fanout` moved to S6, where `avo fan` lands. A skill telling an
    agent to run a command that does not exist is worse than no skill.
  - **`.pi/settings.json` does not declare `skills`.** Pi discovers project `.agents/skills/`
    natively *and* warns on a name collision, so declaring it again buys a warning. What Pi needs
    from us is `bash` in `defaultTools`.
  - **`AGENTS.md` is unconditional, not Codex-only.** Every agent reads it, and it carries the rules
    that hold whether or not a skill got loaded. Codex's *wiring* is the skills index inside it.
  - **An existing real `.claude/skills` gets avo's skills linked inside it** rather than a bare
    refusal — the shape `qmd skill install` also uses. `avo install` deletes nothing, ever.
  - **Cross-repo links are absolute, in-repo links relative.** A relative link reaching *out* of the
    repo encodes the repo's own location and breaks when checked out elsewhere — including into S6's
    worktrees.
  - **No skill links outside `.agents/skills/`.** `avo-score`'s first draft pointed at
    `../../../templates/score/README.md`; in a repo that symlinks the skill in, that resolves against
    *that* repo and is missing. A test now enforces it for every skill.
- **The trap S6 must handle:** Pi ignores project-local skills and settings until the project is
  trusted, and headless runs (`-p`, `--mode json`) never prompt. So `avo fan`'s `pi` template must
  pass `--approve`, or the skills silently do not load in exactly the mode it drives.

### S6 — Concurrency: `avo fan` `[x]`
- Author `.agents/skills/avo-fanout/SKILL.md` alongside the command, so the skill and the guards it
  documents ship together.
- `avo fan --n <k> --prompt-file <f> [--model] [--agent] [--timeout]` → k worktrees under
  `.avo/worktrees/<runid>/<i>`, k headless agent processes, a JSON array of
  `{i, ok, score, diffstat, summary, worktree, tokens, wall_s}`.
- Command templates in `src/agents.ts`: `pi --mode json`, `claude -p --output-format stream-json`,
  `codex exec`, plus `custom` from config. Guards from `pi-subagent`: depth (`AVO_FAN_DEPTH`, 3),
  cycle prevention, concurrency `min(8, cpus-2)`, hard timeout, output truncated with the overflow
  written to a file. `--promote <i>`, cleanup of untouched worktrees, `--resume <runid>`.
- **Verify:** e2e with a stub agent binary — 4 parallel probes, all four results returned, worktrees
  cleaned, `git worktree list` back to baseline; timeout and depth-guard tests.
- **Shipped (iter 7):** `src/agents.ts` and `src/fan.ts`, plus the fifth skill — which `avo install`
  picked up with **no code change**, which is what S5's one-directory symlink bought. Every agent
  surface was read off the real binary first: pi 0.84.3 (`--approve`, `--mode json`, the
  `message_end`/`message_update` events), claude 2.1.241 (`--print --output-format stream-json
  --verbose`, whose single `{"type":"result"}` line carries the final message and the usage),
  codex-cli 0.147.0 (`exec --json`, `item.completed`/`turn.completed`).
  - **`--promote <i>` applies a patch and stops.** No score, no commit: `avo commit` is the only
    writer (invariant 1) and promotion is the separate step invariant 7 asks for. The patch is
    written to `.avo/worktrees/<run>/promote-<i>.patch` *before* it is applied; a `--3way` fallback is
    used only when the plain apply fails, and says so.
  - **Probes are scored automatically**, so `score` is comparable across probes without N extra
    commands (`--no-score` opts out). A probe is scored even when its agent process failed — hence
    `ok` (the process) and `score` (the candidate) are separate fields.
  - **`--list` and `--clean <id|all>` were added.** Touched worktrees are left by design, so without
    an explicit cleaner `git worktree list` fills up.
  - **codex gets `--sandbox workspace-write`, not the bypass flag.** The worktree *is* the writable
    workspace; reads stay unrestricted so `avo score` works. Cost: `avo commit` inside a codex probe
    is blocked, and promotion is the intended path anyway.
  - **The guards travel as three env variables, not one.** `AVO_FAN_DEPTH` is the cap;
    `AVO_FAN_LEVEL` is how deep this agent already is and `AVO_FAN_CHAIN` the prompt hashes above it.
    The environment is the only channel that survives `spawn` into an arbitrary agent binary.
  - **A guard is a refusal (exit 1), not a harness error** — the same shape `avo commit` uses.
  - **Default `--timeout 900`, where `avo score`'s default is 0.** A scorer that runs long is a slow
    benchmark; a headless agent that runs long is a process that never returns.
  - **A custom agent is declared in `.avo/config.json`** (`{prompt}`/`{model}` substituted per
    argument) and may not shadow a built-in name.
  - **Agent auto-detection is a `$PATH` scan, not `<agent> --version`** — three node startups before
    any work begins. Which agent was chosen, and why, is reported.
- **The bug the new tests caught:** `avo fan`'s own worktrees read as a variation. The dirty-tree
  warning ran on raw `git status --porcelain`, so the *second* fan-out warned about `.avo/worktrees/`.
  Same class as S3's memory-log bug, same fix: filter through `withoutTrajectory`, and write
  `.avo/.gitignore` on the way in.

### S7 — Supervisor + continuous loop `[x]`
- `avo supervise [--json]` — reads lineage + attempt log, detects **stall** (≥N attempts with no
  committed improvement) and **thrash** (≥K consecutive attempts failing the *same way*). Emits a
  directive citing prior versions, the dead ends in memory, and the docs in `K` no version mentioned.
- `avo run` — prompt → agent turn → `avo commit` → `avo supervise` → inject directive → repeat. Every
  intervention is logged (memory + bead), because the paper's 7-day run is only interpretable when
  interventions are recorded.
- **Verify:** unit tests driving the detector off synthetic lineage fixtures `[x]`;
  `avo run --dry-run --max-iters 3` against the stub agent produces the expected transcript `[x]`.
- **Shipped (iter 8) — the detector half.** `src/supervise.ts`: `readAttempts`, the pure `detect`, the
  citation builder and `avo supervise`. Split from `avo run` on this plan's own instruction: it is
  pure, testable off fixtures, and shippable alone.
  - **Thrash is "the same failure signature", not "the same file region".** `Attempt` records no file
    list, and adding one meant moving `withoutTrajectory`/`HARNESS_PATHS` out of `lineage.ts` to
    break a `score.ts` → `lineage.ts` cycle. The signature (harness errors first, else the scorer's
    first log line, with temp paths, shas and numbers folded to placeholders) is the region
    information the scorer already reports. Filed as an issue rather than done quietly.
  - **"Since the best version" is decided by `attempt.git.head`, not the clock.** An attempt scored
    *on top of* v3 carries v3's sha; the attempt that *became* v3 carries its parent's. Git truncates
    author dates to the second, so the committing attempt's millisecond `ts` can read as *later* than
    the commit it produced. A real bug, caught by an intermittently failing e2e — flooring to the
    second (the first fix) made a fast scorer's attempts vanish into the commit's own second instead.
  - **Exit 1 means "a signal fired", not "refused"**, so `avo supervise || inject` is the whole shell
    integration. It makes the command unusable at the head of a `set -o pipefail` pipeline, which
    cost two e2e checks before the output was captured first.
  - **Thresholds live in `.avo/config.json`** (`supervise.stall`, `supervise.thrash`) because they
    are repo policy; a flag overrides. `loadConfig` now hands out a *fresh* defaults object —
    spreading `DEFAULT_CONFIG` is shallow and would have shared one `supervise` object across every
    caller, which is S4's shared-`args` bug.
  - **Memory and `K` are read only when a signal has already fired.** The command a loop runs every
    iteration must be cheap in the common case.
  - **No sixth skill.** `avo supervise` went into `avo-vary`'s "when you are stuck" section: it is a
    step in a variation turn, not a separate capability.
  - `knowledge.ts` gained `listDocs`: "what is in `K` at all" is a different question from "what
    matches this query", and a search cannot find what nobody thought to query for.
- **Shipped (iter 9) — the driver half.** `src/run.ts`: the loop, its crash-safe manifest and the
  intervention record. `avo fan`'s probe loop with the worktree taken away.
  - **`ensureTrajectoryIgnored` is now additive**, not write-once. It returned early whenever
    `.avo/.gitignore` existed, so `.avo/runs/` would have been ignored *only in repos created after
    this slice* — the worst kind of divergence. A file carrying our marker gains the entries it is
    missing; a file without it is the operator's and is never touched. `IGNORE_ENTRIES` is asserted
    against `TRAJECTORY_PATHS` by a test, because the two drifting apart is silent.
  - **The manifest *is* the `--json` report.** One shape, not two: a manifest that can drift from what
    the command reports is one nobody trusts after a crash, and after a crash is the only time anybody
    reads it. Rewritten after every iteration.
  - **`MemoryKind` gained `intervention`, and it is a labelled bead, not a `bd remember` insight.**
    Insights are injected at prime time, so every future session would open with a stale directive.
  - **A no-op only counts as one when HEAD did not move.** An agent that ran `avo commit` itself
    leaves a clean tree, and calling that "nothing happened" would stop a loop that is working.
  - **`avo run` shares `avo fan`'s guard budget** rather than getting its own. A turn is an agent that
    can call `avo run`; two separate budgets would each permit three levels.
  - **`MAX_CONSECUTIVE_NOOPS` is a stop condition the supervisor cannot express.** An unchanged tree
    is never scored, records no attempt, and the stall detector never sees it.
  - **`driveAgent`/`capOutput` moved into `agents.ts`.** `avo fan` and `avo run` must report a
    timeout, a crash and a missing binary in the same words.
  - **`--model` does not default to `AVO_PROBE_MODEL`.** Probes explore on a small model; `avo run` is
    the exploitation path and takes the agent's own default.
  - **#8 measured before making `readLineage` an inner-loop call:** its `git log` costs ~14ms at 5,000
    commits and ~3µs/commit, against an agent turn measured in minutes. The e2e asserts it at 2,000
    commits so a regression is caught rather than assumed away.

### S8 — Pi implementation `[x]`
- `pi/extensions/avo/index.ts` — `pi.registerTool` for `avo_score`, `avo_commit`, `avo_lineage`,
  `avo_know_query`, `avo_know_add`, `avo_fan`. Thin wrappers over `src/`; typebox schemas; state in
  `tool_result.details` (the docs are explicit: required for correct session branching).
- `pi/extensions/avo-supervisor/index.ts` — subscribe to `tool_result`; on trigger call `supervise()`
  and `pi.sendMessage(directive)`; `ctx.ui.setStatus` for a live footer, `ctx.ui.notify` on a new
  best. Close resources in `session_shutdown`, not the factory.
- ~~`pi.registerProvider`/`pi.setModel` to pin `AVO_PROBE_MODEL`~~ — **dropped in S8b.** Both act on
  the *current session's* model registry, and `AVO_PROBE_MODEL` never reaches it: `runFan` reads it
  into `--model` on a *subprocess*, which resolves its own models from its own settings and auth.
  Filed as #35 in case the intent was a different feature (defaulting `avo_fan`'s `model` from the
  live session), which is a new decision.
- **Verify:** an SDK-driven test (`createAgentSession` + `SessionManager.inMemory()`) that scripts a
  stalling sequence and asserts the steering message is injected exactly once; the extension loads
  cleanly under `pi --mode json` in the fixture repo.
- **Shipped (iter 10) — the tools half.** `pi/extensions/avo/{index.ts,tools.ts}`: six tools,
  registered and discovered by real Pi 0.84.3.
  - **The tools live in `pi/`, never `src/`.** They need `typebox` at *runtime* for the schemas, and
    `typebox` (v1 — the package Pi resolves, distinct from the `@sinclair/typebox` v0.34 `src/` uses)
    is a devDependency. Everything under `src/` must keep working in a checkout that never installed
    Pi.
  - **A harness error throws; a refusal does not.** Pi marks a tool result failed only when `execute`
    throws, so a thrown refusal would teach the model that a losing candidate is a malfunction. Both
    branches are tested per tool.
  - **`ctx.cwd` is the only source of the repo root** — no tool takes a `cwd`, `repo`, `dir` or `path`
    parameter, and a test asserts none ever gains one.
  - **`why` is required on `avo_commit`** while the CLI's `--why` is optional. A Pi turn always has
    the rationale in hand, and S7's directive is only worth reading because it can quote a real one.
  - **`avo install --agent pi` links `.pi/extensions/avo`.** A symlink, like the skills — a copy is a
    fork that stops receiving fixes. `skills.ts` exports `avocodeRoot()` so the skills link and the
    extension link cannot disagree about which checkout is ours.
  - **Ownership means "this repo IS the source", not "the link already points there"** — a bug the
    e2e caught: installing into avocode's own checkout linked it to itself and dirtied avo's working
    tree, the S3/S6 self-perturbation bug a fourth time.
  - **Project trust is resolved by the CALLER**, not read from settings by the loader: `reload()`
    takes a `resolveProjectTrust` callback, the seam `pi` fills from `defaultProjectTrust`, a saved
    `trust.json`, or `--approve`. The first e2e attempt asserted against the wrong layer and passed
    for the wrong reason until it was driven.
  - **`test/pi-drive.ts` is a checked-in harness**, not a file the e2e writes into the repo root at
    run time — that is the same self-perturbation bug.
- **Shipped (iter 12) — the supervisor half.** `pi/extensions/avo-supervisor/{index.ts,supervisor.ts}`,
  a SECOND extension rather than a second half of the first: the tools are useful without steering.
  - **The unit of steering is the EPISODE, not the attempt.** `episodeKeys()` names the run of
    consecutive readings that are the same problem, and one episode gets one directive. Steering every
    attempt burns context and teaches the model to skim the one message meant to change its mind. A
    new best, or a thrash appearing *during* a stall, is new information and does steer.
  - **The anchor is `analyzed - since_best`, not `attempts - since_best`.** Past `ANALYSIS_WINDOW` the
    detector only sees a window, so the untruncated total creeps up once per attempt while the
    window's numbers hold still — the episode key would change every attempt and re-steer forever.
    Tested at the saturated boundary.
  - **Answered episodes are reconstructed from the injected messages on the branch**, via
    `ctx.sessionManager.getBranch()` in `session_start`. Pi's docs say to persist extension state in
    tool-result `details`, but this extension owns no tool, and a `tool_result` handler returning
    `details` would CLOBBER the avo tool's own. `getBranch()`, never `getEntries()`.
  - **Only `avo_score` and `avo_commit` are watched.** `avo_fan` scores in disposable worktrees with
    `record: false` (invariant 7).
  - **Degrading is tested, not asserted.** A throwing `supervise()` and a throwing memory backend
    each cost one `ctx.ui.notify` warning and nothing else — the directive still lands in the second
    case, because it is already in the session file (invariant 4).
  - **Every steer is also an intervention memory**, keyed by the episode, so a Pi-driven trajectory
    audits exactly like an `avo run` one and re-recording is idempotent (invariant 5).
  - **`test/pi-supervise-drive.ts` scripts the MODEL, not the harness:** real
    `DefaultResourceLoader`, `ExtensionRunner`, `SessionManager.inMemory()` and `emitToolResult`, with
    the tool calls executed through the definitions Pi registered. Six worsening scores, one
    directive; then `resetLeaf()` and a seventh, steered again.

### S9 — End-to-end validation `[~]`
Split the way S7 and S8 were: the target is testable with no agent at all, the run is not.

#### S9a — the optimization target `[x]`
- One real target with a real `.avo/score`, materialized into **its own git repo** by `bench/init.sh`.
- **Verify:** a scripted optimizer walking a known path commits ≥5 versions with a monotonically
  non-decreasing best score, and every committed version reproduces its recorded score from its own
  commit. `test/e2e-bench.sh`, 41 checks, `evidence/s9a-e2e.txt`.

**Shipped, with five deviations, each measured rather than argued:**
- **Not `hyperfine`-timed, and not a "hot function in a benchmark repo".** It is `bench/fuzzysearch` —
  thresholded edit-distance retrieval over a seeded pseudo-lexicon, timed in-process. `hyperfine` is
  installed neither here nor on the CI runner, and pinning the metric to a tool the harness cannot run
  would make "reproduces its recorded score" unverifiable in the one place it has to hold. And
  process-granular timing cannot see a candidate that ends up at 0.9ms, which this one does.
- **Matmul was tried first and rejected on measurement.** Naive nested-array triple loop against flat
  `Float64Array`, i-k-j order, transposed B, 64×64 tiling and a 2×-unrolled micro-kernel: the whole
  ladder is **1.7×**, most steps noise or regressions, because V8's JIT already does that work. Edit
  distance is **385×** across six steps.
- **`f` has three gates, not one:** the protected files hash to what `bench/init.sh` recorded; the
  unit suite passes; `bench/run.js` re-checks the candidate against an independent reference **on the
  exact input it is about to be timed on**, and that it did not mutate its arguments. Gate 3 is the
  expensive one (~0.7s per score) and it earns its cost: `test/e2e-bench.sh` §4 ships a candidate that
  passes the entire unit suite and returns `[]` for any corpus over 1000 words.
- **The gate is honest about its limits.** `.avo/gate.sha256` is generated at materialization time (so
  the template stays the single source of truth) and covers `.avo/score` itself, but an agent editing
  both the scorer and the hash file defeats it from inside. `bench/init.sh --verify` is the external
  audit that does not, and S9b must run it after the loop.
- **Sample counts are adaptive, and `spread_pct` is an interquartile range, not max−min.** A ladder
  spanning 385× makes any fixed rep count wrong at one end. `minReps: 3, maxReps: 500, budgetMs: 300`
  gives the 556ms baseline 3 samples and the 0.9ms candidate 469. With max−min the fast end reported
  51% "spread" — a single GC pause, growing with the sample count, i.e. reading as *noisier* precisely
  because the measurement got *better*. On the IQR every step is 0–2.5%, which is what makes
  `floor: 0.03` the right band and not a guess.

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

v3 is kept deliberately: at ~5% it is the borderline case `floor: 0.03` exists to adjudicate. v6 was
added because five steps left no slack — one marginal step falling under the floor on a slower machine
would drop the lineage to 4 versions and fail the ≥5 criterion for a reason unrelated to the harness.

#### S9b — the run `[~]`
Split again: `avo run` needs no second agent harness, a `pi` session with both extensions does.
**S9b-1 and S9b-2a are done — S9's two acceptance criteria are met (`evidence/s9b-run-2.txt`, 10/10).
What is left is S9b-2b, the `pi` comparison.**

##### S9b-1 — the agent-agnostic run `[x]`
`avo run --agent claude` against `bench/fuzzysearch`, K seeded first, `bench/init.sh --verify`
afterwards. `bench/verify-run.sh <target> [run-id]` turns a finished run into `evidence/s9b-run.txt`
and checks S9's two criteria; every number below is read back from the manifest and the lineage.

| | |
| --- | --- |
| iterations | 6 of 12, stopped by `.avo/STOP` (a wall-clock watchdog, not convergence) |
| wall-clock | 34m 43s |
| versions | **4** committed, 0 regressions, 1 refusal |
| speedup | 1810.4ms → 0.345ms = **5255×** |
| interventions | **0** — `since_best` never reached the stall threshold of 5 |
| `f` intact | yes, `bench/init.sh --verify` clean on all 5 protected files |

```
v1  6.854ms   264×   rolling Int32Array band (Ukkonen) + length-bucketed corpus + flat code units
v2  0.642ms   10.7×  character-set bitmask prefilter, gated to k <= 6
v3  0.408ms   1.57×  partition (pigeonhole) hash index — NOT in the S9a ladder
v4  0.345ms   1.18×  PassJoin position-aware probe window on that index
```

**The result that matters is v3.** The agent's first commit fused five of the six hand-written steps;
its third went somewhere the ladder does not — cut each corpus word into `k+1` disjoint segments, hash
them, and by pigeonhole one segment of any match survives an edit budget of `k` verbatim, so the scan
becomes a handful of substring probes. It cited K's bucketing note as the reason ("the same idea
applies to any filter whose key is discrete"). So K earned its seeding, and the ladder is a floor on
this target, not a ceiling.

**Criterion 1 was not met by this run: 4 versions, not ≥5.** The loop was cut off by a watchdog at 34
minutes because a Ralph iteration has one hour total, not because it converged — iteration 6's
candidate was *refused* (`'small' regressed -4.74%`, floor ±3%), which is the commit rule working.
The target repo persisted, and **S9b-2a resumed the same lineage and carried it to v7 — criterion 1
now passes.**

**Five things the run measured that no test could have:**
- **`avo run`'s manifest under-reported a well-behaved agent.** Every iteration recorded `noop`, and
  `committed` stayed empty, while git grew four versions — the `avo-vary` skill has the agent call
  `avo commit` itself. Filed as **#42**; **fixed in iter 15** via `agent_versions`, read back from the
  `Avo-Version` trailers in `head_before..head_after` minus step 2's own. Replayed in
  `evidence/issue-42-replay.txt`: `committed=[]` becomes `[1,2,3,4]`, and iterations 5 and 6 stay
  empty because they genuinely were. #42's claim that #29's counter miscounts these was **wrong** —
  `idle` has required `head_after === head_before` since S7.
- **The token totals were unusable — fixed, and it had a second cause.** The manifest reported **44
  input tokens for a loop that sent 985,039**, and no cost. Two independent bugs (**#43**):
  `tokensFrom` took `input_tokens` only, dropping the `cache_read_input_tokens` that are almost all of
  a long loop's input; and `spawnRunner`'s 200KB output cap kept only the *head*, so **four of the six
  turns lost the closing `result` event** — with it the usage, the cost *and* the final message.
  `AgentTokens` now carries `cache_read`/`cache_write` as disjoint fields (`input` normalized to mean
  uncached, which costs codex a subtraction), `cost_usd` is read off the agent, and the cap spends
  50KB on a rolling tail and marks the gap. Replayed in `evidence/issue-43-replay.txt`; the recovered
  floor is **$1.91 across two iterations** the manifest priced at nothing. That closes the *harness*
  half; the probe-vs-commit split still needs a small-model key.
- **Nothing in the harness puts `avo` on the target's `PATH`.** Five wired skills all open with
  `avo ...`, and every one would have been `command not found`. Worked around with
  `PATH=…/avocode/bin:$PATH`; filed as **#41**, because the failure mode is a flat curve that reads as
  a fact about the target.
- **480s per turn was too short at the end.** Iterations 5 and 6 were both killed on the timeout — the
  later a candidate is, the more scoring and differential testing a turn does. Not a bug; a number
  S9b-2 should raise.
- **`avo know add <path>` slugs the whole path**, so K docs get named after the directory they were
  ingested from (`knowledge/tmp-s9b-k-ukkonen-…`). Filed as **#40**.

**Deviation:** K was seeded from four notes written offline (Ukkonen's band, Myers bit-parallel,
BK-trees + Levenshtein automata + cheap filters, V8 numeric-loop performance) rather than via
`avo know search --ingest`. No `FIRECRAWL_API_KEY`, no `ddgs`, no `SEARXNG_URL` on this machine, and no
`qmd` either — so K was served by the local-scan fallback. The notes are the standard literature and
deliberately do not contain the ladder.

##### S9b-2a — carry the curve past 5 versions `[x]`
Same target repo, same prompt, resumed from v4 rather than re-materialized. `--timeout 900`,
`--max-iters 6`, watchdog at 1200s. `bench/verify-run.sh` wrote `evidence/s9b-run-2.txt`; **all 10
checks pass, and S9's two acceptance criteria are met.**

| | |
| --- | --- |
| iterations | 3 of 6, stopped by `.avo/STOP` (the watchdog again, not convergence) |
| wall-clock | 30m 41s |
| versions | **7** committed (3 new), 0 regressions, 0 refusals |
| speedup | 1810.37ms → 0.231ms = **7837×** (this run's own share: 0.345 → 0.231, 1.49×) |
| interventions | **0** — `since_best` never left 0; every single turn committed |
| cost | **$8.19** for 3 turns = **$2.73/turn** |
| `f` intact | yes, `bench/init.sh --verify` clean on all 5 protected files |

```
v5  0.331ms  1.04×  one interleaved Int32Array for the partition index (length+mask beside the link)
v6  0.270ms  1.22×  Myers bit-parallel for the survivors + fuse the layout pass into the index build
v7  0.231ms  1.17×  stop materializing the flat corpus buffer; branchless Myers with an early exit
```

**What the three turns show about the operator, not the target.** Every one opened with a
*measurement* and let it pick the change: v6's turn ablated the phases (`setup 0.147/0.073, chain walk
0.112/0.047, banded 0.118/0.098`) and found the band was 30–43% of the call — which the v4 and v5
notes had filed as "almost certainly too small to matter now". The agent read its own lineage's
prediction, measured it, and recorded that it was wrong. v7 did the same to v6's fused layout pass and
deleted the 46105-code-unit buffer it had just built, because only ~15000 code units are ever read.
Two of the three turns also *bundled deliberately*: a change measuring +2.66% is under the ±3% floor,
so it shipped with a partner rather than being tuned twice — the commit rule shaping the variation
step, which is the whole thesis.

**A dead end found twice, under different conditions.** Both v6's and v7's turns tried dropping the
counting sort (`shortEnd` is 0 on both scored configs, so the window scan it feeds is dead code) and
both measured a *regression*. v7 retried it precisely because removing `cBuf` should have neutralised
v6's locality argument — and it did not. Length order is load-bearing for the chain walk's random
slot-indexed reads. That is `avo mem`'s failure records doing their job across turns.

**Cost is the headline number, and it is 3× the estimate.** S9b-1's recovered floor implied
~$0.95/turn; the real, agent-reported figure is **$2.73/turn** — 5.56M cache-read tokens against 158
uncached input. **#28** (`avo run` has no cost budget) now has its first real input: at this rate a
12-iteration default run is ~$33, and nothing in the harness would stop it.

**Deviations and what they cost.** The refused v4→v5 candidate (interleaved entries, `-4.74%` on
`small`) was **discarded** from the working tree before resuming, not kept — it was already recorded as
a dead-end memory, the channel designed to carry it. Kept as
`evidence/s9b-refused-candidate-interleaved-entries.diff`. The agent reached the same idea again on its
own and made it win as v5. Two harness bugs surfaced and were filed: **#49** (the stream-json summary
fallback wrote a raw protocol event into permanent lineage — the polluted S9b-1 dead-end record is the
evidence), **fixed in iteration 19**; and **#51** (`verify-run.sh`'s `vs v0` column uses the *run's*
starting HEAD, so on this resumed run v1 prints as a 0.1× slowdown; the 7837× above is computed from
the lineage root by hand).

##### S9b-2b — the `pi` comparison `[ ]`
- The same target under a `pi` session with both extensions loaded. Compare intervention counts and the
  probe/commit token split that #35 says should settle the fan-out model question. **#43** is fixed, so
  the token half is measurable — S9b-2a is the `claude` side and reports real tokens and real dollars.
- A small-model key (`GROQ`/`CEREBRAS`/`OPENROUTER`, none set here) is still needed before `avo fan`
  has a cheap probe model, which is the other half of #35.
- **§6 Q3 is still open and now sharper.** Across nine agent turns the supervisor has fired **zero**
  times and `since_best` has never exceeded 2 — in S9b-2a it never left 0, because every turn
  committed. Q3 needs the *converged* end of this target, where real wins fall under `floor: 0.03` and
  nothing commits. v7 is 7837× in and still finding 17% per turn, so that end is further away than
  S9b-1 assumed; reaching it is several more paid runs, not one.

### S10 — Population branching `(deferred, not scheduled)`
Paper §3.3 leaves it as future work; so do we. If we take it, this is where OpenEvolve's MAP-Elites
archive gets a second look — read it, don't depend on it.

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
  `primary` (their mean, for humans). Default reduction is **dominate-or-tie**: `>=` on every shared
  config and `>` on at least one. Not a weighted mean — a mean lets a large win on one config pay for a
  regression on another, precisely the silent regression the rule exists to stop. Configurable in
  `.avo/config.json` for the real case where configs genuinely trade off. Two anti-gaming rules come
  with it: a config present in the best version but *missing* from the candidate blocks the commit,
  while a *new* config does not. **Landed in S2** as `src/compare.ts`, with two details the sketch left
  open: `floor` is a *symmetric* relative band, and a candidate whose `higher_is_better` differs from
  the best version's is refused as incomparable rather than ranked.
- **Q2 (S4) — answered:** yes. Firecrawl's free plan is **1,000 credits/month, no card**, and
  `/v2/search` costs 2 credits per 10 results. It stays the default for one reason beyond the tier: it
  is the only backend of the three returning *page content*, which is what `--ingest` and
  `avo know add <url>` need. `searxng` and `ddgs` are links-and-snippets fallbacks, and `--ingest`
  against them warns rather than half-ingesting. **Landed in S4.** One trap: `ddgs text -o json` does
  *not* print to stdout — it writes `text_<query>_<timestamp>.json` into the current directory, so
  `avo` runs it in a temp dir that is removed either way, or it would litter the working tree with
  files `avo commit` reads as a variation.
- **Q3 (S7):** stall threshold N — the paper doesn't publish theirs. Start at 5 (the value in
  [avo-pi.md](docs/avo-pi.md)'s sketch), make it configurable, tune with S9 evidence. **Still open, and
  sharper after S9b-1:** in a 6-iteration run the supervisor fired **zero** times, because `since_best`
  never got past 2 — a target with 5000× of headroom is improved faster than a stall detector can
  notice one. The threshold has to be tuned at the *converged* end. What S9a did settle is the *other*
  threshold: `floor: 0.03`, from a measured 0–2.5% interquartile spread across the whole 385× ladder.
- **Q4 (S7):** if the loop proves fragile across days, adopt **absurd** (Postgres durable execution)
  for checkpointing rather than growing our own resume logic.
