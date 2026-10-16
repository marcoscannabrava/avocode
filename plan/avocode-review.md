# avocode review: what is missing and what to improve

Date: 2026-10-16. Tree: `ea505a3`. Sources: `docs/paper/code-core.md`,
`docs/paper/code-orchestration.md`, `docs/paper/evaluation.md`, the open GitHub issues, and the code.

This review asks one question: **what must change before a long bench run can test the whole
system, the supervisor included?** Items are grouped by area and ranked inside each group. Task ids
(`AVO-n`) point to [tasks.md](tasks.md).

---

## 1. Summary

The core is sound. `f`, `P_t`, `K`, memory and the commit rule are built, tested (441 unit tests,
496 e2e checks), and used in two real runs. The weak part is everything a *long* run needs:

1. **The supervisor has no real evidence.** It fired 0 times in 9 agent turns. There is no switch to
   turn it off, so its value cannot be measured even when it fires.
2. **The stall counter mixes units.** It counts `avo score` calls, not variations. One turn can make
   one call or twenty.
3. **The loop records outcomes, not hypotheses.** Memory keeps "v3 won" and "refused: small -4.7%".
   It does not keep "I expected X because of Y, and saw Z". That is the learning step.
4. **A long run has no budget and no tamper stop.** Cost and wall time are unbounded (#28). A scorer
   edit is caught only after the run (#38).
5. **There are no generated visuals.** All seven figures are hand-made SVGs. `verify-run.sh` prints
   text, and its "vs v0" column is wrong on a resumed run (#51).
6. **Noise handling is one number.** `floor` is the only noise tool. The incumbent is never
   re-measured. That is fine for a fast timing bench, and weak for a stochastic game bench.

---

## 2. Supervisor

| # | Gap | Evidence | Fix | Task |
| --- | --- | --- | --- | --- |
| S1 | No real intervention ever | 0 in 9 turns; `since_best` peaked at 2 (`evaluation.md` §3.1) | a bench that plateaus ([supervisor-bench.md](supervisor-bench.md)) | BENCH-1..3 |
| S2 | No ablation switch | `run.ts:674` always calls `supervise()` | `avo run --supervise off\|on`, recorded in the manifest | AVO-4 |
| S3 | Stall counts score calls | `supervise.ts:196-205` counts attempts; #25 | add a tree hash to each attempt; count *distinct* candidate trees since best | AVO-5 |
| S4 | Thrash has no region | #24; `Attempt` has no file list | record changed paths per attempt (free from `git status`) | AVO-5 |
| S5 | No effect metric | interventions are recorded, outcomes are not linked | per intervention: turns and attempts until next version, or none | AVO-7 |
| S6 | Directive is a fixed template | `renderDirective`, `supervise.ts:375-401`; paper's supervisor "reviews the trajectory and steers toward several candidate directions" | opt-in `supervise.mode: "agent"`: a small-model turn reads the evidence and writes 3-5 named directions; the detector stays deterministic | AVO-12 |
| S7 | Fan diversity is sampling only | `avo-fanout/SKILL.md:58-60`: one prompt to all probes | `avo fan --directions <file>`: one direction per probe, e.g. from S6 | AVO-13 |
| S8 | A plateau never ends the run | only `max-iters`, STOP, 3 idle turns | `--max-stall-episodes k`: stop after k interventions with no version | AVO-3 |

S3 matters most for the bench work. In `fuzzysearch` each turn ran `avo score` several times. A
threshold of 5 could mean one turn or five. A tree hash makes the unit "a distinct candidate". It
also makes re-scores of an unchanged tree free (#25).

---

## 3. The learning loop

The user's hypothesis for the ARC project ("no analysis → model → hypothesis → experiment → update
loop") applies to avocode too. avocode has the *experiment* and *memory* parts. It is weak on the
*model* and *hypothesis* parts.

| Step | What avocode has | What is missing |
| --- | --- | --- |
| analysis | the agent can profile; nothing asks it to | a skill step: measure where the cost or failure is before editing |
| model | `K` holds outside docs and `lineage/` | a living **problem model** the agent reads and updates each turn |
| hypothesis | `--why` on commit, after the fact | a hypothesis with a *predicted* effect, written *before* the score |
| experiment | `avo score`, `avo commit` | — (strong) |
| memory | versions, dead ends keyed by reason + vector | the prediction error: "expected −20%, got +3%" |
| update | none explicit | rewrite the model when a prediction fails |

Proposed changes, small and agent-agnostic:

1. **`avo score --hypothesis "<text>" --expect "<config>:<delta>"`** stores the claim on the attempt
   in `.avo/attempts.jsonl`. `avo commit` copies it into the version note or the dead-end memory. The
   supervisor cites the last few failed hypotheses, not only the refusal reasons. (AVO-8)
2. **`knowledge/model.md`**, the problem model. `avo init` creates a stub. The `avo-vary` skill says:
   read it first, update it when a prediction fails. It is in `K`, so `avo know query` finds it, and
   `git log -p knowledge/model.md` shows how understanding changed. (AVO-9)
3. **Rewrite the `avo-vary` loop** as: analyse → read model → state hypothesis and prediction →
   change one thing → score → compare with the prediction → record → update model. (AVO-9)

None of this changes the commit rule. It changes what the next fresh process can read.

---

## 4. Long unattended runs

| # | Gap | Fix | Task |
| --- | --- | --- | --- |
| L1 | No cost, token or wall budget (#28). Run 2 cost $2.73 per turn; a plateau is where money burns | `--max-cost`, `--max-tokens`, `--max-wall`; a run whose agent reports no usage says so once | AVO-1 |
| L2 | Scorer tamper caught only after the run (#38) | manifest stores the hash of `.avo/score` + protected files at start; `avo run` stops on change | AVO-2 |
| L3 | `avo` not on the target's PATH (#41) | `avo run` prepends its own `bin/` to the child PATH | AVO-6 |
| L4 | No `avo run --resume/--list/--clean` (#27) | mirror `avo fan` | AVO-16 |
| L5 | Absolute install links land in the lineage (#32) | relative links or gitignore them | AVO-17 |

L1 and L2 must land before any long bench run. Both are cheap.

---

## 5. Noise and measurement

`fuzzysearch` had a 0-2.5% IQR, so `floor: 0.03` was enough. Game benches are different. ARC-AGI-3
needs 24 rollouts per game to get per-config noise down to about 6% (`evaluation.md` §1.2). Craftax
will be similar.

| # | Gap | Fix | Task |
| --- | --- | --- | --- |
| N1 | Incumbent never re-measured; all drift in Table D is one way (busy box) | opt-in `rescore_best`: `avo commit` re-scores the best version in a temp worktree when the candidate is within 2·floor | AVO-14 |
| N2 | Comparator sees one number per config | optional `stderr` per config from the scorer; the comparator then needs `delta > z·σ` instead of a fixed floor | AVO-15 |
| N3 | Mixed `higher_is_better` across configs not detected (`score.ts:338`) | refuse the attempt as a harness error | AVO-18 |
| N4 | With `floor > 0`, small losses can add up over versions | report drift vs the lineage root in `avo report` | AVO-10 |

N1 and N2 are not needed for a first ARC or Craftax run if the bench keeps scoring deterministic
(fixed seeds). They become needed if the bench uses fresh seeds.

---

## 6. Evidence and visuals

All figures are hand-drawn. Any new bench result needs them redrawn by hand. See
[visuals.md](visuals.md) for the full design.

| # | Gap | Fix | Task |
| --- | --- | --- | --- |
| V1 | No joined timeline of attempts, versions, interventions, turns, cost | `avo report --json`: one timeline from what is already on disk | AVO-10 |
| V2 | No charts | `avo report --html`: a self-contained page; SVG export for the paper | AVO-11 |
| V3 | "vs v0" wrong on resumed runs (#51) | take v0 from the lineage root, via the timeline | AVO-10 |
| V4 | The scorer cannot hand back images | optional `artifacts: {name: path}` in the `f` schema (today an unknown key warns) | AVO-11 |

---

## 7. Agents and probes

| # | Gap | Fix | Task |
| --- | --- | --- | --- |
| A1 | `avo fan` never ran in a real run; no small-model key | get one key (OpenRouter is the simplest); run one fan step on the bench | BENCH-2 |
| A2 | Only `claude` was ever used in a real run | S9b-2b: the same bench under `pi` with both extensions | BENCH-4 |
| A3 | Skills not tested against real agents (#19, #23) | a nightly job, outside CI, that runs one turn per agent on a tiny target | AVO-19 |

---

## 8. Backlog (hygiene, lower priority)

`#6` `git add -A` stages everything · `#7` ties cannot be recorded · `#8` `readLineage` reads all
history · `#14` commit does not reindex qmd · `#39` `avo commit --json` has no `ok` · `#50` no
`--help` per subcommand · `#48` oxlint warnings never fail · `#53` lint can hang · `#1` CI Node 20 ·
`#22` probe log truncated · `#21` probes miss uncommitted work · `#10`, `#11`, `#12`, `#15`, `#16`,
`#18`, `#40`. Grouped as AVO-20 in [tasks.md](tasks.md). None blocks the bench work.

---

## 9. What not to change

- **The commit rule.** Dominance plus a floor worked. Do not loosen it to make a bench move.
- **The deterministic detector.** If an LLM supervisor lands (S6), it writes the directive. It does
  not decide when to fire. A detector you can test at its exact firing point is worth keeping.
- **Fresh process per turn.** It is what makes runs restartable and agent-agnostic.
