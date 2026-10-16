# PLAN.md — `avocode`: an AVO-inspired agent harness

> Phase 2, from 2026-10-16. Phase 1 (slices S0-S9b, history, design rationale) is kept verbatim in
> [plan/archive/PLAN-v1.md](plan/archive/PLAN-v1.md). Comments in the code that cite "PLAN §S7",
> "PLAN §6 Q1" and so on point there.

## 1. What we are building

The [AVO paper](docs/avo-paper.md) replaces a fixed evolutionary pipeline with a coding agent:
`Vary(P_t) = Agent(P_t, K, f)`. avocode is that harness, made general and agent-agnostic.

| Symbol | Meaning | Implementation |
| --- | --- | --- |
| `f` | scoring function | `.avo/score`, one JSON line |
| `P_t` | lineage | git commits with `Avo-Version` / `Avo-Score` trailers, notes, `lineage/*.md` |
| `K` | knowledge | `knowledge/` + `lineage/`, searched by qmd |
| Agent | variation operator | pi, Claude Code, Codex, driven by `.agents/skills/` |
| Supervisor | stall and thrash steering | `avo supervise`, `avo run`, pi extension |

Architecture: [docs/architecture.md](docs/architecture.md). Code notes:
[docs/paper/code-core.md](docs/paper/code-core.md),
[docs/paper/code-orchestration.md](docs/paper/code-orchestration.md).

## 2. Where we are

Built and tested: S0-S8 (441 unit tests, 496 e2e checks). Proven on one bench: two `avo run` sessions
on `fuzzysearch` took 1810 ms to 0.231 ms (7837x) in 9 turns, 7 versions, 0 regressions
([docs/paper/evaluation.md](docs/paper/evaluation.md)).

**Not proven:** the supervisor. It fired 0 times in 9 real turns, because every turn committed. The
whole loop is untested at the point it exists for: a plateau.

## 3. Phase 2 goal

Run a bench that **plateaus**, so the supervisor fires with a real agent, and measure whether it
helps. Make progress and interventions **visible** without hand-drawn figures.

## 4. Documents

| File | What it holds |
| --- | --- |
| [plan/avocode-review.md](plan/avocode-review.md) | gaps in avocode today, ranked by area |
| [plan/supervisor-bench.md](plan/supervisor-bench.md) | what a bench needs to fire the supervisor; staged plan; ablation design |
| [plan/visuals.md](plan/visuals.md) | `avo report`: timeline JSON, HTML page, scorer artifacts |
| [plan/PLAN_ARCAGI.md](plan/PLAN_ARCAGI.md) | ARC-AGI-3 as the main bench (`bench/arcagi3-learn`); why arcjev stalled |
| [plan/PLAN_CRAFTAX.md](plan/PLAN_CRAFTAX.md) | Craftax as the fallback bench (`bench/craftax`); what rekursiv did |
| [plan/tasks.md](plan/tasks.md) | task specs `AVO-*`, `BENCH-*`, with acceptance and deps |

## 5. Bench decision

**ARC-AGI-3 first, Craftax as fallback B, both built up to their ladder in parallel.**

- The arcjev project failed before any learning could happen. Its `f` took about 8.5 CPU-days and read
  0.0 everywhere. Its policy was a frozen 4B LLM scoring one step at a time, at 12-24 s per action.
  The learning-loop hypothesis holds (no world model, no hypotheses, 8-step memory), but measurement
  was the first blocker. The new design moves the LLM into the avocode turn and makes the policy fast
  Python with its own inner loop. The engine runs at 900-2700 actions/s and is deterministic.
- Craftax fits well: fine metric (% of 226 achievement points), new seeds as a clean holdout, a known
  reference curve, rich visuals. rekursiv's result (49% → 73%) used about 11 h of H100 per run, so we
  do not copy it. We use a scripted CPU policy instead. Random play is 0.86%.
- The fallback rule is the go/no-go table in [PLAN_ARCAGI.md](plan/PLAN_ARCAGI.md) §8. Fall back when
  two gates in a row need a retune.

## 6. Milestones

Specs and dependencies are in [plan/tasks.md](plan/tasks.md).

| Milestone | Content | Spend |
| --- | --- | --- |
| **M1 — instrument** | AVO-1 budgets, AVO-2 scorer-hash stop, AVO-4 `--supervise off`, AVO-5 count variations, AVO-6 PATH, AVO-7 intervention effect, AVO-8 hypotheses, AVO-9 problem model + learning-loop skill, AVO-10 timeline, AVO-11 report | none |
| **M2 — first real intervention** | BENCH-1: small model, resumed `fuzzysearch` v7, ≤ $10 | ≤ $10 |
| **M3 — main bench** | ARC-1..ARC-12, ARC-15 (and CFX-1..CFX-7 in parallel); BENCH-2 pilot; BENCH-3 ablation; BENCH-4 pi | campaign |
| **M4 — upgrades from evidence** | AVO-12 agent-written directive, AVO-13 directed fan, AVO-14 re-measure best, AVO-15 noise-aware compare | as needed |
| **M5 — hygiene** | AVO-16..AVO-21, issue sweep | none |

Order inside M1: AVO-1, AVO-2, AVO-4, AVO-6 first (small, independent), then AVO-5 → AVO-10 →
AVO-7, AVO-11, and AVO-8 → AVO-9.

## 7. Invariants

1. **`avo commit` is the only writer of committed lineage.**
2. **A failing `f` never yields a commit.**
3. **Every subcommand supports `--json`.**
4. **Degrade, never crash.** Missing tool or key ⇒ named fallback + one warning.
5. **Idempotent by construction.** `init`, `install`, `commit` are safe to re-run.
6. **Never leak secrets.** Presence of keys only.
7. **Worktrees are disposable, `main` is not.**
8. **CLI-first.** bash before any MCP or pi binding.
9. **The skills are the product.**

Phase 2 adds one:

10. **A bench result needs a holdout and a re-measure.** A train curve alone is not a claim.

## 8. Open questions

- **Q1-Q2:** answered in Phase 1 (see the archive).
- **Q3 — stall threshold.** Still open. Answer with BENCH-1 and BENCH-2 data: set `stall` where the
  per-variation commit rate drops below about 1 in 5. Count variations (AVO-5), not score calls.
- **Q4 — durable execution (absurd).** Still deferred. Revisit if a campaign run dies mid-way and
  restart from HEAD is not enough.
- **Q5 — does the supervisor help?** BENCH-3 answers it. Criteria are pre-registered in
  [plan/supervisor-bench.md](plan/supervisor-bench.md) §3.
- **Q6 — template or agent-written directive?** Decide after BENCH-3 (AVO-12).
- **Q7 — noise.** Is `floor` enough for game benches, or do we need `dominate-z` (AVO-15)? Decide from
  ARC-6 / CFX-4 measurements.

## 9. Handoff rule

Never write `fixed`, `closes` or `resolves` next to an issue number in a commit message unless you
fixed it. GitHub matches the keyword. Write `filed #49 (not fixed)`.
