# Command reference

Every `avo` subcommand, what it guarantees, and the reasoning behind the parts that look arbitrary.

**Two rules hold across all of them:** every subcommand supports `--json` (agents parse, humans
read the pretty form), and a missing optional dependency degrades to a named fallback with one
warning rather than crashing.

| Command | One line |
| --- | --- |
| [`avo init`](#avo-init) | scaffold `.avo/`, `knowledge/`, `lineage/` in a repo |
| [`avo score`](#avo-score--the-f-contract) | run `f`, validate it, record the attempt |
| [`avo commit`](#avo-commit--the-commit-rule) | the only writer of a version |
| [`avo lineage` / `avo best`](#avo-lineage-and-avo-best--reading-p_t) | read `P_t` |
| [`avo mem`](#avo-mem--what-the-loop-remembers) | insights, versions and dead ends |
| [`avo know`](#avo-know--k-the-knowledge-base) | search and grow `K` |
| [`avo fan`](#avo-fan--n-directions-at-once) | N worktrees, N probes, one promoted |
| [`avo supervise`](#avo-supervise--stall-and-thrash-detection) | is the loop still making progress? |
| [`avo run`](#avo-run--the-continuous-loop) | turn → commit → supervise → steer, repeat |
| [`avo install`](agents.md) | wire an agent to avo's skills — see [agents.md](agents.md) |
| [`avo doctor`](#avo-doctor) | dependency and API-key status |

---

## `avo init`

Scaffolds `.avo/config.json`, `.avo/.gitignore` (the trajectory exclusion), `knowledge/`, `lineage/`,
the qmd collections when `qmd` is installed, and a beads database when `bd` is. Every step reports `created` / `unchanged` / `skipped`, and a
second run creates nothing (invariant 5); an edited config is never overwritten. `--scorer <t>`
also scaffolds `.avo/score`, `--prefix <p>` sets the beads issue prefix. Outside a git repository it
refuses and writes nothing: the lineage lives in git.

One side effect worth knowing: `bd init` makes a git commit of its own config files. avo runs it with
`--skip-agents` (`AGENTS.md` belongs to `avo install`, S5) and `--skip-hooks` (a git hook that writes
during `avo commit` would dirty the tree the commit rule reasons about).

## `avo score` — the `f` contract

`f` is the only thing that tells the agent whether a variation was an improvement, so its contract
is frozen: `.avo/score` is any executable printing one JSON line, and it always exits 0 — a build
error or a failed test is a *result*, and the agent can only act on it as data. See
[templates/score/README.md](../templates/score/README.md) for the full authoring guide and
[PLAN.md](../PLAN.md) §3 for the contract itself.

`avo score` validates that line, names the offending field when it is wrong, normalizes it into an
**attempt** (`primary` flipped so higher is always better; `null` when the candidate fails), and
appends it to `.avo/attempts.jsonl`. Attempts are not commits — that gate is `avo commit`.

| Flag | |
| --- | --- |
| `--json` | the normalized attempt as one line |
| `--parallel` | fan configs out concurrently, if the scorer implements `--configs` |
| `--timeout <s>` | kill the scorer — and its children — after s seconds |
| `--init <t>` | scaffold `.avo/score` from a template; idempotent, never clobbers an edit |
| `--no-record` | skip the attempt log |
| `--cwd <dir>` | treat dir as the repo root |

Exit codes: `0` pass, `1` ran but failed, `2` harness error (no scorer, malformed output, timeout).

## `avo commit` — the commit rule

A new version is persisted **only** when it passes correctness *and* beats the best committed one.
`avo commit` is the only writer of committed lineage: it scores, compares, and either commits or
refuses with a reason specific enough to act on.

```
$ avo commit --why "dropped the padding comment"
avo commit

  scored       8 bytes
  best         v1 (28940fc)
  *            34 -> 8  +76.47%  improved

committed v2 as 219a215 — '*' improved (best: * +76.47%) and nothing regressed
```

The comparison is over the **score vector**, never the scalar `primary`: by default a candidate
commits iff no config regressed and at least one improved, so a large win on one config can never
pay for a regression on another. A config the best version measured but the candidate did not
blocks the commit — you cannot improve by measuring less. Tune it in `.avo/config.json`:

```json
{ "reduce": "mean", "floor": 0.02, "weights": { "b1_s4096": 2 }, "configs": ["b1_s4096", "b8_s1024"] }
```

`floor` is a symmetric relative noise band; `reduce: "mean"` opts into letting configs trade off;
`configs` declares the scorer's config names so `avo score --parallel` skips the discovery probe.

| Flag | |
| --- | --- |
| `--why <text>` | the rationale; lands in the commit body and in `lineage/vNNN.md` |
| `--dry-run` | report the decision, write nothing |
| `--json` `--parallel` `--timeout <s>` `--no-record` `--cwd <dir>` | as for `avo score` |

Exit codes: `0` committed or no-op, `1` refused, `2` harness error. Re-running with no change is a
no-op, never a duplicate.

## `avo lineage` and `avo best` — reading `P_t`

A committed version is a commit carrying `Avo-Version` and `Avo-Score` trailers, plus the full
attempt in `git notes --ref=avo` and a rendered `lineage/vNNN.md` (score table, diffstat,
rationale). Nothing else defines a version, which is what keeps `avo commit` the only writer.

```sh
avo lineage             # the score curve so far
avo lineage show 3      # one version, with its rationale
avo lineage diff 1 3    # score delta and the patch between two versions
avo best --json         # what the next candidate must beat
```

Because the commit rule only admits non-regressions, the lineage is monotone by construction and
`avo best` is simply the highest-numbered version. `lineage/` is plain markdown on purpose: S4
indexes it as a qmd collection so the agent can semantically search its own history.

`.avo/attempts.jsonl` and `.avo/worktrees/` are **trajectory, not lineage** — `avo commit`
gitignores them and keeps them out of every version it writes.

## `avo mem` — what the loop remembers

Memory is how the agent stops re-deriving what it already knows and stops re-trying what already
failed. `avo mem add "<insight>"` remembers one thing; `avo mem` lists everything; `avo mem prime`
prints the session-start context.

`avo commit` writes to memory by itself: a committed version becomes a record linked to its parent
(so the chain of *why* parallels the lineage), and a refused candidate becomes a **dead end**, keyed
by content so re-attempting it updates one record instead of piling up.

Two backends, one shape. With beads (`bd`, npm `@beads/bd`) installed,
insights go to `bd remember`, versions become beads with deterministic ids (`<prefix>-v<N>`) linked
by `bd dep add`, and dead ends become insight beads. Without it — the common case — everything lands
in `lineage/memory.jsonl` with one warning. `avo mem --json` looks the same either way: an agent must
not have to know whether `bd` was installed.

Memory is a cache of *why*, never the source of truth. A memory write that fails is a warning on an
otherwise good commit, and avo's own writes (`lineage/memory.jsonl`, `.avo/.gitignore`) never count
as a working-tree change — otherwise the memory written for v1 would make the next run look like a
candidate the agent never produced.

## `avo know` — `K`, the knowledge base

`K` is what the agent may consult before it varies anything: reference docs in `knowledge/`, and its
own history in `lineage/`. Both are indexed as [qmd](https://github.com/tobilu/qmd) collections, so
"what did I already try about register pressure?" is the same query as "what do the docs say about
it" — the synergy that costs nothing because `avo commit` is already writing `lineage/vNNN.md`.

```sh
avo know init                          # folded into avo init; safe to re-run
avo know add ./notes/tuning.md         # -> knowledge/notes-tuning.md, with provenance frontmatter
avo know add https://example.com/doc   # needs FIRECRAWL_API_KEY (free tier: 1000 credits/month)
avo know query "register pressure"     # hybrid BM25 + vector + local rerank
avo know query "..." --lexical         # BM25 only: no LLM expansion, no rerank, instant
avo know reindex                       # after avo commit writes a new lineage/vNNN.md
avo know search "blackwell occupancy"  # the web; --ingest pipes the pages straight into K
```

Every ingested doc carries `source`, `title`, `fetched-at` and `via` frontmatter: a doc in `K` with
no provenance is a doc the agent cannot re-check. Re-adding identical content is `unchanged`;
differing content is refused until `--force`, so ingest is idempotent.

**qmd is optional, and its absence is the common path.** Without it, `avo know query` answers the
same question by scanning the same files, and returns the identical JSON — same keys, same `Hit`
shape, and a `score` that means the same thing (0..1, higher is better; qmd's own relevance, or term
coverage in the fallback). An agent must not have to know whether qmd was installed.

Two things about qmd worth knowing, both verified against 2.8.3 rather than assumed:

- `qmd embed` only vectorizes documents the index already knows about, so `avo know add` runs
  `qmd update` first. A doc written straight into `lineage/` — which is what `avo commit` does —
  needs `avo know reindex` before qmd can see it.
- `.qmd/` is gitignored. `index.yml` records collection paths as *absolute* paths, so a committed
  index is wrong on every other machine, and `index.sqlite` is a multi-megabyte binary.

Web search has three backends behind one flag. `firecrawl` (`FIRECRAWL_API_KEY`) is the default
because it is the only one that returns page content, which is what `--ingest` needs; `searxng`
(`SEARXNG_URL`, instance must enable `format=json`) and `ddgs` (keyless, `pip install ddgs`) return
links and snippets. With nothing configured, `avo know search` names all three and how to enable
them — it never throws a stack trace at the agent.

## `avo fan` — N directions at once

One variation step, N independent attempts. Each probe gets its own `git worktree` off `HEAD`, its
own headless agent process, and its own `avo score`. Nothing a probe does can reach your working
tree until you promote one.

```sh
avo fan --n 4 --prompt-file probe.md            # four probes, four worktrees
avo fan --n 3 --prompt "try X, Y or Z" --json   # the JSON is what an agent reads
avo fan --agent pi --model groq/llama-3.3-70b   # the agent, and the probe model
avo fan --timeout 300                           # kill a probe's process group after 300s
```

Each probe comes back as `{i, ok, score, diffstat, summary, worktree, tokens, cost_usd, wall_s,
log_path}` — `tokens` and `cost_usd` as described under [`avo run`](#avo-run--the-continuous-loop),
which is what prices the small-model question (#35).
`ok` describes the *process*, `score` describes the *candidate* — a probe can finish cleanly and
still fail `f`. `best` names the highest-scoring probe that passed; it is a hint, never a decision.

```sh
avo fan --promote 2 --run <id>   # apply that probe's diff to the working tree — and stop
avo score                        # verify it in the real tree
avo commit --why "…"             # the only thing that writes a version (invariant 1)
```

Probes are meant to run on a **small model** (`$AVO_PROBE_MODEL` — Groq, Cerebras, Haiku): N cheap
probes tell you which direction is worth the expensive model. Exploration is a small-model job.

Four guards, all from `pi-subagent`'s pattern, because a probe is itself an agent that can call
`avo fan`:

| Guard | Default | What happens |
| --- | --- | --- |
| depth | `AVO_FAN_DEPTH=3` | a probe at the limit is refused (exit 1) and must do the work itself |
| cycles | — | a prompt already in the chain (`AVO_FAN_CHAIN`) is refused |
| concurrency | `min(8, cpus-2)` | `--n 20` is allowed; the rest queue |
| timeout | `--timeout 900` | the probe's whole process group is killed, benchmarks included |

Each built-in agent template carries the flag that stops it asking a human for permission —
`pi --approve`, `claude --permission-mode bypassPermissions`, `codex --sandbox workspace-write`.
Without them a headless probe reads and never writes, and exits 0 having done nothing. `avo fan`
reports which one it used in `approval`. Drive something else by declaring it in `.avo/config.json`:

```json
{"agent": {"name": "myagent", "command": "my-cli", "args": ["--headless", "--model={model}", "{prompt}"]}}
```

Everything lives under `.avo/worktrees/<run-id>/`, which is gitignored trajectory. Worktrees no
probe changed are removed automatically; changed ones stay, because they are the only copy of that
work. `avo fan --list`, `--clean <id|all>`, and `--resume <id>` — the run manifest is rewritten
after every probe, so a killed fan-out resumes from what it had.

## `avo supervise` — stall and thrash detection

A variation operator with no supervisor plateaus and keeps plateauing: from inside one turn, an
agent re-deriving an idea it already tried looks exactly like an agent making progress. `avo
supervise` reads the lineage and `.avo/attempts.jsonl` — nothing it does not already record — and
fires on the two things one turn cannot see:

| Signal | Fires when | Default | Why that is the signal |
| --- | --- | --- | --- |
| `stall` | N attempts since the last committed improvement | 5 | `P_t` is monotone, so the newest version *is* the last improvement. An attempt that passed `f` and still did not beat it counts: it did not move `P_t` |
| `thrash` | K consecutive attempts failed *the same way* | 3 | the same error K times means the diagnosis is wrong, not the edit |

```bash
avo supervise                       # 0 = still making progress, 1 = a directive was emitted, 2 = usage
avo supervise --json | jq -r .directive
avo supervise --stall 3 --thrash 2  # or set supervise.stall / supervise.thrash in .avo/config.json
```

Thresholds belong in `.avo/config.json` because they are repo policy: a scorer that takes an hour
wants a smaller `stall` than one that takes a second. A flag overrides it.

The exit code is the interface — `avo supervise || inject_directive` is the whole integration for a
shell loop, and `avo run` reads the same two codes between turns.

**The directive cites.** "Try something else" is worthless: the agent already believes it is trying
something else. So the directive names prior versions with their scores and rationales, the dead ends
memory holds, and the docs in `K` that no version has ever mentioned — that last list is computed by
matching each doc's title against every `--why` and every memory, so a doc appears precisely because
nothing in the lineage talks about it. This is what S3 and S4 were for: without a lineage and a
knowledge base there is nothing concrete to cite.

Which attempts count as "since the best version" is decided by the sha each attempt recorded, not by
its clock: an attempt scored *on top of* v3 carries v3's sha, while the attempt that *became* v3 was
scored before that commit existed. Timestamps cannot do it — git truncates author dates to the
second, so with a fast scorer the two are indistinguishable by time.

`avo supervise` only ever reads. It writes nothing, moves nothing, and leaves the working tree
byte-identical, because a supervisor that dirtied the tree would make the harness's own output part
of the next candidate's diff.

## `avo run` — the continuous loop

`avo fan` explores; `avo run` *exploits*. One prompt, N iterations of **agent turn → `avo commit` →
`avo supervise` → inject the directive**, in the root working tree rather than in a worktree — this
is the case where uncommitted work is the point rather than a hazard.

```bash
avo run --prompt-file task.md --max-iters 20
avo run --prompt "make the tokenizer faster without changing its output" --max-iters 5 --json
avo run --prompt-file task.md --dry-run      # the resolved plan and the first turn prompt; spawns nothing
avo run --prompt-file task.md --stall 3 --thrash 2 --timeout 600 --agent claude --model opus
```

**Every iteration is a fresh process.** Nothing from the previous turn is in the agent's context, so
the turn prompt is the only continuity there is: after the first, each one carries the operator's
task *plus* what the last iteration decided, plus the steering directive when one fired. The task is
never replaced by the directive — an agent told only "you are stalling" has lost the problem.

**Every intervention is written down.** The paper's seven-day run is only interpretable because the
interventions are recorded, so each injected directive becomes a labelled bead (`bd create -l
avo,avo-intervention`) or a `lineage/memory.jsonl` record. Deliberately *not* an insight: insights
are injected at prime time, and every future session would then open with a stale "you are stalling,
read v3" from a run that ended days ago.

| It stops when | Because |
| --- | --- |
| `--max-iters` is reached | the budget is the operator's, not the agent's |
| `.avo/STOP` exists | the one command meant to run for days needs a brake that does not require finding the process — and one an agent can reach when the task is genuinely done |
| 3 iterations in a row change nothing **and leave HEAD where it was** | an unchanged tree is never scored, so it records no attempt and the supervisor *cannot* see it. This is the one stop condition steering cannot express |
| the agent binary cannot be started | it will not start on the next iteration either; retrying it nine more times is spinning |

**The agent usually commits for itself, and the manifest says so.** The `avo-vary` skill — which
`avo install` wires into the target, and which the turn prompt points at — has the agent run
`avo commit --why "..."` before its turn ends. So by the time the loop's own step 2 looks, the tree
is clean and the decision is honestly `noop`. Each iteration therefore also records
`agent_versions`: the versions that appeared between `head_before` and `head_after`, read back from
their `Avo-Version` trailers, minus the one step 2 committed itself. They count toward
`committed`, they are named in the next turn's prompt, and they do not count as no-ops. Without
this a run that produced a curve reads as a flat one, and three well-behaved turns in a row look
exactly like three idle ones (#42). A commit *without* the trailers moves HEAD but is not a
version — invariant 1 says `avo commit` is the only writer.

**What a turn cost is read off the agent, not re-derived.** Each iteration records
`tokens: {input, output, cache_read, cache_write}` and `cost_usd`, and the run totals both. The four
token counts are **disjoint** — total input sent is `input + cache_read + cache_write` — because
cached input is priced at roughly a tenth of uncached, so folding them together destroys the only
thing the numbers are collected for. `input` is normalized to mean *uncached* for every agent: pi
and claude already report it that way, while codex follows OpenAI, where `cached_input_tokens` is a
subset of `input_tokens` and is subtracted back out. `cost_usd` is whatever the agent itself
reported (claude's `total_cost_usd`, pi's `usage.cost`) rather than token arithmetic we would have
to keep in step with per-model rates; it is `null`, not `0`, when the agent reports none — nothing
measured and nothing spent are different facts, and a cost budget has to refuse the first (#28).

Before this, the manifest of a real six-iteration run reported **44 input tokens for a loop that
sent 985,039**, and no cost at all: `cache_read_input_tokens` was dropped on the floor, and four of
the six turns lost their closing `result` event to an output cap that kept only the *first* 200KB —
so the summary, the usage and the cost all went with it. The cap now spends 50KB of its budget on a
rolling tail and marks the gap it elides, because in every stream `avo` reads, the payload is the
last thing printed (#43, #22; `evidence/issue-43-replay.txt`, reproducible with
`npx tsx bench/replay-tokens.ts <repo>/.avo/runs/<id>`).

**A turn's rationale is what the agent *said*, and silence is recorded as silence.** The final
message becomes `avo commit --why`, which lands in the commit body, `lineage/vNNN.md` and
`memory.jsonl` — all permanent, and the last of them replayed to later turns as a known dead end.
So a structured stream that never produced a parseable result falls back to the agent's last
*message*, then to any prose it printed on the way down (`fatal: out of credits` explains a turn;
keep it), and then to nothing. It never falls back to the last line on the wire: in a stream-json
stdout every line is a protocol event, and a run once recorded
`{"type":"system","subtype":"thinking_tokens",…}` as a dead end's rationale (#49). A turn that said
nothing commits with no rationale and warns, in the manifest and in the rendered run, because an
unexplained version is worth noticing — it usually means the turn was killed or timed out.

The run manifest at `.avo/runs/<id>/manifest.json` is rewritten after **every** iteration, never at
the end, and each turn's raw agent output is kept beside it under `logs/`. A loop meant to run for
days will be killed at some point, and the difference between per-iteration and at-exit is the
difference between a recoverable record and nothing at all. `.avo/runs/` is trajectory, not lineage:
it is in `TRAJECTORY_PATHS` and gitignored, so the record of *how* a version was reached never lands
inside the version.

`avo run` carries the same four guards as `avo fan`, on the same budget (`AVO_FAN_DEPTH`,
`AVO_FAN_LEVEL`, `AVO_FAN_CHAIN`), because a turn is itself an agent that can call `avo run` — and a
loop inside a loop is the same exponential hazard as a fan-out inside one. A guard is a refusal
(exit 1), not a harness error.


## `avo doctor`

`avo doctor` exits 1 when a required dependency (`git`, `jq`) is missing, or when no coding agent
(`pi`, `claude`, `codex`) is on `PATH` — one is required to act as the variation operator. Optional
dependencies (`qmd`, `ddgs`, `bd`, `hyperfine`, `just`) are reported but never fail the check; each slice
that needs one degrades with a named fallback. API keys are reported as present/unset only — their
values never appear in any output.


Full dependency table, including what each optional one degrades to:
[install.md](install.md).
