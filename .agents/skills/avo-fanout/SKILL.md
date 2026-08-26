---
name: avo-fanout
description: Explore several variation directions at once with `avo fan` — N git worktrees, N headless agent processes on a small model, each scored, one promoted. Use when a variation step has more than one plausible direction and you cannot tell which is best by reading, when a direction is cheap to try and expensive to argue about, or when asked to probe, fan out, or run candidates in parallel.
---

# avo fan — N directions at once

One variation step, N independent attempts. Each probe gets its own `git worktree` off `HEAD`, its own
agent process, and its own score. Nothing they do reaches your working tree until you promote one,
which is a separate command you run on purpose.

**This is a search, not a vote.** The probes explore; `f` measures; you choose; `avo commit` decides
whether the choice was progress. The reported `best` index is a hint drawn from the scores, never a
decision.

## When to fan out

Fan out when **you do not know which direction wins and the answer is cheap to measure**:

- three plausible optimizations and no way to rank them without running them
- a rewrite you suspect breaks correctness — one probe tries it, `f` says
- a dead end you keep re-deriving; probe it once, record the refusal, stop wondering
- triage of a failed attempt: probes verify competing hypotheses in parallel

Do **not** fan out when:

- **one direction is obviously right.** Just do it. N probes of the same idea cost N times as much and
  return the same answer.
- **`f` cannot tell the probes apart.** Without a scorer you are reading N diffs by hand — usually
  slower than doing the work once.
- **the task needs the big model to even attempt.** Probes run on a small model on purpose (below). A
  probe that cannot make progress teaches you nothing about the direction.
- **you are already inside a probe.** Read the guards.

## The small-model policy

Probes run on `$AVO_PROBE_MODEL` — a small, fast, cheap model (Groq, Cerebras, Haiku). That is the
point of the fan-out, not a cost compromise: **exploration is a small-model job, exploitation is a
big-model job.** N cheap probes tell you which direction is worth the expensive model; then the main
session does that direction properly.

```bash
export AVO_PROBE_MODEL=groq/llama-3.3-70b   # or pass --model
```

If you want the big model for every probe, you are not exploring — you are asking for the work to be
done four times. Do it once instead.

## Run one

```bash
avo fan --n 4 --prompt-file probe.md            # four probes, one worktree each
avo fan --n 3 --prompt "try X, Y or Z" --json   # the JSON is what you should read
avo fan --agent pi --model groq/llama-3.3-70b   # choose the agent and the probe model
avo fan --timeout 300                           # kill a probe's process group after 300s
```

The prompt goes to **every** probe identically. Diversity comes from sampling, not from N different
prompts — so write a prompt that names the *problem* and invites a direction, not one that dictates the
edit. A prompt saying "delete the bounds check" gets you four identical diffs.

Tell the probes what the loop needs back: what to change, that they must not touch `.avo/score`, and
that a one-line summary of *what they tried* is what you will read. Their final message becomes
`summary`.

Each probe returns:

| Field | Meaning |
| --- | --- |
| `i` | 1-based probe number — what `--promote <i>` takes |
| `ok` | the agent process finished and was not killed. **Says nothing about the candidate** |
| `score` | `avo score` run inside that worktree: `pass`, `primary`, `normalized`, `scores` |
| `diffstat` | files, insertions, deletions, and the paths touched |
| `summary` | the agent's final message |
| `worktree` | where the work is, if you want to read it |
| `tokens`, `wall_s` | what it cost |
| `log_path` | the probe's full output — read this when `ok` is false |

`best` is the highest-scoring probe that **passed** `f`. A failing probe with a spectacular number is
not a winner; correctness gates everything (invariant 2).

## Choose and promote

```bash
avo fan --promote 2 --run <id>   # apply probe 2's diff to the working tree
avo score                        # verify it in the real tree, not the worktree
avo commit --why "…"             # the only thing that writes a version
```

`--promote` applies a patch and stops. It does not score, does not commit, and does not delete the
other probes. If the patch needs a 3-way merge you are told so — check for conflict markers before you
score. The patch is kept at `.avo/worktrees/<run>/promote-<i>.patch` either way.

**Promote at most one probe per variation step.** Two probes' diffs stacked together is a candidate
neither of them measured, and `f` scored neither. If two directions both look good, promote one, commit
it, and fan out again from there — that is what the lineage is for.

**A losing probe is a measurement.** Before you clean up, record the dead ends:

```bash
avo mem add "unrolling the inner loop 4x: -12% on b1_s4096, probe 3 of run <id>"
```

That is the whole reason the probes were worth running. Without it you re-derive the same three dead
ends next week — see [avo-lineage](../avo-lineage/SKILL.md).

## Clean up

Worktrees no probe changed are removed automatically. Changed ones stay, because they are the only
copy of that work.

```bash
avo fan --list              # runs that still have worktrees
avo fan --clean <run-id>    # remove that run's worktrees and its directory
avo fan --clean all         # everything
avo fan --resume <run-id>   # re-run the probes an interrupted fan-out never finished
```

`avo fan` writes only under `.avo/worktrees/`, which is gitignored trajectory — not lineage. A run
survives a kill: the manifest is rewritten after every probe, so `--resume` picks up what is missing.

## The guards, and why you will hit them

A probe is an agent with these same skills, so it can call `avo fan` too. Unbounded, that is
exponential in wall-clock and in spend.

- **Depth.** `AVO_FAN_DEPTH` (default 3) caps nesting. A probe at the limit is refused and must do the
  work itself. That is a **refusal (exit 1), not an error** — the harness telling you that you are the
  one who should be editing files now.
- **Cycles.** The same prompt already being explored higher in the chain is refused. If you meant a
  genuinely different question, ask it differently.
- **Concurrency.** `min(8, cpus - 2)` probes run at once; `--n 20` is allowed, it just queues.
- **Timeout.** Default 900s per probe. The whole process group is killed, so a benchmark the agent
  started dies with it.

## Rules

- **Never promote a probe you have not scored in the real tree.** A worktree score was measured against
  the baseline; your tree may have moved.
- **A probe must not edit `.avo/score`.** Say so in the prompt. A probe that changes `f` to pass is not
  a candidate, and every earlier version becomes incomparable.
- **Read `log_path` before you believe `ok: false`.** "Exited 3" is usually a missing API key for the
  probe model, not a hard problem.
- **Uncommitted work in your tree is invisible to probes.** They branch from `HEAD`. `avo fan` warns;
  commit or stash first if the probes need to see it.
- **N probes is N times the spend.** Three is usually enough. Eight is a decision, not a default.

See [avo-vary](../avo-vary/SKILL.md) for the variation step a fan-out is part of, and
[avo-score](../avo-score/SKILL.md) for the `f` the probes are measured by.
