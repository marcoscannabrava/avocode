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
    lineage.ts             # Pt — git trailers, notes, lineage/*.md, beads mirror
    knowledge.ts           # K  — qmd wrapper + Firecrawl ingest
    fan.ts                 # concurrency — worktrees + headless agent procs
    supervise.ts           # stagnation detection + steering directive
    agents.ts              # agent command templates (pi | claude | codex | custom)
  .agents/skills/          # THE agent-agnostic layer (Agent Skills standard)
    avo-vary/SKILL.md      #   how to perform one variation step
    avo-lineage/SKILL.md   #   how to read/extend Pt
    avo-knowledge/SKILL.md #   how to search K and grow it from the web
    avo-fanout/SKILL.md    #   when and how to parallelize with small models
    avo-score/SKILL.md     #   the f contract, how to author a scorer
  pi/extensions/
    avo/index.ts           # native Pi tools (thin wrappers over src/)
    avo-supervisor/index.ts# event-interception supervisor
  templates/score/         # reference scorers: hyperfine, pytest, vitest, evals
  knowledge/               # K corpus (markdown; qmd collection)
  lineage/                 # rendered vNNN.md per committed version (qmd collection)
  justfile                 # lint / typecheck / test / e2e
```

**Stack:** TypeScript on Node 22 (already installed), `tsx` for execution, `node:test` for tests,
`typebox` for tool schemas (what Pi uses). One package. Rationale: the Pi extension and the CLI
share `src/` verbatim — write the lineage/score logic once.

### The `f` contract (frozen in Slice 1, never break it)

`.avo/score` is any executable. It **always exits 0**; failures are reported *in* the JSON so the
agent receives a diagnosable payload instead of a crash. stdout, one line:

```json
{"ok":true,"correct":true,"primary":1668.2,"unit":"TFLOPS","higher_is_better":true,
 "scores":{"b1_s4096":1668.2,"b8_s1024":1421.7},"log":"...","duration_s":42.1}
```

`correct:false` ⇒ `primary` is forced to the failing sentinel regardless of measured value
(paper §3.1: "a candidate that fails correctness is assigned zero score").

### The commit rule (paper §3.2)

Persist a new version **only** when it passes correctness **and** matches-or-beats the best
committed version. Failed attempts stay in the agent's trajectory and in beads (as insight beads),
never in the committed lineage. `avo commit` enforces this atomically — it is the only writer.

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

### S1 — `f`: scoring `[ ]`
- `avo score [--parallel] [--json]` — runs `.avo/score`, validates against the typebox schema,
  normalizes, records the attempt (not a commit).
- Schema violation ⇒ actionable error naming the offending field.
- `templates/score/`: `hyperfine.sh` (wall-clock), `pytest.sh` + `vitest.sh` (pass-rate),
  `README.md` on authoring one. `avo score --init <template>` scaffolds `.avo/score`.
- **Verify:** unit tests for the validator incl. malformed/`correct:false`/non-zero-exit cases; a
  fixture repo where `avo score --json | jq -e '.correct == false'` passes.

### S2 — `P_t`: lineage `[ ]`
- `avo commit` — atomic: score → compare vs best → on pass, `git commit` with trailers
  `Avo-Version: N` / `Avo-Score: <compact json>`, write `git notes --ref=avo`, render
  `lineage/vNNN.md` (score table, diffstat, agent's rationale from `--why`), print the decision.
  On fail: refuse, explain, exit non-zero.
- `avo lineage [--json]`, `avo lineage show <n>`, `avo lineage diff <a> <b>`, `avo best`.
- Idempotent: re-running `avo commit` with no working-tree change is a no-op, not a duplicate.
- **Verify:** integration test on a throwaway git repo — commit v1, attempt a regression (must be
  refused), commit an improvement (v2), `avo lineage --json | jq 'length == 2'`.

### S3 — beads memory `[ ]`
- `bd init` on `avo init`. `avo mem add "<insight>"` → `bd remember`; `avo mem` → `bd prime`.
- Each committed version gets a bead linked to its parent (`bd dep add`); each *failed* attempt
  gets an insight bead so the agent stops re-trying dead ends across sessions.
- Graceful degradation: if `bd` is absent, fall back to `lineage/memory.jsonl` and warn once.
- **Verify:** `avo mem add` then `avo mem | grep` the insight; lineage beads show correct parent
  chain via `bd show`; the no-`bd` fallback path has a test.

### S4 — `K`: knowledge `[ ]`
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

### S5 — Agent-agnostic skills `[ ]`
- Author the five `SKILL.md` files against the **agentskills.io spec** (valid frontmatter: `name`,
  `description`; progressive disclosure; relative paths to scripts).
- `avo install --agent pi|claude|codex|all` — wires discovery without copying:
  - Pi: `.agents/skills/` is discovered natively; also write `.pi/settings.json`
    (`skills`, `defaultTools`).
  - Claude Code: symlink `.claude/skills` → `.agents/skills`.
  - Codex: append the beads/avo snippet to `AGENTS.md` (idempotent, marker-delimited).
- `AGENTS.md` at repo root: the always-on rules (use `avo`, use `bd`, never markdown TODOs).
- **Verify:** a validator test asserting every `SKILL.md` parses and has a non-empty description;
  `avo install --agent all` twice produces no diff on the second run (idempotency).

### S6 — Concurrency: `avo fan` `[ ]`
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

### S7 — Supervisor + continuous loop `[ ]`
- `avo supervise [--json]` — reads lineage + attempt log, detects:
  (a) **stall**: ≥N attempts with no committed improvement; (b) **thrash**: repeated
  failing edits touching the same region. Emits a steering directive that cites specific prior
  versions and unexplored directions drawn from `K` and the beads insight beads.
- `avo run` — the continuous evolution driver: prompt → agent turn → `avo score`/`avo commit` →
  `avo supervise` → inject directive if triggered → repeat. Replaces the hand-rolled `ralph.sh`
  polling for the AVO loop specifically (`ralph.sh` stays as the *meta* loop building `avocode`).
- Every intervention is logged (lineage + bead) so the trajectory is auditable — the paper's 7-day
  run is only interpretable because interventions are recorded.
- **Verify:** unit tests driving the detector off synthetic lineage fixtures (stall fires at exactly
  N, resets on improvement, thrash fires on repeated same-file failures); `avo run --dry-run
  --max-iters 3` against the stub agent produces the expected transcript.

### S8 — Pi implementation `[ ]`
- `pi/extensions/avo/index.ts` — `pi.registerTool` for `avo_score`, `avo_commit`, `avo_lineage`,
  `avo_know_query`, `avo_know_add`, `avo_fan`. Thin wrappers over `src/`; typebox schemas; use
  `promptSnippet`/`promptGuidelines` so they land in the system prompt properly. Persist state in
  `tool_result.details` (docs are explicit: required for correct session branching).
- `pi/extensions/avo-supervisor/index.ts` — subscribe to `tool_result`; on `avo_score`/`avo_commit`
  update running state; on trigger call `avo supervise` and `pi.sendMessage(directive)`;
  `ctx.ui.setStatus("avo", "v12 · 1668 TFLOPS · 3 since best")` for a live footer;
  `ctx.ui.notify` on a new best. Close resources in `session_shutdown`, not the factory.
- `pi.registerProvider` / `pi.setModel` used only to pin `AVO_PROBE_MODEL` for fan-out; the main
  session model is the user's choice.
- **Verify:** an SDK-driven test (`createAgentSession` + `SessionManager.inMemory()` +
  `tools: [...]`) that scripts a stalling sequence and asserts the steering message is injected
  exactly once; extension loads cleanly under `pi --mode json` in the fixture repo.

### S9 — End-to-end validation `[ ]`
- One real optimization target with a real `.avo/score` (candidate: a hot function in a small
  benchmark repo scored by `hyperfine`, correctness by its own test suite). Not CUDA — we are
  validating the harness, not chasing FlashAttention.
- Seed `K` with the relevant docs via `avo know add`, run `avo run` for a bounded budget.
- Record in `evidence/`: the score curve across versions, the number of supervisor interventions,
  token/cost split between probe (small) and commit (big) models, wall-clock.
- **Verify:** `avo lineage --json` shows a monotonically non-decreasing best score across ≥5
  versions; every committed version reproduces its recorded score on a fresh `avo score`.

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

- **Q1 (S1):** vector `f` — how to reduce `{cfg: score}` to a commit decision? Default: dominate-or-
  tie on all configs. Alternative: weighted mean with a per-config regression floor. Pick one, make
  it configurable, document why.
- **Q2 (S4):** does Firecrawl have a usable free tier? Not stated in its API docs. Determine before
  making it the default; if not, promote `searxng`/`ddgs` to default and Firecrawl to opt-in.
- **Q3 (S7):** stall threshold N — the paper doesn't publish theirs. Start at 5 (the value in
  [avo-pi.md](avo-pi.md)'s sketch), make it configurable, tune with S9 evidence.
- **Q4 (S7):** if the loop proves fragile across days, adopt **absurd** (Postgres durable execution)
  for checkpointing rather than growing our own resume logic.
