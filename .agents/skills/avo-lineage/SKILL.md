---
name: avo-lineage
description: Read and extend `P_t`, the committed lineage of an avocode repo — `avo lineage`, `avo lineage show/diff`, `avo best`, and the commit rule that governs what gets kept. Use when asked what has already been tried, why a candidate was refused, how a version was reached, or to compare two versions.
---

# avo lineage — reading and extending `P_t`

`P_t` is the population: the sequence of committed versions, each one strictly better than the last.
It lives in git, not in a database — a version *is* a commit carrying `Avo-Version: N` and
`Avo-Score: <compact json>` trailers, with the full attempt in `git notes --ref=avo` and a rendered
`lineage/vNNN.md`.

## Reading it

```bash
avo lineage                  # every version, newest last: number, score, unit, subject
avo lineage --json           # same, for jq
avo best                     # the one version a new candidate must beat
avo lineage show 7           # v7 in full: score table, parent, decision, rationale, diffstat
avo lineage diff 5 7         # score delta + the patch between two versions
```

Because the commit rule only ever persists an improvement, the lineage is **monotone by
construction** — so `avo best` is simply the highest-numbered version. There is no ranking pass and
no need to search for the best.

The rendered `lineage/*.md` files are also a knowledge collection, so the lineage is semantically
searchable with the same tool as the docs:

```bash
avo know query "what did I already try about register pressure?"
```

That is usually a better first move than `avo lineage show` on ten versions in turn.

## Extending it

Only `avo commit` writes a version. Nothing else may — not a manual `git commit`, not an edit to
`lineage/`. It is the single writer, which is what makes the trailers, the notes, and the rendered
files consistent with each other.

```bash
avo commit --why "<what changed and why it should help>"
avo commit --dry-run --why "..."     # the decision, without writing anything
```

## The commit rule

A candidate is persisted **only** if it passes correctness **and** beats the best committed version:
by default, `>=` on every config the two share and `>` on at least one (*dominate-or-tie*).

- A weighted **mean** is available in `.avo/config.json` for configs that genuinely trade off. It is
  not the default, because a mean lets a large win on one config pay for a regression on another —
  precisely the silent regression the rule exists to stop.
- `floor` is a **symmetric** relative band: a change inside it is neither better nor worse, so noise
  can neither commit nor block.
- A config in the best version but **missing** from the candidate blocks the commit — you cannot
  improve by measuring less. A *new* config does not block.
- A candidate whose `higher_is_better` differs from the best version's is refused as
  **incomparable**, not ranked.

Failed attempts never enter the lineage. They stay in the trajectory (`.avo/attempts.jsonl`) and in
memory as insight beads, which is what stops a later session re-trying them — see
[avo-vary](../avo-vary/SKILL.md).

## Reading a refusal

The refusal names the config and the delta. Treat it as a measurement:

```bash
avo commit --why "unrolled the inner loop"     # exit 1
# refused: b8_s1024 regressed 4.2% (1421.7 -> 1362.0); dominate requires no config to regress
```

That tells you the change helps one shape and hurts another — a real result about the problem, worth
`avo mem add`-ing before you try again.

## What lives where

| Path | What it is | In git? |
| --- | --- | --- |
| `lineage/vNNN.md` | the rendered record of a committed version | yes |
| `git notes --ref=avo` | the full normalized attempt behind each version | yes |
| `lineage/memory.jsonl` | the memory fallback log (no `bd` installed) | yes |
| `.avo/attempts.jsonl` | every scoring run, committed or not — trajectory | no |
| `.avo/worktrees/` | fan-out scratch | no |
