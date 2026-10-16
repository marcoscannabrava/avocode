# A bench that fires the supervisor

Goal: test the **whole** loop with a real agent, the supervisor included. Today the supervisor has
only stub-agent evidence (`evidence/s7-e2e.txt`, `s7b-e2e.txt`, `s8-e2e.txt`).

## 1. Why `fuzzysearch` never fired it

- It had about 5000x of headroom. Every turn committed. `since_best` peaked at 2 and the stall
  threshold is 5 (`docs/paper/evaluation.md` §3.1).
- The runs stopped on a 20-25 minute watchdog, long before the gains ran out. v7 still found 17%
  per turn.
- Thrash needs the *same* failure 3 times in a row. A strong agent on a fast, clear scorer fixes an
  error on the first retry.

So the supervisor did not fail. It was never asked.

## 2. What the bench needs

A bench fires the supervisor when the agent runs out of easy ideas before it runs out of budget.

| Property | Why | How to check |
| --- | --- | --- |
| **Plateau within budget** | stall needs ≥ N variations with no version | the scripted ladder flattens; a pilot run has ≥ 5 non-committing variations in a row |
| **Fine metric** | progress must be visible as a number, or every change is a tie | the ladder moves the score on most rungs |
| **Noise under control** | noise above `floor` makes random commits; noise far below makes ties commit | measured spread of a fixed policy < floor / 2 |
| **Real, repeatable failures** | thrash needs a failure the agent cannot fix in one retry (a hard contract, a timeout, a sandbox breach) | the gates produce distinct log signatures |
| **Cheap `f`** | many variations per turn, many turns per dollar | ≤ 60 s per full score |
| **Untried directions in K** | the directive must have something to cite | ≥ 5 docs in `knowledge/`, none named in the seed lineage |
| **Holdout** | a plateau reached by memorising is not a result | a separate set scored outside `f` |
| **Visuals** | progress and interventions must be visible at a glance | see [visuals.md](visuals.md) |

Long-horizon, open problems fit this best: ARC-AGI-3 and Craftax. Both are planned in
[PLAN_ARCAGI.md](PLAN_ARCAGI.md) and [PLAN_CRAFTAX.md](PLAN_CRAFTAX.md).

## 3. Stages

Each stage is cheaper than the next and must pass before the next one spends money.

### Stage 0 — instrument (no agent)

Land the run-safety and measurement tasks first: AVO-1 (budgets), AVO-2 (scorer hash stop), AVO-4
(`--supervise off`), AVO-5 (distinct-variation stall count), AVO-7 (intervention effect), AVO-10
(timeline). Without them a stall is invisible in the record, expensive, and impossible to compare
with a no-supervisor run.

### Stage 1 — cheap plateau on `fuzzysearch` (BENCH-1)

Resume the existing S9b lineage from v7 (0.231 ms) with a **small model** (a Haiku-class model), stall
3, thrash 3, and a budget of 10 turns or $10. A weaker model on a target that is already 7800x in
should run out of ideas fast.

- Pass: ≥ 1 real intervention, recorded in the manifest and in memory.
- This is the cheapest real answer to PLAN Q3. It is not the main bench. The problem has a known
  answer, so it says little about the operator.

### Stage 2 — main bench (BENCH-2)

ARC-AGI-3 first, Craftax as fallback, per the go/no-go rule in [PLAN_ARCAGI.md](PLAN_ARCAGI.md).
Run one pilot of 10 turns. Check the plateau, the noise and the per-turn cost before any campaign.

### Stage 3 — ablation campaign (BENCH-3)

The experiment that says whether the supervisor helps.

| | Arm A | Arm B |
| --- | --- | --- |
| supervisor | on | off (`--supervise off`) |
| runs | 3 | 3 |
| budget per run | same $ and same wall clock | same |
| seed lineage | same baseline commit | same |
| agent, model, K | same | same |

Report per run: final best (train and holdout), versions, distinct variations, interventions,
since-best at each intervention, turns from intervention to next version, cost. Plot all six runs on
one chart (AVO-11).

Pre-registered success criteria, written before the runs:

1. Arm A fires ≥ 3 interventions per run on average.
2. ≥ 1 in 3 interventions is followed by a version within 2 turns.
3. Arm A's median final best ≥ Arm B's median final best, on train **and** holdout.

If (1) holds and (2) or (3) fails, the supervisor fires but does not help. That is a real result.
Then try the agent-written directive (AVO-12) and directed fan-out (AVO-13) as a second ablation.

### Stage 4 — agent comparison (BENCH-4)

The old S9b-2b: the same bench under `pi` with the in-session supervisor extension. Compare
interventions and the probe/commit token split (#35).

## 4. Threshold tuning (PLAN Q3)

Once Stage 2 has a pilot run, read the since-best series from the timeline. Pick `stall` so it fires
after the point where the per-variation commit rate drops below about 1 in 5. Record the answer in
PLAN.md §6 Q3 with the data.
