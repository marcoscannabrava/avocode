# `avocode`: Evolutionary Agent Harness

Oct 2, 2026 · @Marcos Cannabrava

## An agent harness that focuses on improving a single metric

Inspired by NVIDIA's [AVO: Agentic Variation Operators](https://github.com/marcoscannabrava/avocode/blob/main/docs/avo-paper.md) where they let an agent evolve attention kernels on B200 GPUs for 7 days and it beat cuDNN and FlashAttention-4.

Using `avocode` you write one script that measures your code, the agent tweaks the code and creates a graph of the strategies and hypotheses, experimenting, and keeping the improved versions.&#32;

## Theory

The AVO paper defines the variation step as: `Vary(P_t) = Agent(P_t, K, f)`. An agent makes the next version from the past versions, a knowledge base, and a score.

| Symbol | Description | `avocode` implementation |
| --- | --- | --- |
| `f` | scoring Function that yields a metric to improve | `.avo/score`, any executable that prints one JSON line |
| `P_t` | Population at time t: versions of the code/algorithm that is being improved | git commits with score trailers, plus `lineage/vNNN.md` |
| `K` | Knowledge base | `knowledge/` plus the repo's own history, searchable |
| Agent | the agent harness that drives the LLM | pi, Claude Code or Codex, driven by five skills |

`.avo/score` runs your benchmark or tests and prints a line like this:

```json
{"ok":true,"correct":true,"primary":356.0,"unit":"ms","higher_is_better":false,
 "scores":{"small":155.7,"large":556.4}}
```

`avo commit` is the command that re-scores the code and compares every config in the score vector against the current best. A candidate is accepted only if it ties or beats the best on every config and wins on at least one.

![The commit rule: tie or beat the best on every config, and win on at least one](img/commit-rule.svg)

## The loop

Each turn has four steps: the agent changes the code, `avo score` measures it, `avo commit` accepts or refuses it, and `avo supervise` checks whether the loop is stuck.

![The avocode loop: agent, avo score, avo commit and avo supervise, with one shared store](img/loop.svg)

Every outcome, accepted or refused, is written to the store that the next turn reads.

The `avo-vary` skill has the agent run three commands before editing: `avo mem prime` for notes from past turns, `avo best` for the version to beat, and `avo know query "<idea>"` to search docs and past attempts. It then makes one change per candidate, so a refusal can be attributed to that change.

Refusal example:

```
refused: b8_s1024 regressed 4.2% (1421.7 -> 1362.0); dominate requires no config to regress
```

refused changes are considered a dead end so later sessions don't retry it although there's room for improvement here. It would be reasonable to tweak the algorithm to enable exploring worse versions if the idea is solid but the first implementation isn't optimal. It's like that cartoon of a guy digging for diamonds in the sense that in the current algorithm, an agent might stop short of a solution that was very promising but didn't yield good results on a first try.

A single turn can't tell whether it is repeating an earlier idea. `avo supervise` reads the lineage and the attempt log and fires on two signals:

- **Stall:** 5 attempts (by default) since the last improvement, including attempts that passed but didn't beat the best.
- **Thrash:** 3 consecutive attempts that failed the same way, which usually means the diagnosis is wrong rather than the edit.

When it fires, the directive lists specific material: past versions with their scores and reasons, dead ends from memory, and docs in `K` that no version has referenced yet.

`avo run` automates the loop. Each turn is a fresh agent process with no memory of the previous one. Its prompt contains your task, the previous turn's decision, and the supervisor's directive if one fired; the directive is added to the task, not substituted for it. The run stops at `--max-iters`, when `.avo/STOP` exists (`touch .avo/STOP`), or after 3 consecutive turns with no change.

## Memory and knowledge

Every turn starts with a blank agent, so `avocode` keeps its memory in the repo: the lineage, a memory log, and a searchable knowledge base.

**Lineage.** A version is a commit with `Avo-Version` and `Avo-Score` trailers. The full score is stored in `git notes`, and `lineage/vNNN.md` holds the score table, diffstat and the reason for the change. There is no separate database.

`avocode` keeps *lineage* (accepted versions) separate from *trajectory* (how they were reached). Attempt logs, worktrees and run logs are gitignored and never committed.

![Each version is a commit with trailers, a git note, a lineage file and a memory entry; trajectory files are gitignored](img/lineage-records.svg)

Example lineage from the `fuzzysearch` bench (see Benchmark section):

![The fuzzysearch lineage from v0 to v7, with one refused candidate between v4 and v5](img/lineage-chain.svg)

**Memory.** `avo commit` writes memory entries automatically. Each new version links to its parent and records why it was made. A refused candidate is stored as a dead end keyed by its content, so a repeat attempt updates the existing record. With [beads](https://www.npmjs.com/package/@beads/bd) installed, entries are stored as beads; otherwise they go to `lineage/memory.jsonl`. The agent reads the same JSON in both cases.

**Knowledge.** `K` is two markdown collections: `knowledge/` for docs and papers, and `lineage/` for the repo's history. Both are indexed by [qmd](https://github.com/tobilu/qmd) (keyword, vector and rerank search), so one query covers past attempts and docs together. `avo commit` already writes the lineage files, so indexing them needs no extra step.

![knowledge/ and lineage/ are indexed by qmd, so one avo know query searches both](img/knowledge.svg)

The agent can add web pages to `K` with `avo know search --ingest`. Each added doc records `source`, `title`, `fetched-at` and `via`, so it can be verified later.

qmd and beads are optional. Without qmd, a local scan returns the same JSON shape; without beads, memory is written to a file. A missing tool produces a warning, not an error.

## Parallel probes

`avo fan` runs N attempts in parallel on a cheaper model, scores each, and lets you promote one. The idea is to use small models for exploration and larger ones for refinement.

![avo fan runs N probes in separate worktrees, then one is promoted, scored and committed](img/fan.svg)

Each probe runs in its own git worktree off `HEAD` with its own headless agent and `avo score`, so your working tree is untouched. All probes get the same prompt and differ only through sampling, so the prompt should describe the problem rather than a specific edit. A prompt like "delete the bounds check" produces N identical diffs.

```sh
avo fan --n 4 --prompt-file probe.md   # four probes, four worktrees
avo fan --promote 2 --run <id>         # apply probe 2's diff, then stop
avo score                              # check it in the real tree
avo commit --why "..."                 # the rule still decides
```

Promoting applies the probe's patch without scoring or committing it. Promote one probe per step; stacking two diffs creates a candidate that was never measured. Record losing probes with `avo mem add` so later sessions skip them.

Probes have the same skills and can call `avo fan` themselves. Recursion is bounded by a depth cap (3 by default), a cycle check on repeated prompts, a concurrency cap of `min(8, cpus-2)`, and a 900-second timeout that kills the probe's process group.

## Benchmark

On the `fuzzysearch` bench, two `avo run --agent claude` sessions took an unoptimized but correct implementation of the fuzzy search algorithm from 1810 ms to 0.231 ms: a **7837x** speedup over 7 versions.

![Seven versions cut fuzzysearch time from 1810 ms to 0.231 ms](img/results.svg)

Before any agent ran, six hand-written versions were benchmarked to confirm the target algorithm had headroom (356ms-0.92ms ~385x).

Run 1 took 34 minutes, produced 4 versions and reached 5255x. In v3 the agent split each word into `k+1` segments and hashed them: by the pigeonhole principle, any match within `k` edits keeps at least one segment intact. Run 2 resumed the same lineage and added 3 versions in 31 minutes. In one turn the agent profiled each phase and found that a step its earlier notes called "too small to matter" took 30 to 43% of the call time. Cost was ~$2.73/turn

## Getting started

You need Node 22 or later, `git`, `jq`, and one coding agent: `pi`, `claude` or `codex`. Setup takes about five minutes.

```sh
git clone https://github.com/marcoscannabrava/avocode
cd avocode && ./install.sh     # safe to re-run
avo doctor                     # what is missing?

cd /your/repo
avo init                       # .avo/, lineage/, knowledge/
avo install                    # wire your agent to the skills
avo score --init hyperfine     # or pytest, vitest; then edit it
avo run --prompt-file task.md --max-iters 20 --dry-run
```

You write `.avo/score`. Make the `correct` check strict and cheap, since it is the only thing that rejects fast wrong answers. Keep the benchmark deterministic or set a `floor`. Keep it fast: a one-hour scorer allows 24 attempts a day. Measure what you want improved, since that is what the agent will optimize.

The skills are plain markdown in the [Agent Skills](https://agentskills.io/specification) format. `avo install` links them rather than copying: Claude Code gets a symlink, Codex gets an `AGENTS.md` index, and pi also gets six native tools and an in-session supervisor. Every feature is available as a `bash` command, so all three agents get the same functionality.

**Open items.**
- `avo run` has no cost cap ⚠️
- The supervisor has not fired in nine real turns because every `fuzzysearch` turn improved; tuning its thresholds needs a run that plateaus.
- Population branching, which the AVO paper also leaves as future work.

`avocode` itself was developed with my version of a [ralph loop](https://github.com/marcoscannabrava/ralph).
