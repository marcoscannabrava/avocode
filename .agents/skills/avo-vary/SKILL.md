---
name: avo-vary
description: Perform one variation step in an avocode optimization loop — read what is already known, change the code, measure it with `avo score`, and let `avo commit` decide whether it was progress. Use whenever the task is to improve a measurable quantity (speed, accuracy, cost, pass rate) in a repo that has a `.avo/score` scorer, or when asked to "do an iteration", "vary", or "try to beat the best version".
---

# avo vary — one variation step

You are the variation operator. In the AVO formulation `Vary(P_t) = Agent(P_t, K, f)`: you read the
population `P_t` (the committed lineage), consult knowledge `K`, propose a change, and the fitness
function `f` (`.avo/score`) judges it. You do **not** decide what gets kept — `avo commit` does,
and it only keeps a candidate that beats the current best. That is the whole point: your job is to
generate variation, not to grade it.

## The loop, in order

Do not skip steps 1–3. They are what stops you from re-trying something that already failed.

```bash
avo mem prime                       # 1. what past iterations learned, incl. dead ends
avo best                            # 2. the version you must beat
avo lineage                         # 2. the whole population, newest last
avo know query "<the idea>"         # 3. K — docs, and your own prior lineage entries
```

Then:

```bash
# 4. make ONE coherent change to the code. Read the files before you edit them.
avo score --json                    # 5. measure it. Exit 1 means it ran and failed — that is data.
avo commit --why "<one sentence: what you changed and why it should help>"
```

`avo commit` re-scores; you cannot commit a number you did not measure.

## Reading the verdict

| `avo commit` says | exit | what it means | what to do |
| --- | --- | --- | --- |
| `committed v<N>` | 0 | it beat the best on every shared config | pick the next idea; `avo mem add` anything surprising |
| `no-op` | 0 | the tree is unchanged — you did not actually edit anything | make a change first |
| `refused` | 1 | it failed correctness, or it regressed | read the reason; it names the config and the delta |
| harness error | 2 | no scorer, malformed output, timeout | fix the harness, not the candidate |

A refusal is **not** a failure of the run. It is the commit rule doing its job. The candidate stays
in your working tree, so you can iterate on it — but record what you learned first:

```bash
avo mem add "vectorizing the inner loop regressed b8_s1024 by 12% — the gather is the bottleneck, not the arithmetic"
```

`avo commit` already writes a refusal into memory for you. Add an insight when you know *why*,
because the reason is what stops the next session from repeating it.

## Rules that matter

- **One idea per candidate.** Two changes in one commit and a refusal tells you nothing about which
  one cost you. If you have two ideas, score them one at a time.
- **Never edit `.avo/score` to make a candidate pass.** That is gaming `f`, and it invalidates every
  earlier version in the lineage. If the scorer is genuinely wrong, fix it as its own committed
  change and say so in `--why`.
- **You cannot improve by measuring less.** Dropping a config from `scores` blocks the commit.
- **`--dry-run` before an expensive commit** if you want the decision without the write.

## When you are stuck

Ask, rather than deciding for yourself that you are not stuck:

```bash
avo supervise      # exit 0 = still making progress; exit 1 = it printed a directive, follow it
```

It reads the same lineage and the same attempt log you do, and it fires on the two things you
cannot see from inside one turn:

- **stall** — N attempts since the last committed improvement. Not "N failures": an attempt that
  passed `f` and still did not beat the best version counts too, because it did not move `P_t`.
- **thrash** — the last K attempts failed *the same way*. The same error three times means your
  diagnosis is wrong, not your edit; a smaller version of the same change fails identically.

The directive it prints cites specific versions, the dead ends memory already holds, and the docs in
`K` that no version has ever mentioned. Treat that last list as your candidate directions — it is
computed, not guessed: a doc is listed precisely because nothing in the lineage talks about it.

Then go back to `K`:

```bash
avo know query "<the sub-problem you keep failing at>"
avo know search "<the sub-problem>" --ingest    # pull new material into K, with provenance
```

If every direction you can name is already in the lineage, stop guessing and let `f` choose — see
[avo-fanout](../avo-fanout/SKILL.md).

## If you are running inside `avo run`

`avo run` drives this loop for many turns: it spawns you, runs `avo commit` on whatever you left in
the tree, asks `avo supervise` whether to steer, and spawns a *fresh* process for the next turn.
Three things follow, and they are easy to get wrong:

- **You will not remember this turn.** The next iteration is a new process; its only context is the
  prompt it is given. Anything worth carrying forward has to be written down — `avo commit --why`,
  or `avo mem add "<insight>"` for something that is not tied to a version.
- **You do not have to commit.** `avo run` runs the commit rule after you, on the tree you leave
  behind. Committing yourself is fine too; it is not a no-op and the loop keeps going.
- **`touch .avo/STOP` when the task is genuinely done.** It ends the loop before the next turn. Use
  it when there is nothing left to vary — not when *this* turn was hard. A loop that keeps going
  after the work is finished burns budget on candidates nobody wants.

If you find yourself about to call `avo run` or `avo fan` from inside a turn, check the depth first:
`AVO_FAN_LEVEL` against `AVO_FAN_DEPTH`. At the limit you must do the work yourself.

See [avo-score](../avo-score/SKILL.md) for the `f` contract, [avo-lineage](../avo-lineage/SKILL.md)
for reading `P_t`, and [avo-knowledge](../avo-knowledge/SKILL.md) for growing `K`.
