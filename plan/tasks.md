# Tasks

Task specs for [PLAN.md](../PLAN.md). One section per task: goal, acceptance, size, dependencies.
Size: **S** ≤ half a day, **M** ≤ 2 days, **L** more.

`bd` is not installed on this machine. When it is, create one bead per task id below with
`bd create --id <id>` and the deps with `bd dep add`; then beads holds state and this file holds specs
only. Do not add checkboxes here.

## Progress (2026-10-17)

| Milestone | Done | Open |
| --- | --- | --- |
| M1 — instrument | AVO-1, AVO-2, AVO-4, AVO-5, AVO-6 | AVO-3, AVO-7, AVO-8, AVO-9, AVO-10, AVO-11 |
| M2 — first intervention | — | BENCH-1 (blocked by AVO-22 for `claude` on this machine) |
| M3 — main bench | — | BENCH-2..4, ARC-*, CFX-* |
| M4 — upgrades | AVO-13, AVO-14, AVO-15 | AVO-12 |
| M5 — hygiene | AVO-16, AVO-17, AVO-18, AVO-19, AVO-21, most of AVO-20 | AVO-20 rest, AVO-22..AVO-28 |

Next with no open deps: AVO-10 → (AVO-7, AVO-11), AVO-8 → AVO-9, AVO-22, AVO-23, AVO-25.

Bench-specific tasks live in their own plans: `ARC-*` in [PLAN_ARCAGI.md](PLAN_ARCAGI.md) §7 and
`CFX-*` in [PLAN_CRAFTAX.md](PLAN_CRAFTAX.md) §7.

---

## Milestone M1 — instrument the loop (no agent spend)

### AVO-1 — run budgets (#28)
- **Status:** done — #63, follow-up #85. A budget does not stop a turn already in progress.
- **Goal:** bound a run by money and time, not only by turns.
- **Acceptance:** `avo run --max-cost <usd> --max-tokens <n> --max-wall <s>`; each stops before the
  next turn once crossed, with stop reason `budget`. An agent that reports no usage gets one warning
  and the token and cost budgets are marked "unenforced" in the manifest. Unit + e2e tests with the
  stub agent.
- **Size:** S. **Deps:** none.

### AVO-2 — stop on scorer change (#38)
- **Status:** done — #66. `avo commit` inside a turn also checks the hashes (`AVO_SCORER_HASHES`); not a security boundary. #38 stays open for `--expect-scorer`.
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
- **Status:** done — #60. `AVO_SUPERVISE` also silences `avo supervise` in off/detect turns.
- **Goal:** measure the supervisor's value.
- **Acceptance:** `avo run --supervise on|off|detect`. `off`: no call. `detect`: run the detector and
  record what *would* have fired, inject nothing (so an off-arm still shows its stalls). Recorded in
  the manifest. Default `on`.
- **Size:** S. **Deps:** none.

### AVO-5 — count variations, not score calls (#25, #24)
- **Status:** done — #77 (fixes #24, #25). New `src/harness.ts`; `variations_since_best` in the state.
- **Goal:** stall and thrash count distinct candidates and know which files they touched.
- **Acceptance:** each attempt records `git.tree` (hash of the working tree, avo's own paths
  excluded) and `git.paths` (changed paths vs HEAD). Move `HARNESS_PATHS` / `withoutTrajectory` into
  an import-free module (see #24). Stall counts distinct trees since best; the detail says "5
  variations since v3 (9 score calls)". Thrash requires the same signature **and** overlapping paths;
  a missing `log` no longer collapses every failure into one signature. Old attempt lines without the
  fields still parse.
- **Size:** M. **Deps:** none.

### AVO-6 — `avo` on the child PATH (#41)
- **Status:** done for `avo run` and `avo fan` — #65. #41 stays open for an `avo doctor` check and an export line from `avo install`.
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
- **Status:** done — #64, with #80 (`avo fan --dirty`).
- **Goal:** diversity by direction, not only by sampling.
- **Acceptance:** `avo fan --directions <file>`: one line per probe, appended to the shared prompt.
  The directive from AVO-12 can be passed straight in.
- **Size:** S. **Deps:** none (best with AVO-12).

### AVO-14 — re-measure the incumbent
- **Status:** done — #69, with `rescore_links` for untracked inputs (venv, game files).
- **Goal:** machine drift cannot decide a close call.
- **Acceptance:** config `rescore_best: "near"` re-scores the best version in a temp worktree when
  any config is within 2·floor; the comparator uses the fresh vector; both are recorded.
- **Size:** M. **Deps:** none.

### AVO-15 — noise-aware comparison
- **Status:** done — #67; a rescored close call uses z·σ (merge fix).
- **Goal:** stochastic benches compare on confidence, not one sample.
- **Acceptance:** optional `stderr: {config: n}` in the `f` schema; config `reduce` gains
  `"dominate-z"` with `z` (default 2): improve = `Δ > z·σ`, regress = `Δ < −z·σ`. Without `stderr`
  it behaves like `dominate`.
- **Size:** M. **Deps:** none.

---

## Milestone M5 — hygiene backlog

### AVO-16 — `avo run --resume/--list/--clean` (#27). S.
- **Status:** done — #68 (fixes #27). Manifest stores pid + host; a live run cannot be resumed.
### AVO-17 — install links do not enter the lineage (#32). S.
- **Status:** done — #71 (fixes #32); links go to the git exclude file; `--uninstall` (#78) removes them.
### AVO-18 — refuse mixed `higher_is_better` across configs (`score.ts:338`). S.
- **Status:** done — #56.
### AVO-21 — close the in-process escape in `bench/arcagi3`
- **Status:** done — #82. Escape was real (5.0 vs 0.277). Child process, clean env, `/proc/<ppid>` refused. Hardening left in AVO-24.
Its `act` runs in the engine's process, so a policy can likely reach the engine through
`sys._getframe` or `gc` (inferred, not tested; [PLAN_ARCAGI.md](PLAN_ARCAGI.md) §5.7). Write a
failing test first, then run the policy in a child process. Share the runner with ARC-3 and the
Craftax harness. M.
### AVO-19 — nightly real-agent smoke test, outside CI (#19, #23). M.
- **Status:** done — #72. Found the blocker in AVO-22. #19 and #23 stay open (pi/codex never run for real; no CI job).
### AVO-20 — issue sweep
- **Status:** mostly done. Merged: #57 (#1), #58 (#8), #59 (#39), #61 (#10), #62 (#40), #70 (#12), #73 (#48), #74 (#15), #75 + #83 (#50), #76 (#53), #78 (#18), #79 (#22), #80 (#21), #81 + #84 (#14). Open for an owner decision: #6, #7, #11, #16.
`#1`, `#6`, `#7`, `#8`, `#10`, `#11`, `#12`, `#14`, `#15`, `#16`, `#18`, `#21`, `#22`, `#39`, `#40`,
`#48`, `#50`, `#53`. Each is its own small PR. None blocks M1-M3.

---

## Follow-ups found in review (2026-10-17)

### AVO-22 — claude turns under an org policy that blocks bypass mode
- **Goal:** `avo run --agent claude` works where `disableBypassPermissionsMode` is set (true on this
  machine via `~/.claude/remote-settings.json`; the flag is ignored silently, the turn runs in `auto`
  and every Bash/Edit is denied). #72 now detects this and stops with `approval-refused`.
- **Options (owner decides):** org exception; a machine without the policy; pi or codex as the agent;
  or claude turns with explicit `--allowedTools` rules instead of bypass mode. Do not work around the
  policy.
- **Size:** S once decided. **Deps:** none. **Blocks:** BENCH-1 with `claude` on this machine.

### AVO-23 — resume rebuilds versions from git
- **Goal:** a run killed between `avo commit` and the manifest write loses that version from the
  manifest. The `kill -9` resume e2e check (§ "manifest and git disagree") flaked once in CI for this
  reason. Resume should credit versions from `head_before..HEAD`, as #42 did for turns.
- **Size:** S. **Deps:** none.

### AVO-24 — OS-level sandbox for bench policies
- **Goal:** the audit hook is a tripwire, not a wall: a policy can turn it off and read game files. Use
  Landlock (via ctypes) or `unshare -Urn` without root, with a macOS fallback. Also run the contract
  suite (`test_policy.py`) through `PolicyProcess`; today it runs policy code with no hook.
- **Size:** M. **Deps:** none. Needed before ARC-13 / CFX pilots.

### AVO-25 — refresh the paper code notes
- **Goal:** `docs/paper/code-core.md` and `code-orchestration.md` quote the tree at `d05177c`. Many
  claims are now stale (no budgets, no rescore, mixed directions undetected, line numbers). Re-anchor
  them to the new main.
- **Size:** M. **Deps:** none.

### AVO-26 — per-turn timeout respects the wall budget
- **Goal:** with `--timeout 0`, a turn can overrun `--max-wall` without limit. Give each turn
  `min(--timeout, wall left)`. Behavior change: owner decides.
- **Size:** S.

### AVO-27 — rest of #41, #38, #19, #23
- `avo doctor` checks that `avo` resolves on PATH; `avo install` prints the export line (#41).
- `avo score --expect-scorer <sha256>` (#38).
- One real `pi` and `codex` smoke run with a cheap model; `--help` flag checks for agent CLIs (#19, #23).
- **Size:** S each.

### AVO-28 — owner decisions collected in review
Each is small once decided; none blocks M1.
1. Hash `.avo/config.json` as part of `f` in the scorer-change stop (AVO-2)?
2. `--resume <id> --max-iters N` to raise the budget (AVO-16)?
3. `dominate-z`: when only one side has a stderr, count the missing side as 0 (today) or equal to the
   other (stricter)?
4. qmd reindex on commit: wait up to 60 s (today) or run `qmd embed` in the background?
5. Thrash for harness errors (environmental) even without path overlap (AVO-5)?
6. Agent log cap of 256 MiB (#79)?
7. pi `avo_commit` output gains `ok` and the qmd reindex?
8. Uninstall stays `avo install --uninstall` or becomes `avo uninstall`?
9. Issues #6 (`git add -A`), #7 (ties), #11 (memory key namespace), #16 (query budget).
