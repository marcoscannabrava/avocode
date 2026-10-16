# Tasks

Task specs for [PLAN.md](../PLAN.md). One section per task: goal, acceptance, size, dependencies.
Size: **S** ≤ half a day, **M** ≤ 2 days, **L** more.

`bd` is not installed on this machine. When it is, create one bead per task id below with
`bd create --id <id>` and the deps with `bd dep add`; then beads holds state and this file holds specs
only. Do not add checkboxes here.

Bench-specific tasks live in their own plans: `ARC-*` in [PLAN_ARCAGI.md](PLAN_ARCAGI.md) §7 and
`CFX-*` in [PLAN_CRAFTAX.md](PLAN_CRAFTAX.md) §7.

---

## Milestone M1 — instrument the loop (no agent spend)

### AVO-1 — run budgets (#28)
- **Goal:** bound a run by money and time, not only by turns.
- **Acceptance:** `avo run --max-cost <usd> --max-tokens <n> --max-wall <s>`; each stops before the
  next turn once crossed, with stop reason `budget`. An agent that reports no usage gets one warning
  and the token and cost budgets are marked "unenforced" in the manifest. Unit + e2e tests with the
  stub agent.
- **Size:** S. **Deps:** none.

### AVO-2 — stop on scorer change (#38)
- **Goal:** a long run cannot score with an edited `f`.
- **Acceptance:** the run manifest stores the sha256 of `.avo/score` and of every path in
  `.avo/protected.txt` (when present) at start. Before each turn's commit, `avo run` re-hashes; on a
  change it stops with reason `scorer-changed` and commits nothing. e2e test edits the scorer from the
  stub agent.
- **Size:** S. **Deps:** none.

### AVO-3 — stop on a long plateau
- **Goal:** do not pay for turns after the loop has clearly converged.
- **Acceptance:** `avo run --max-stall-episodes k` (default off) stops after k interventions with no
  version between them. Stop reason `plateau`.
- **Size:** S. **Deps:** AVO-7.

### AVO-4 — supervisor ablation switch
- **Goal:** measure the supervisor's value.
- **Acceptance:** `avo run --supervise on|off|detect`. `off`: no call. `detect`: run the detector and
  record what *would* have fired, inject nothing (so an off-arm still shows its stalls). Recorded in
  the manifest. Default `on`.
- **Size:** S. **Deps:** none.

### AVO-5 — count variations, not score calls (#25, #24)
- **Goal:** stall and thrash count distinct candidates and know which files they touched.
- **Acceptance:** each attempt records `git.tree` (hash of the working tree, avo's own paths
  excluded) and `git.paths` (changed paths vs HEAD). Move `HARNESS_PATHS` / `withoutTrajectory` into
  an import-free module (see #24). Stall counts distinct trees since best; the detail says "5
  variations since v3 (9 score calls)". Thrash requires the same signature **and** overlapping paths;
  a missing `log` no longer collapses every failure into one signature. Old attempt lines without the
  fields still parse.
- **Size:** M. **Deps:** none.

### AVO-6 — `avo` on the child PATH (#41)
- **Goal:** skills work in a target with no install step.
- **Acceptance:** `avo run` and `avo fan` prepend the directory of the running `bin/avo` to the
  child's PATH. e2e: a stub agent runs `avo best` with a stripped PATH.
- **Size:** S. **Deps:** none.

### AVO-7 — intervention effect
- **Goal:** know whether a directive helped.
- **Acceptance:** for each intervention, the timeline records the turns and distinct variations until
  the next version, or `null`. `avo run` prints the count of interventions and how many led to a
  version within 2 turns.
- **Size:** S. **Deps:** AVO-10.

### AVO-8 — hypotheses on attempts
- **Goal:** memory keeps what was expected, not only what happened.
- **Acceptance:** `avo score --hypothesis "<text>" [--expect <config>:<rel-delta>]...` stores both on
  the attempt. `avo commit` carries the last hypothesis on the same tree into the version note or the
  dead-end memory, with the prediction error per config. The supervisor cites the last 3 failed
  hypotheses. The pi `avo_score` tool takes the same fields.
- **Size:** M. **Deps:** AVO-5 (tree hash links score to commit).

### AVO-9 — problem model and the learning-loop skill
- **Goal:** make analysis → model → hypothesis → experiment → update the default step.
- **Acceptance:** `avo init` creates `knowledge/model.md` (a short template: what limits the score
  now, evidence, open questions). `avo-vary/SKILL.md` steps become: analyse, read model, hypothesis
  with prediction (AVO-8), one change, score, compare, record, update model. The supervisor's
  "unexplored K" list never cites `model.md`. `avo install` refreshes the AGENTS.md block.
- **Size:** S. **Deps:** AVO-8.

### AVO-10 — `avo report --json` timeline (#51)
- **Goal:** one joined record of a run; the data under every chart.
- **Acceptance:** per [visuals.md](visuals.md) §1 and §4.1. `verify-run.sh` reads it; its "vs v0"
  uses the lineage root.
- **Size:** M. **Deps:** AVO-5 for since-best by tree (falls back to attempt count without it).

### AVO-11 — `avo report --html` and scorer artifacts
- **Goal:** visuals with no hand drawing.
- **Acceptance:** per [visuals.md](visuals.md) §2-§4. The `f` schema gains optional `artifacts`;
  `avo score --init` templates stay valid.
- **Size:** L. **Deps:** AVO-10.

---

## Milestone M2 — first real intervention (cheap)

### BENCH-1 — plateau pilot on `fuzzysearch`
- **Goal:** the first real supervisor intervention, for the least money.
- **Acceptance:** per [supervisor-bench.md](supervisor-bench.md) Stage 1. Evidence file
  `evidence/bench1-plateau.txt` plus the `avo report` HTML. PLAN Q3 updated with what since-best
  looked like.
- **Size:** S (≤ $10). **Deps:** AVO-1, AVO-2, AVO-4, AVO-5, AVO-10.

---

## Milestone M3 — the main bench

### BENCH-2 — main bench pilot
- **Goal:** a 10-turn run on the chosen long-horizon bench, plus one `avo fan` step on a small model.
- **Acceptance:** per [supervisor-bench.md](supervisor-bench.md) Stage 2 and the bench plan's own
  acceptance. Plateau, noise and cost per turn measured and written down before BENCH-3.
- **ARC route (default):** this task is ARC-13. Build order ARC-1 → ARC-12, ARC-15, per
  [PLAN_ARCAGI.md](PLAN_ARCAGI.md) §7. Gates G0-G2 in its §8 decide the fallback.
- **Craftax route (fallback B):** CFX-1..CFX-7 are built in parallel, so a fallback costs no wait.
- **Size:** M. **Deps:** BENCH-1, ARC-1..ARC-12 (or CFX-*), AVO-11.

### BENCH-3 — supervisor ablation campaign
- **Goal:** answer "does the supervisor help?"
- **Acceptance:** per [supervisor-bench.md](supervisor-bench.md) Stage 3, criteria written into the
  evidence file *before* the runs.
- **Size:** L. **Deps:** BENCH-2, AVO-3, AVO-7.

### BENCH-4 — `pi` comparison (old S9b-2b)
- **Goal:** the same bench under `pi` with the in-session supervisor.
- **Size:** M. **Deps:** BENCH-2.

---

## Milestone M4 — supervisor and noise upgrades (driven by M3 evidence)

Do these only if BENCH-2 or BENCH-3 shows the need.

### AVO-12 — agent-written directive
- **Goal:** the paper's supervisor "steers toward several candidate directions".
- **Acceptance:** `supervise.mode: "agent"` in config. When the deterministic detector fires, a
  short headless turn on `$AVO_PROBE_MODEL` reads the evidence (lineage, failed hypotheses, model.md,
  K) and writes 3-5 named directions, each with a reason. The template directive is the fallback on
  any error. Cost goes into the run's budget.
- **Size:** M. **Deps:** AVO-8, AVO-9, BENCH-3 result.

### AVO-13 — directed fan-out
- **Goal:** diversity by direction, not only by sampling.
- **Acceptance:** `avo fan --directions <file>`: one line per probe, appended to the shared prompt.
  The directive from AVO-12 can be passed straight in.
- **Size:** S. **Deps:** none (best with AVO-12).

### AVO-14 — re-measure the incumbent
- **Goal:** machine drift cannot decide a close call.
- **Acceptance:** config `rescore_best: "near"` re-scores the best version in a temp worktree when
  any config is within 2·floor; the comparator uses the fresh vector; both are recorded.
- **Size:** M. **Deps:** none.

### AVO-15 — noise-aware comparison
- **Goal:** stochastic benches compare on confidence, not one sample.
- **Acceptance:** optional `stderr: {config: n}` in the `f` schema; config `reduce` gains
  `"dominate-z"` with `z` (default 2): improve = `Δ > z·σ`, regress = `Δ < −z·σ`. Without `stderr`
  it behaves like `dominate`.
- **Size:** M. **Deps:** none.

---

## Milestone M5 — hygiene backlog

### AVO-16 — `avo run --resume/--list/--clean` (#27). S.
### AVO-17 — install links do not enter the lineage (#32). S.
### AVO-18 — refuse mixed `higher_is_better` across configs (`score.ts:338`). S.
### AVO-21 — close the in-process escape in `bench/arcagi3`
Its `act` runs in the engine's process, so a policy can likely reach the engine through
`sys._getframe` or `gc` (inferred, not tested; [PLAN_ARCAGI.md](PLAN_ARCAGI.md) §5.7). Write a
failing test first, then run the policy in a child process. Share the runner with ARC-3 and the
Craftax harness. M.
### AVO-19 — nightly real-agent smoke test, outside CI (#19, #23). M.
### AVO-20 — issue sweep
`#1`, `#6`, `#7`, `#8`, `#10`, `#11`, `#12`, `#14`, `#15`, `#16`, `#18`, `#21`, `#22`, `#39`, `#40`,
`#48`, `#50`, `#53`. Each is its own small PR. None blocks M1-M3.
