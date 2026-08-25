# avocode

An [AVO](avo-paper.md)-inspired agent harness. AVO replaces classical evolutionary variation
operators with an autonomous coding agent — `Vary(P_t) = Agent(P_t, K, f)`. `avocode` extracts that
harness and makes it general and agent-agnostic.

See [PLAN.md](PLAN.md) for the architecture, the slice order, and the invariants.

## Status

S0 (skeleton + health check), S1 (`f` — scoring), S2 (`P_t` — lineage), S3 (memory), S4 (`K` —
knowledge), S5 (agent-agnostic skills), S6 (concurrency), S7 (supervisor + continuous loop) and S8
(the Pi implementation) are done. `avo init`, `avo install`, `avo doctor`, `avo score`,
`avo commit`, `avo lineage`, `avo best`, `avo mem`, `avo know`, `avo fan`, `avo supervise` and
`avo run` work; the five skills in `.agents/skills/` are wired for `pi`, Claude Code and Codex; and
a `pi` session in a wired repo gets `avo_score`, `avo_commit`, `avo_lineage`, `avo_know_query`,
`avo_know_add` and `avo_fan` as native tools, plus an `avo-supervisor` extension that steers a
stalling session from inside it. S9a is done: `bench/fuzzysearch` is a real optimization target with
a real `f`, and a scripted optimizer walking it commits six versions for a 385x speedup. S9b-1 is
done too: `avo run --agent claude` on that target commits four versions for **5255x** in 35 minutes,
one of them a technique the hand-written ladder does not contain. Next is S9b-2 — the same target
under `pi`, to find out whether the native supervisor earns its complexity.

## Quickstart

```sh
npm install
just check          # lint + typecheck + test
./bin/avo doctor    # dependency and API-key status

cd /your/repo
avo init                     # .avo/, lineage/, beads — safe to re-run
avo install                  # wire avo's skills + AGENTS.md for pi | claude | codex
avo score --init hyperfine   # scaffold .avo/score (or: pytest, vitest)
avo score                    # run it
avo score --json | jq .      # the normalized attempt an agent reads

# ...now change something, and let the commit rule decide whether it was progress
avo commit --why "hoisted the bounds check out of the loop"
avo lineage                  # P_t so far
avo best --json              # what the next candidate must beat
avo mem                      # what the loop learned, including the dead ends

# explore several directions at once, one worktree and one small-model agent each
avo fan --n 4 --prompt-file probe.md --json
avo fan --promote 2          # bring the winner into the working tree, then score and commit it

# is the loop still making progress? exit 1 means it printed a directive to follow
avo supervise
avo supervise --json | jq -r .directive

# or hand the whole loop over: turn -> commit -> supervise -> steer -> repeat
avo run --prompt-file task.md --max-iters 20 --dry-run   # what it would do, spawning nothing
avo run --prompt-file task.md --max-iters 20
touch .avo/STOP              # stops it before the next turn, from anywhere

# K — what the agent may consult before it varies anything
avo know add ./docs/tuning.md          # or a url, with FIRECRAWL_API_KEY set
avo know query "register pressure"     # hybrid search over knowledge/ and lineage/
avo know search "blackwell occupancy"  # the web; --ingest writes the pages into K
```

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
[templates/score/README.md](templates/score/README.md) for the full authoring guide and
[PLAN.md](PLAN.md) §3 for the contract itself.

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

Each probe comes back as `{i, ok, score, diffstat, summary, worktree, tokens, wall_s, log_path}`.
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
| 3 iterations in a row change nothing | an unchanged tree is never scored, so it records no attempt and the supervisor *cannot* see it. This is the one stop condition steering cannot express |
| the agent binary cannot be started | it will not start on the next iteration either; retrying it nine more times is spinning |

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

## `avo install` — the agent-agnostic layer

The skills are the layer that makes `avo` agent-agnostic. They live in `.agents/skills/`, the
[Agent Skills](https://agentskills.io/specification) shared location, and `avo install` wires each
agent's discovery to them **without copying** — one source of truth, no drift.

```bash
avo install                        # all three agents (the default)
avo install --agent pi             # or one; repeatable, and --agent pi,codex works too
avo install --agent all --json
avo install --force                # replace a symlink or file in the way
```

| Skill | Read it when |
| --- | --- |
| `avo-vary` | performing one variation step: read the past, change the code, score it, commit it |
| `avo-score` | authoring or repairing `.avo/score`; the frozen `f` contract |
| `avo-lineage` | reading `P_t`, or understanding why a candidate was refused |
| `avo-knowledge` | searching `K` and growing it from the web |
| `avo-fanout` | exploring several directions at once when reading cannot tell you which is best |

What each agent gets:

| Agent | Wiring | Why |
| --- | --- | --- |
| pi | project `.agents/skills/` is discovered natively, so only two things are wired: `.pi/settings.json` gets `defaultTools` (including `bash`) and `enableSkillCommands`, and `.pi/extensions/{avo,avo-supervisor}` are linked at the native tools and the in-session supervisor | `avo`, `bd` and `qmd` are CLIs; an agent without `bash` cannot drive any of them. The extension is a shortcut past `bash`, not a capability the others lack |
| claude | `.claude/skills` → `.agents/skills`, one directory symlink | a skill added later needs no re-install |
| codex | the `AGENTS.md` skills index | Codex has no skill-discovery mechanism; naming the files *is* the wiring |

`AGENTS.md` is written for every agent, not just Codex: it carries the rules that hold whether or
not a skill was loaded (`avo commit` is the only writer of a version; measure before you claim;
`bd` for task state, never markdown TODO lists). Only the block between
`<!-- BEGIN avo -->` and `<!-- END avo -->` belongs to `avo install` — anything you write outside it
survives every re-run, and an `AGENTS.md` that already exists is appended to, never rewritten.

**One trap worth knowing:** pi ignores project-local skills and settings until the project is
trusted, and headless runs (`-p`, `--mode json`) never prompt. Pass `--approve`, run `pi` once
interactively and answer the prompt, or set `defaultProjectTrust: "always"` in
`~/.pi/agent/settings.json` — otherwise an installed harness silently does nothing in exactly the
mode `avo fan` will drive it in. `avo install` says so every time it wires pi.

`avo install` never deletes anything. A real directory in the way is reported and left alone: an
existing `.claude/skills` full of your own skills gets avo's linked *inside* it instead. A symlink
or file in the way needs `--force`.

## The native `pi` extensions — the same commands, one process closer

Every capability is reachable from `bash` first (invariant 8); the extensions are *bindings*, not new
behaviour. `avo install --agent pi` links `.pi/extensions/avo` and `.pi/extensions/avo-supervisor`
at avocode's `pi/extensions/`, which is where pi discovers a project-local extension. Two, not one,
because they are useful apart: the tools without the supervisor is a session that steers itself, and
an operator already running `avo run` wants exactly that.

A pi session in that repo gets six tools:

| Tool | Wraps | Notes |
| --- | --- | --- |
| `avo_score` | `avo score` | measures the working tree; records the attempt the supervisor reads |
| `avo_commit` | `avo commit` | the only writer of a version. `why` is **required** here |
| `avo_lineage` | `avo lineage` / `avo best` | the table, or one version in full with its rationale |
| `avo_know_query` | `avo know query` | hybrid search over `K` and the rendered lineage |
| `avo_know_add` | `avo know add` | ingest a URL or file into `K` with provenance |
| `avo_fan` | `avo fan` | N worktrees, N small-model probes, each scored |

Three rules the tools follow, each for a reason worth keeping:

- **A refusal is not an error.** Pi flags a tool result as failed only when `execute` throws, so
  only a *harness* error throws — no scorer, malformed output, a guard refusal. `avo_commit`
  declining a candidate comes back as an ordinary result, because it is a measurement the model is
  meant to read and act on. Same split as the CLI's exit codes (2 = harness error, 1 = refused).
- **`details` is always populated.** Pi rebuilds extension state from tool-result details when a
  session branches, so every tool returns the CLI's structured result there and the CLI's own
  rendering in `content` — the model reads exactly what a human reads.
- **The repo comes from the session, never from the model.** No tool takes a `cwd`: an agent that
  can retarget the repo can write a version into a repo nobody is watching.

### `avo-supervisor` — S7's steering, inside the session

`avo run` supervises by polling: turn, `avo commit`, `avo supervise`, splice the directive into the
next prompt. That works for any agent and costs a process per check. The supervisor extension does
the same thing natively — it subscribes to `tool_result`, and on `avo_score` or `avo_commit` (the
only two that can move a counter; `avo_fan` scores in disposable worktrees) it calls the same
`supervise()` the CLI calls and injects the directive with `pi.sendMessage`. A live footer reads
`v12 · 1668 TFLOPS · 3 since best`, and a landed version is announced.

- **It counts the attempt log, not the session.** State comes from `.avo/attempts.jsonl` and the git
  lineage every time, so an operator running `avo run` in one terminal and `pi` in another cannot be
  steered twice for one stall by two counters that drifted.
- **One episode, one directive.** A stall is named by the best version it is stuck under; a thrash by
  its failure signature and where the streak began. Re-injecting the same advice on every attempt
  burns context and teaches the model to skim the one message meant to change its mind. A *new* best,
  or a thrash appearing during a stall, is new information and does steer.
- **A branch that never saw the directive still gets one.** The answered episodes are reconstructed
  from the injected messages on the current branch, so branching rewinds the supervisor with the
  conversation.
- **It re-implements nothing.** No commit rule, no thresholds, no directive text: `.avo/config.json`
  decides `stall` and `thrash` exactly as it does for the CLI. Every steer is also written down as an
  intervention memory, the same record `avo run` leaves.

The same trust rule applies as for skills — pi ignores a project-local extension until the project
is trusted, and headless runs never prompt. `--approve` or `defaultProjectTrust: "always"`.

Nothing is lost without it: `claude` and `codex` reach every one of these through `bash avo ...`.

## `bench/` — a real target to point the loop at

Everything above is bookkeeping around `f`. `bench/` holds an actual optimization problem with an
actual `f`, so the loop can be judged on a curve rather than on unit tests.

```sh
./bench/init.sh ~/work/fuzzysearch     # materialize the target into its OWN git repo
avo init --cwd ~/work/fuzzysearch      # K, memory, .avo/.gitignore (config + scorer come with it)
cd ~/work/fuzzysearch && .avo/score | jq .
```

```json
{"ok":true,"correct":true,"primary":356.0,"unit":"ms","higher_is_better":false,
 "scores":{"small":155.7,"large":556.4}}
```

**`fuzzysearch`** is thresholded edit-distance retrieval: every `(query, word)` pair in a seeded
pseudo-lexicon within Levenshtein distance `k`. `src/search.js` is the candidate — correct, and a
full DP matrix built out of nested arrays. Everything else is `f`. Two configs, not one, so the
commit rule compares a score *vector* and a change that only helps the small corpus has to prove it
does not hurt the large one.

**Its own repo, never this one.** `avo commit` writes `Avo-Version` commits into the repo it is
pointed at, so a target living inside this checkout would put the loop's entire lineage into
avocode's history and score a tree the loop is also editing. `bench/init.sh` refuses a destination
inside avocode outright.

### `correct` is three gates

| Gate | Catches |
| --- | --- |
| `.avo/gate.sha256` | the scorer, the reference, the corpus and the suite are byte-identical to the template |
| `node --test test/` | edge cases: empty inputs, `k=0`, exact distances, unicode, duplicates |
| `bench/run.js` | the candidate still matches an independent reference **on the input it is timed on**, and did not mutate its arguments |

The third is the expensive one — it runs the naive reference on every score — and it is the one that
earns its keep. `test/e2e-bench.sh` ships a candidate that passes the *entire* unit suite and
returns `[]` for any corpus over 1000 words; only gate 3 sees it. A unit suite runs on small
fixtures, so without a full-scale check, special-casing those fixtures buys a real score.

The hash gate is deliberately not oversold: it covers `.avo/score` itself, but an agent that edits
the scorer *and* the hash file defeats it from inside. `./bench/init.sh --verify <dest>` is the
external audit that does not, and it is the last thing to run after any loop:

```sh
./bench/init.sh --verify ~/work/fuzzysearch    # exit 1 if f was edited — the curve means nothing
```

### Headroom

A target with no room to improve proves nothing about the harness. `test/fixtures/fuzzysearch/`
holds six hand-written candidates along a known path — rolling `Int32Array` DP, a length prefilter,
prefix/suffix trimming, Ukkonen's band with a row-minimum early exit, a length-bucketed index, a
letter-set bitmask filter — and `test/e2e-bench.sh` replays them through `avo score` and
`avo commit`:

```
v1 -> v001  primary 144.3ms         v4 -> v004  primary 16.6ms
v2 -> v002  primary 70.4ms          v5 -> v005  primary 13.7ms
v3 -> v003  primary 69.2ms          v6 -> v006  primary 0.92ms

6 committed, 0 refused, of 6 steps       headroom walked: 356.0ms -> 0.92ms = 385.5x
```

Six committed versions, best score monotonically non-decreasing, and every recorded score
reproduces from its own commit within 3.2%. So when an agent's curve on this target comes out flat,
the target is not what is wrong.

### An agent on it

`bench/verify-run.sh <target-repo> [run-id]` turns a finished `avo run` into evidence: the curve
from `avo lineage`, the manifest's interventions and wall-clock, every recorded score re-measured
from its own commit, and `bench/init.sh --verify` last, because if `f` was edited the curve means
nothing.

```sh
PATH="$PWD/bin:$PATH" avo run --cwd ~/work/fuzzysearch --agent claude \
  --prompt-file task.md --max-iters 12 --timeout 900
./bench/verify-run.sh ~/work/fuzzysearch      # -> evidence/s9b-run.txt
```

(The `PATH` prefix is not optional and nothing else supplies it — the wired skills all begin with
`avo ...`. See [#41](https://github.com/marcoscannabrava/avocode/issues/41).)

`evidence/s9b-run.txt` is one such run: 6 iterations, 34m43s, four committed versions,
1810.4ms -> 0.345ms = **5255x**, zero supervisor interventions, `f` intact. Its third version is the
interesting one — a pigeonhole partition index that is *not* one of the six hand-written steps
below, reached by citing K's note that bucketing generalizes to any discrete filter key.

They live in `test/fixtures/`, not in `bench/fuzzysearch/` — `bench/init.sh` materializes every file
in the template directory, and a ladder stored there would hand the optimizer the answer.

Matmul was the first candidate and lost on measurement: flat `Float64Array`, i-k-j order, a
transposed operand, 64x64 tiling and a 2x-unrolled micro-kernel come to **1.7x** total, with most
steps inside the noise, because V8's JIT already does that work. A curve on that target would have
shown only that the commit rule refuses things.

## `avo doctor`

`avo doctor` exits 1 when a required dependency (`git`, `jq`) is missing, or when no coding agent
(`pi`, `claude`, `codex`) is on `PATH` — one is required to act as the variation operator. Optional
dependencies (`qmd`, `ddgs`, `bd`, `hyperfine`, `just`) are reported but never fail the check; each slice
that needs one degrades with a named fallback. API keys are reported as present/unset only — their
values never appear in any output.

## Tasks

| Command | What it does |
| --- | --- |
| `just check` | lint + typecheck + test + `ralph-test` — the health check every Ralph cycle runs first |
| `just ralph-test` | drives `ralph.sh` against a stub agent in a throwaway repo (2s) |
| `just e2e` | exercises the real `bin/avo`; writes `evidence/s{0,1,2,3,4,5,6,7,7b,8,9a}-e2e.txt` |
| `just all` | `check` + `e2e` |
| `just doctor` | `./bin/avo doctor` |

## Layout

```
bin/avo           entrypoint; runs src/main.ts through tsx (no build step)
src/cli.ts        subcommand dispatcher
src/doctor.ts     dependency + API-key report
src/score.ts      f — run, validate and normalize .avo/score
src/config.ts     .avo/config.json — the reduction, the floor, declared configs
src/compare.ts    the commit rule's comparator over the score vector
src/lineage.ts    Pt — avo commit, avo lineage, avo best
src/mem.ts        memory — bd (beads) with a lineage/memory.jsonl fallback
src/knowledge.ts  K — qmd collections, a local-scan fallback, ingest with provenance
src/websearch.ts  K — firecrawl | searxng | ddgs behind one injectable Fetcher
src/steps.ts      the created/unchanged/skipped step report init and know init share
src/init.ts       avo init — idempotent scaffolding, including bd init
src/install.ts    avo install — wires pi | claude | codex to .agents/skills without copying
src/skills.ts     the Agent Skills frontmatter parser and spec validator
src/agents.ts     headless agent command templates + driveAgent, one turn as fan and run see it
src/fan.ts        avo fan — worktrees, probes, the four guards, promote and resume
src/supervise.ts  avo supervise — the stall/thrash detector and the directive it cites with
src/run.ts        avo run — the continuous loop, its manifest and the intervention record
src/io.ts         injectable output sink, so commands are unit-testable
pi/extensions/    the native pi bindings: avo/ registers the six tools, avo-supervisor/ steers
.agents/skills/   THE agent-agnostic layer: avo-vary, avo-score, avo-lineage, avo-knowledge,
                  avo-fanout
AGENTS.md         the always-on rules + the skills index (managed block, hand edits preserved)
templates/score/  reference scorers + the authoring guide
bench/init.sh     materializes an optimization target into its own repo; --verify audits f after
bench/verify-run.sh  renders a finished `avo run` into evidence and checks S9's two criteria
bench/fuzzysearch the S9 target: src/search.js is the candidate, everything else is f
test/             node:test unit tests + e2e{,-score,-lineage,-mem,-know,-install,-fan,
                  -supervise,-run,-pi,-bench}.sh, plus pi-{load,drive,supervise-drive}.ts
                  (harnesses, not suites), and fixtures/fuzzysearch/ (the ladder)
evidence/         artifacts proving user-facing behavior works end to end
```

`ralph.sh` is the meta loop that builds this repo; it is not part of `avo` itself.

Ctrl+C stops it, and stopping means the session is *gone*: the loop signals the whole process
tree pid by pid, waits, and escalates to `KILL` if the session ignores the `TERM`. This is not a
nicety. A session that outlives its loop is reparented to init and goes on editing the repo,
which is how two agents end up committing to one working tree — observed, not hypothesized (#33).
The session runs as an async job rather than a foreground pipeline because bash defers trap
handlers until the running foreground command returns, so a foreground session swallows the
interrupt for however long it lasts. `just ralph-test` is what holds all of this in place.
