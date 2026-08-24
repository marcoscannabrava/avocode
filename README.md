# avocode

An [AVO](avo-paper.md)-inspired agent harness. AVO replaces classical evolutionary variation
operators with an autonomous coding agent — `Vary(P_t) = Agent(P_t, K, f)`. `avocode` extracts that
harness and makes it general and agent-agnostic.

See [PLAN.md](PLAN.md) for the architecture, the slice order, and the invariants.

## Status

S0 (skeleton + health check), S1 (`f` — scoring), S2 (`P_t` — lineage), S3 (memory), S4 (`K` —
knowledge), S5 (agent-agnostic skills) and S6 (concurrency) are done, and S7's detector
(`avo supervise`) with it. `avo init`, `avo install`, `avo doctor`, `avo score`, `avo commit`,
`avo lineage`, `avo best`, `avo mem`, `avo know`, `avo fan` and `avo supervise` work, and the five
skills in `.agents/skills/` are wired for `pi`, Claude Code and Codex. `avo run` — the continuous
driver that calls the supervisor between agent turns — is the rest of S7.

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
shell loop, and `avo run` (the rest of S7) will use the same two codes.

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
| pi | nothing to install — project `.agents/skills/` is discovered natively. `.pi/settings.json` gets `defaultTools` (including `bash`) and `enableSkillCommands` | `avo`, `bd` and `qmd` are CLIs; an agent without `bash` cannot drive any of them |
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

## `avo doctor`

`avo doctor` exits 1 when a required dependency (`git`, `jq`) is missing, or when no coding agent
(`pi`, `claude`, `codex`) is on `PATH` — one is required to act as the variation operator. Optional
dependencies (`qmd`, `ddgs`, `bd`, `hyperfine`, `just`) are reported but never fail the check; each slice
that needs one degrades with a named fallback. API keys are reported as present/unset only — their
values never appear in any output.

## Tasks

| Command | What it does |
| --- | --- |
| `just check` | lint + typecheck + test — the health check every Ralph cycle runs first |
| `just e2e` | exercises the real `bin/avo`; writes `evidence/s{0,1,2,3,4,5,6,7}-e2e.txt` |
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
src/agents.ts     headless agent command templates: pi | claude | codex | custom
src/fan.ts        avo fan — worktrees, probes, the four guards, promote and resume
src/supervise.ts  avo supervise — the stall/thrash detector and the directive it cites with
src/io.ts         injectable output sink, so commands are unit-testable
.agents/skills/   THE agent-agnostic layer: avo-vary, avo-score, avo-lineage, avo-knowledge,
                  avo-fanout
AGENTS.md         the always-on rules + the skills index (managed block, hand edits preserved)
templates/score/  reference scorers + the authoring guide
test/             node:test unit tests + e2e{,-score,-lineage,-mem,-know,-install,-fan,
                  -supervise}.sh
evidence/         artifacts proving user-facing behavior works end to end
```

`ralph.sh` is the meta loop that builds this repo; it is not part of `avo` itself.
