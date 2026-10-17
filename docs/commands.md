# Command reference

Every `avo` subcommand, its guarantees, and the reasoning behind the parts that look arbitrary.

**Two rules hold everywhere:** every subcommand supports `--json`, and a missing optional dependency
degrades to a named fallback with one warning instead of crashing.

`avo <command> --help` (or `-h`, or `avo help <command>`) prints the options of that command and
exits `0`. It runs nothing else. A `-h` that is the value of a flag, as in `avo commit --why -h`, is
not a help request. Arguments after `--` are not read as help.

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

Scaffolds `.avo/config.json`, `.avo/.gitignore` (the trajectory exclusion), `knowledge/`,
`lineage/`, the qmd collections when `qmd` is installed, and a beads database when `bd` is.

- Every step reports `created` / `unchanged` / `skipped`; a second run creates nothing (invariant 5)
  and never overwrites an edited config.
- `--scorer <t>` also scaffolds `.avo/score`; `--prefix <p>` sets the beads issue prefix.
- Outside a git repository it refuses and writes nothing: the lineage lives in git.

One side effect: `bd init` makes a git commit of its own config files. avo runs it with
`--skip-agents` (`AGENTS.md` belongs to `avo install`) and `--skip-hooks` (a git hook writing during
`avo commit` would dirty the tree the commit rule reasons about).

## `avo score` — the `f` contract

`f` is the only thing that tells the agent whether a variation improved anything, so its contract is
frozen: `.avo/score` is any executable printing one JSON line, and it always exits 0 — a build error
or failed test is a *result* the agent can act on. Full authoring guide:
[templates/score/README.md](../templates/score/README.md).

`avo score` validates that line, names the offending field when it is wrong, normalizes it into an
**attempt** (`primary` flipped so higher is always better; `null` when the candidate fails), and
appends it to `.avo/attempts.jsonl`. Attempts are not commits — that gate is `avo commit`.

Each attempt also records what it scored, in `git`:

| Field | Meaning |
| --- | --- |
| `git.head` | the HEAD commit |
| `git.dirty` | `true` when `git status` shows a change |
| `git.tree` | the hash of the working tree, without the paths avo writes. Two attempts with the same `tree` scored the same candidate. `avo score` uses a temporary index, so your index does not change |
| `git.paths` | the paths that the candidate changes against HEAD, without the paths avo writes. Paths are relative to `--cwd`. When `tree` is `null`, this field is absent |

`avo score` reads these fields before the scorer runs, so files that the scorer writes are not
part of the candidate. Attempt lines from before these two fields still parse. `avo supervise` counts each such line as
one candidate.

| Flag | |
| --- | --- |
| `--json` | the normalized attempt as one line |
| `--parallel` | fan configs out concurrently, if the scorer implements `--configs` |
| `--timeout <s>` | kill the scorer — and its children — after s seconds |
| `--init <t>` | scaffold `.avo/score` from a template; idempotent, never clobbers an edit |
| `--no-record` | skip the attempt log |
| `--cwd <dir>` | treat dir as the repo root |

Exit codes: `0` pass, `1` ran but failed, `2` harness error (no scorer, malformed output, timeout,
configs that disagree on `higher_is_better`).

## `avo commit` — the commit rule

A version is persisted **only** when it passes correctness *and* beats the best committed one.
`avo commit` is the only writer of committed lineage: it scores, compares, and either commits or
refuses with an actionable reason.

```
$ avo commit --why "dropped the padding comment"
avo commit

  scored       8 bytes
  best         v1 (28940fc)
  *            34 -> 8  +76.47%  improved

committed v2 as 219a215 — '*' improved (best: * +76.47%) and nothing regressed
```

The comparison is over the **score vector**, never the scalar `primary`. By default a candidate
commits iff no config regressed and at least one improved, so a large win on one config can never
pay for a regression on another. A config the best version measured but the candidate did not blocks
the commit — you cannot improve by measuring less. Tune it in `.avo/config.json`:

```json
{ "reduce": "mean", "floor": 0.02, "weights": { "b1_s4096": 2 }, "configs": ["b1_s4096", "b8_s1024"] }
```

- `floor` — a symmetric relative noise band.
- `reduce: "mean"` — opts into letting configs trade off.
- `configs` — declares the scorer's config names, so `avo score --parallel` skips the discovery probe.

| Flag | |
| --- | --- |
| `--why <text>` | the rationale; lands in the commit body and in `lineage/vNNN.md` |
| `--dry-run` | report the decision, write nothing |
| `--json` `--parallel` `--timeout <s>` `--no-record` `--cwd <dir>` | as for `avo score` |

Exit codes: `0` committed or no-op, `1` refused, `2` harness error. Re-running with no change is a
no-op, never a duplicate.

Inside an `avo run` turn, `avo commit` also refuses when `f` changed since the run started. `avo run`
gives each turn the start hashes in `AVO_SCORER_HASHES`, and `avo commit` hashes the same files again
before it scores (#38). Outside a run, this variable is not set and there is no check.

With `--json`, `ok` is `true` when the command ran. A refusal is also `ok: true`, because the rule
did its work. Read `action` for the decision: `committed`, `refused`, `noop` or `would-commit`. `ok`
is `false` only on a harness error (exit `2`).

This `ok` is not the scorer's `ok`. A scorer that reports `ok: false` gives a refusal with `ok: true`
here. Read `attempt.ok` for the scorer's value.

## `avo lineage` and `avo best` — reading `P_t`

A committed version is a commit carrying `Avo-Version` and `Avo-Score` trailers, plus the full
attempt in `git notes --ref=avo` and a rendered `lineage/vNNN.md` (score table, diffstat,
rationale). Nothing else defines a version, which keeps `avo commit` the only writer.

```sh
avo lineage             # the score curve so far
avo lineage show 3      # one version, with its rationale
avo lineage diff 1 3    # score delta and the patch between two versions
avo best --json         # what the next candidate must beat
```

Because the commit rule only admits non-regressions, the lineage is monotone by construction and
`avo best` is simply the highest-numbered version. `lineage/` is plain markdown on purpose: it is
indexed as a qmd collection, so the agent can semantically search its own history.

`.avo/attempts.jsonl` and `.avo/worktrees/` are **trajectory, not lineage** — `avo commit`
gitignores them and keeps them out of every version.

## `avo mem` — what the loop remembers

Memory stops the agent re-deriving what it knows and re-trying what already failed.

```sh
avo mem add "<insight>"   # remember one thing
avo mem                   # list everything
avo mem prime             # the session-start context
```

`avo commit` writes to memory itself: a committed version becomes a record linked to its parent (so
the chain of *why* parallels the lineage), and a refused candidate becomes a **dead end**, keyed by
content so re-attempting it updates one record instead of piling up.

Two backends, one shape. With `bd` ([beads](https://www.npmjs.com/package/@beads/bd)) installed,
insights go to `bd remember`, versions become beads with deterministic ids (`<prefix>-v<N>`) linked
by `bd dep add`, and dead ends become insight beads. Without it — the common case — everything lands
in `lineage/memory.jsonl` with one warning. `avo mem --json` looks the same either way: an agent must
not have to know whether `bd` was installed. When a `bd` read of memories is empty, avo reads again
one time. A cold `bd` start can give an empty result one time. If the second read finds memories,
avo shows them with a warning.

Memory is a cache of *why*, never the source of truth. A failed memory write is a warning on an
otherwise good commit, and avo's own writes (`lineage/memory.jsonl`, `.avo/.gitignore`) never count
as a working-tree change — otherwise v1's memory would make the next run look like a candidate the
agent never produced.

## `avo know` — `K`, the knowledge base

`K` is what the agent consults before it varies anything: reference docs in `knowledge/`, and its own
history in `lineage/`. Both are [qmd](https://github.com/tobilu/qmd) collections, so "what did I
already try about register pressure?" is the same query as "what do the docs say about it" — and it
costs nothing extra, because `avo commit` already writes `lineage/vNNN.md`.

```sh
avo know init                          # folded into avo init; safe to re-run
avo know add ./notes/tuning.md         # -> knowledge/tuning.md, with provenance frontmatter
avo know add https://example.com/doc   # needs FIRECRAWL_API_KEY (free tier: 1000 credits/month)
avo know query "register pressure"     # hybrid BM25 + vector + local rerank
avo know query "..." --lexical         # BM25 only: no LLM expansion, no rerank, instant
avo know reindex                       # re-scan both collections; avo commit does it for lineage/
avo know search "blackwell occupancy"  # the web; --ingest pipes the pages straight into K
```

Every ingested doc carries `source`, `title`, `fetched-at` and `via` frontmatter: a doc with no
provenance is one the agent cannot re-check. Re-adding identical content is `unchanged`; differing
content is refused until `--force`, so ingest is idempotent.

**qmd is optional, and its absence is the common path.** Without it, `avo know query` scans the same
files and returns identical JSON — same keys, same `Hit` shape, and a `score` meaning the same thing
(0..1, higher is better; qmd's relevance, or term coverage in the fallback).

Two qmd facts, verified against 2.8.3 rather than assumed:

- `qmd embed` only vectorizes documents the index already knows about, so `avo know add` runs
  `qmd update` first. `avo commit` (and each commit in `avo run`) does the same for `lineage/` after
  it writes a new version. This step is skipped when qmd is not available, and on `--dry-run` or
  `--no-record`. A failed reindex is a warning; the commit stays. Each qmd step has 60 seconds in
  the commit path, not the 30 minutes of `avo know`. The first `qmd embed` downloads a model and
  can take longer; then the commit warns, and `avo know reindex` finishes the index. A file you put
  in `lineage/` by hand still needs `avo know reindex`.
- `.qmd/` is gitignored. `index.yml` records collection paths as *absolute* paths, so a committed
  index is wrong on every other machine, and `index.sqlite` is a multi-megabyte binary.

Web search has three backends behind one flag:

| Backend | Needs | Returns |
| --- | --- | --- |
| `firecrawl` (default) | `FIRECRAWL_API_KEY` | page content — the only one `--ingest` can use |
| `searxng` | `SEARXNG_URL` (instance must enable `format=json`) | links and snippets |
| `ddgs` | nothing | links and snippets |

With none configured, `avo know search` names all three and how to enable them — never a stack trace.

## `avo fan` — N directions at once

One variation step, N independent attempts. Each probe gets its own `git worktree` off `HEAD`, its
own headless agent process, and its own `avo score`. Nothing a probe does reaches your working tree
until you promote one.

```sh
avo fan --n 4 --prompt-file probe.md            # four probes, four worktrees
avo fan --n 3 --prompt "try X, Y or Z" --json   # the JSON is what an agent reads
avo fan --agent pi --model groq/llama-3.3-70b   # the agent, and the probe model
avo fan --timeout 300                           # kill a probe's process group after 300s
avo fan --dirty --prompt-file finish.md         # probes start from your uncommitted work
avo fan --prompt-file probe.md --directions d.txt   # one direction per probe
```

By default, probes do not see uncommitted work in your tree, and `avo fan` warns about it. With
`--dirty`, avo makes a commit of your working tree on top of `HEAD` and starts each probe from it.
Your index, `HEAD` and files do not change. That commit is the baseline, so a probe's diff holds only
the probe's own work, and `--promote` applies it on top of your uncommitted work.
The commit includes untracked files. It does not include ignored files or avo's trajectory paths
(`.avo/worktrees/`, `.avo/runs/`, `.avo/attempts.jsonl`). The ref `refs/avo/fan/<run-id>` keeps the
commit safe from `git gc` until `avo fan --clean` removes the run.

Without `--directions`, all probes get the same prompt, and diversity comes only from sampling.
With `--directions <file>`, each probe gets one direction:

- The file holds one direction per line. avo ignores blank lines and `#` lines, and removes list
  markers (`- `, `* `, `1. `). Thus you can give it a supervisor's list of directions as it is.
- Probe `i` gets the shared prompt, then `Your direction: <line i>`.
- `--n` is the number of directions. If you also give `--n` and it is different, avo stops with
  exit 2.
- The manifest stores each probe's direction, so `--resume` gives a re-run probe the same
  direction. `--directions` with `--resume` is a usage error.
- The cycle guard hashes the shared prompt. Each directed probe also adds the hash of its full
  prompt to `AVO_FAN_CHAIN`. Thus a nested fan-out of the shared prompt, or of the probe's own
  prompt, is a cycle.

Each probe returns `{i, direction, ok, score, diffstat, summary, worktree, tokens, cost_usd, wall_s,
log_path}` — `tokens` and `cost_usd` as described under [`avo run`](#avo-run--the-continuous-loop),
which is what prices the small-model question (#35). `ok` describes the *process*, `score` the
*candidate* — a probe can finish cleanly and still fail `f`. `best` names the highest-scoring probe
that passed; a hint, never a decision.

```sh
avo fan --promote 2 --run <id>   # apply that probe's diff to the working tree — and stop
avo score                        # verify it in the real tree
avo commit --why "…"             # the only thing that writes a version (invariant 1)
```

Probes are meant to run on a **small model** (`$AVO_PROBE_MODEL` — Groq, Cerebras, Haiku): N cheap
probes tell you which direction is worth the expensive model.

Four guards, from `pi-subagent`'s pattern, because a probe is itself an agent that can call
`avo fan`:

| Guard | Default | What happens |
| --- | --- | --- |
| depth | `AVO_FAN_DEPTH=3` | a probe at the limit is refused (exit 1) and must do the work itself |
| cycles | — | a prompt already in the chain (`AVO_FAN_CHAIN`) is refused |
| concurrency | `min(8, cpus-2)` | `--n 20` is allowed; the rest queue |
| timeout | `--timeout 900` | the probe's whole process group is killed, benchmarks included |

Each built-in agent template carries the flag that stops it asking a human for permission —
`pi --approve`, `claude --permission-mode bypassPermissions`, `codex --sandbox workspace-write`.
Without them a headless probe reads, never writes, and exits 0 having done nothing. `avo fan`
reports which one it used in `approval`.

A managed setting can stop the claude flag. If `permissions.disableBypassPermissionsMode` is
`"disable"` (for example, in an organization's remote settings), claude ignores
`bypassPermissions` and uses your `defaultMode`. It does not show an error. avo reads the mode from
claude's `init` event. If the mode is wrong, the turn fails, and `avo run` stops with
`approval-refused`. avo also reports each tool call that claude denied.

Drive something else from `.avo/config.json`:

```json
{"agent": {"name": "myagent", "command": "my-cli", "args": ["--headless", "--model={model}", "{prompt}"]}}
```

Everything lives under `.avo/worktrees/<run-id>/`, which is gitignored trajectory. Worktrees no
probe changed are removed automatically; changed ones stay, because they are the only copy of that
work. Use `avo fan --list`, `--clean <id|all>` and `--resume <id>` — the run manifest is rewritten
after every probe, so a killed fan-out resumes from what it had.

## `avo supervise` — stall and thrash detection

From inside one turn, an agent re-deriving an idea it already tried looks exactly like an agent
making progress. `avo supervise` reads the lineage and `.avo/attempts.jsonl` — nothing it does not
already record — and fires on the two things one turn cannot see:

| Signal | Fires when | Default | Why that is the signal |
| --- | --- | --- | --- |
| `stall` | N variations (distinct `git.tree` values) since the last committed improvement | 5 | `P_t` is monotone, so the newest version *is* the last improvement. A variation that passed `f` and still did not beat it counts: it did not move `P_t`. A second score of the same tree does not count, and a score of the best version with no edit does not count |
| `thrash` | K consecutive variations failed *the same way* and changed at least one same path | 3 | the same error K times in the same file means the diagnosis is wrong, not the edit. The same error in unrelated files is a search |

The stall detail gives both numbers, for example `5 variation(s) since v3 (9 score calls)`. The
thrash detail names the paths that the failures share. When the last score ran on the best version
with no edit, the directive tells the agent to edit something first.

```bash
avo supervise                       # 0 = still making progress, 1 = a directive was emitted, 2 = usage
avo supervise --json | jq -r .directive
avo supervise --stall 3 --thrash 2  # or set supervise.stall / supervise.thrash in .avo/config.json
```

Thresholds belong in `.avo/config.json` because they are repo policy: a scorer that takes an hour
wants a smaller `stall` than one that takes a second. A flag overrides it.

The exit code is the interface — `avo supervise || inject_directive` is the whole integration for a
shell loop, and `avo run` reads the same two codes between turns.

**The directive cites.** "Try something else" is worthless: the agent already believes it is. So
the directive names prior versions with their scores and rationales, the dead ends memory holds, and
the docs in `K` no version has mentioned — that last list is computed by matching each doc's title
against every `--why` and every memory, so a doc appears precisely because nothing in the lineage
talks about it.

"Since the best version" is decided by the sha each attempt recorded, not by its clock. An attempt
scored *on top of* v3 carries v3's sha; the attempt that *became* v3 was scored before that commit
existed. Timestamps cannot separate them — git truncates author dates to the second.

`avo supervise` only reads: it leaves the working tree byte-identical, so the harness's own output
never joins the next candidate's diff.

## `avo run` — the continuous loop

`avo fan` explores; `avo run` *exploits*. One prompt, N iterations of **agent turn → `avo commit` →
`avo supervise` → inject the directive**, in the root working tree rather than a worktree — this is
the case where uncommitted work is the point rather than a hazard.

```bash
avo run --prompt-file task.md --max-iters 20
avo run --prompt "make the tokenizer faster without changing its output" --max-iters 5 --json
avo run --prompt-file task.md --dry-run      # the resolved plan and the first turn prompt; spawns nothing
avo run --prompt-file task.md --stall 3 --thrash 2 --timeout 600 --agent claude --model opus
avo run --prompt-file task.md --max-iters 50 --max-cost 5 --max-tokens 2000000 --max-wall 3600
avo run --prompt-file task.md --supervise detect   # ablation control arm: detect, do not steer
```

**Every iteration is a fresh process.** Nothing from the previous turn is in the agent's context, so
the turn prompt is the only continuity there is: after the first, each carries the operator's task
*plus* what the last iteration decided, plus the steering directive when one fired. The task is never
replaced by the directive — an agent told only "you are stalling" has lost the problem.

**Every intervention is written down.** The paper's seven-day run is only interpretable because the
interventions are recorded, so each injected directive becomes a labelled bead (`bd create -l
avo,avo-intervention`) or a `lineage/memory.jsonl` record. Deliberately *not* an insight: insights
are injected at prime time, and every future session would open with a stale "you are stalling, read
v3" from a run that ended days ago.

**`--supervise on|off|detect` turns the supervisor off for an ablation.** The default is `on`. The
manifest records the mode in `supervise`.

| Mode | Calls `avo supervise` | Injects the directive | Writes intervention memory |
| --- | --- | --- | --- |
| `on` | yes | yes | yes |
| `off` | no | no | no |
| `detect` | yes | no | no |

Use `detect` for the control arm of an ablation. Each iteration keeps its `supervision` signals, and
the directive that would have fired goes into `withheld`. The run counts these in `detections`, and
`interventions` stays at 0. So the control arm still shows its stalls. `detect` writes no memory
record, because the agent reads memory (`avo mem`). A record would steer the agent, and the control
arm would not be a control. In `off` and `detect`, the turn prompt also omits the "attempts since the
best version" line. The agent sees the same prompt in both modes. Each turn also gets
`AVO_SUPERVISE=<mode>`. In `off` and `detect`, an `avo supervise` that the agent runs prints one line
and exits 0, so the agent cannot steer itself.

| It stops when | Because |
| --- | --- |
| `--max-iters` is reached | the budget is the operator's, not the agent's |
| a budget is crossed: `--max-cost <usd>`, `--max-tokens <n>` or `--max-wall <s>` | a turn count does not bound the bill. Stop reason `budget` (#28) |
| `.avo/STOP` exists | the one command meant to run for days needs a brake that does not require finding the process — and one an agent can reach when the task is done |
| 3 iterations in a row change nothing **and leave HEAD where it was** | an unchanged tree is never scored, so it records no attempt and the supervisor *cannot* see it. The one stop condition steering cannot express |
| the agent binary cannot be started | it will not start next iteration either; retrying nine more times is spinning |
| the agent ignored its permission mode (`approval-refused`) | the next turn gets the same mode, so it cannot edit either |
| a turn changes `f` (stop reason `scorer-changed`) | a score from an edited `f` is not a measurement. avo commits nothing from that turn and exits 1 (#38) |

**The scorer is fixed for a run.** At start, `avo run` writes the sha256 of `.avo/score` to the
manifest as `scorer_hashes`. If `.avo/protected.txt` exists, it also hashes that file and each path
in it (one path per line; `#` starts a comment). After each turn and before `avo commit`, `avo run`
hashes the same paths again. A changed, new or deleted file stops the run. The check uses the list
from the start, so an edit to `.avo/protected.txt` cannot remove a path from it. Each path must be a
file: a directory is not hashed.

The turn cannot commit with an edited `f` either. `avo run` puts the start hashes in
`AVO_SCORER_HASHES` for each turn, and an `avo commit` that the agent runs refuses when a hash
changed. A nested `avo run` keeps the outer run's hashes. Thus an agent that edits `f`, commits and
then restores `f` gets no version. A version that the agent committed before the edit stays in the
lineage and in `committed`.

These checks stop an honest mistake in an unattended run. They are not a security boundary: an
agent can unset the variable, or call `git commit` with the trailers itself. They do not replace an
external audit such as `bench/init.sh --verify`.

**The agent usually commits for itself, and the manifest says so.** The `avo-vary` skill — wired in
by `avo install`, and pointed at by the turn prompt — has the agent run `avo commit --why "..."`
before its turn ends, so by step 2 the tree is clean and the decision is honestly `noop`. Each
iteration therefore also records `agent_versions`: versions appearing between `head_before` and
`head_after`, read back from their `Avo-Version` trailers, minus the one step 2 committed itself.
They count toward `committed`, they are named in the next turn's prompt, and they are not no-ops.
Without this a run that produced a curve reads as flat, and three well-behaved turns look like three
idle ones (#42). A commit *without* the trailers moves HEAD but is not a version — invariant 1.

**What a turn cost is read off the agent, not re-derived.** Each iteration records
`tokens: {input, output, cache_read, cache_write}` and `cost_usd`; the run totals both.

- The four token counts are **disjoint** — total input sent is `input + cache_read + cache_write`.
  Cached input costs roughly a tenth of uncached, so folding them together destroys the only thing
  the numbers are for.
- `input` means *uncached* for every agent. pi and claude report it that way; codex follows OpenAI,
  where `cached_input_tokens` is a subset of `input_tokens` and is subtracted back out.
- `cost_usd` is whatever the agent reported (claude's `total_cost_usd`, pi's `usage.cost`), not token
  arithmetic we would have to keep in step with per-model rates. It is `null`, not `0`, when the
  agent reports none — nothing measured and nothing spent are different facts, and a cost budget has
  to refuse the first (#28).

**Budgets stop the loop between turns, not during one.** Before each turn, `avo run` compares
the run totals with each budget you set. When a total is at or past its budget, the loop stops
with `stopped: "budget"`. A turn that has started always runs to its end, so the last turn can go
past the budget. `--timeout` bounds that turn.

- `--max-cost` uses `cost_usd`, the sum the agent reported.
- `--max-tokens` uses all four token counts: `input + output + cache_read + cache_write`.
- `--max-wall` uses the time since the run started.

An agent that reports no usage cannot be held to a cost or token budget. When a turn reports no
cost or no tokens, `avo run` gives one warning, and the manifest lists that budget in
`budget.unenforced`. The loop does not stop for that reason. A budget you did not set is never
listed. Wall time is always measured, so `--max-wall` is always enforced.

Before this, a real six-iteration run reported **44 input tokens for a loop that sent 985,039**, and
no cost: `cache_read_input_tokens` was dropped, and four turns lost their closing `result` event to
an output cap that kept only the first 200KB. The cap now spends 50KB on a rolling tail and marks the
gap it elides, because the payload is printed last in every stream `avo` reads (#43, #22;
`evidence/issue-43-replay.txt`, reproducible with
`npx tsx bench/replay-tokens.ts <repo>/.avo/runs/<id>`).

The cap applies only to the copy in memory. The turn log under `logs/` (the `log_path` of `avo fan`)
gets all of the agent's stdout as it arrives, then its stderr after a `--- stderr ---` line (#22).
Two limits apply. The log stops at 256 MiB of stdout and ends with a `--- avo cut the log ---` line,
so a runaway agent cannot fill the disk. The stderr part is the capped copy in memory.

**A turn's rationale is what the agent *said*, and silence is recorded as silence.** The final
message becomes `avo commit --why`, which lands permanently in the commit body, `lineage/vNNN.md` and
`memory.jsonl`. So a structured stream with no parseable result falls back to the agent's last
*message*, then to any prose it printed on the way down (`fatal: out of credits` explains a turn;
keep it), then to nothing. Never to the last line on the wire: every line of a stream-json stdout is
a protocol event, and one run recorded `{"type":"system","subtype":"thinking_tokens",…}` as a dead
end's rationale (#49). A silent turn commits with no rationale and warns — it usually means the turn
was killed or timed out.

The run manifest at `.avo/runs/<id>/manifest.json` is rewritten after **every** iteration, never at
the end, with each turn's raw agent output beside it under `logs/`. A loop meant to run for days will
be killed eventually, and per-iteration versus at-exit is the difference between a recoverable record
and nothing. `.avo/runs/` is trajectory: in `TRAJECTORY_PATHS`, and gitignored.

```bash
avo run --list                 # each run, its iterations and versions; unfinished runs show the resume command
avo run --resume <run-id>      # continue a killed run
avo run --clean <run-id|all>   # remove run directories and their logs
```

**`--resume` continues a killed run.** It reads the manifest and uses the same prompt, agent, model,
timeout, thresholds and `--max-iters`. The count continues at the next iteration. The first new turn
gets the last outcome and the last directive, as if the loop had not stopped. Rules:

- Only an unfinished run resumes (`finished_at` is `null`). A run that stopped for a reason, such as
  `.avo/STOP` or the budget, is finished. Start a new run for more work.
- The guards apply again, because a resume spawns agents.
- HEAD can move while the run is down, for example from an operator commit. Each turn reads the
  lineage again, so the resume continues and gives a warning. If the run's last HEAD is not an
  ancestor of HEAD (a reset, or a different branch), the versions of the run are gone. Then the
  resume refuses (exit 1).
- A turn that was killed is not in the manifest. Its changes, if any, stay in the tree, and the next
  turn's `avo commit` scores them.
- The manifest records the pid and host of the loop. A resume refuses a run whose loop is still
  alive on this host (exit 1), because two loops on one tree compete. `--list` shows such a run as
  `running`. On Linux, a pid that the system gave to a different program does not count as alive.
- `--resume` takes only `--json` and `--cwd`. The manifest holds the prompt, agent and budget, so
  a flag such as `--max-iters` is an error, not a silent no-op.

**`--clean` removes run directories.** It removes only a directory that holds a valid run manifest,
so a bad id cannot delete other files. An id is a name, never a path: `..` or `a/b` is refused.
`all` removes every run, unfinished ones too, but not a run that is still alive.

`avo run` carries `avo fan`'s four guards on the same budget (`AVO_FAN_DEPTH`, `AVO_FAN_LEVEL`,
`AVO_FAN_CHAIN`), because a turn is itself an agent that can call `avo run` — a loop inside a loop is
the same exponential hazard as a fan-out inside one. A guard is a refusal (exit 1), not a harness
error.

## `avo doctor`

`avo doctor` exits 1 when a required dependency (`git`, `jq`) is missing, or when no coding agent
(`pi`, `claude`, `codex`) is on `PATH` — one is required as the variation operator. Optional
dependencies (`qmd`, `ddgs`, `bd`, `hyperfine`, `just`) are reported but never fail the check; each
degrades with a named fallback. API keys are reported as present/unset only — their values never
appear in any output.

Full dependency table, including what each optional one degrades to: [install.md](install.md).
