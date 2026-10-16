# ARC-AGI-3 as a long-horizon avocode bench

Status: plan. Written 2026-10-16 from a read of `/home/marcos/code/arc-prize-2026-arc-agi-3/`
(called **arcjev** below, after its package) and of `bench/arcagi3/` in this repo. Paths that start
with `arcjev/`, `evidence/`, `knowledge/`, `runs/`, `logs/` or `environment_files/` are in the arcjev
repo. Paths that start with `bench/`, `src/`, `docs/` or `plan/` are in avocode.

Related plans: [supervisor-bench.md](supervisor-bench.md) (why we need this bench),
[visuals.md](visuals.md) (`avo report`, scorer `artifacts`), [tasks.md](tasks.md) (`AVO-*`,
`BENCH-*`).

---

## 1. Summary

- arcjev is a full pipeline with no result. A frozen Qwen3.5-4B scores a short list of legal actions
  for each frame (SemIf, one forward pass). The pipeline has a play harness, an HTTP endpoint, a Kaggle
  notebook and an avocode scorer.
- The model never completed a level. In total it played about 270 actions on 1 to 5 games, at 11.6
  to 23.7 s per action on CPU. Random play is also at zero at every budget that fits on this machine.
- No avocode loop ever ran on arcjev: no version, no attempt, no `avo run`. Three hand-run
  `PROGRESS.jsonl` iterations end on the same blocker: "No GPU on this machine".
- **Verdict on the learning-loop hypothesis: it holds, but it is not the first blocker.** The agent
  has no world model and no hypothesis-and-test loop. Its memory is the last 8 actions. The
  development process had no measured experiment loop either. But even with such a loop, `f` was
  impossible to measure: one full `f` run was about 8.5 days of CPU, and it read 0.0 everywhere.
- The fix is to move the LLM out of the per-step policy and into the avocode turn. The policy
  becomes fast Python with an explicit inner learning loop. `f` becomes a per-level solve rate on
  the 25 official public games, with a level skip, so that one solved level always shows.

---

## 2. What exists

### 2.1 arcjev architecture

The package has one decision per frame and one HTTP call per decision (`README.md` "How it works").

| Component | File | What it does |
| --- | --- | --- |
| State encoder | `arcjev/state.py:33` `encode_grid`, `:138` `build_state` | 64x64 grid becomes 64 strings of letters `a`..`p` (about 1,300 tokens). Adds the diff, the level and the history. |
| History window | `arcjev/state.py:18` `HISTORY_LIMIT = 8`, `:116` `history_of` | The model sees only the last 8 steps. |
| Shift detector | `arcjev/state.py:70` `translation` | Finds a one-colour shape that moved by `(dx, dy)`. |
| Action notes | `arcjev/memory.py:55` `action_notes` | One sentence per action, such as `ACTION3 moved a shape left 5 in 3 of 3 tries`. Rebuilt from the 8-step history on every call. |
| Loop breakers | `arcjev/memory.py:70` `stuck` (5 no-op steps), `:120` `dead_targets` | Drop the last action, or drop click targets that did nothing. |
| Click targets | `arcjev/candidates.py:27` `find_candidates`, `:10` `MAX_CANDIDATES = 16` | At most 16 blocks, because SemIf takes 2 to 16 options. |
| Prompts | `arcjev/decisions.py:13` `PROMPT_VERSION = "v3"`, `:15`, `:26`, `:36` | Three questions: which action, which target, which target is a goal. Fixed key meanings: ACTION1 = up, and so on. |
| Policy | `arcjev/policy.py:124` `choose` | Scores the rows, takes the argmax (`:37` `best`). Greedy, one step, no plan. |
| Decider | `arcjev/decider.py:73` `SemifDecider` | SemIf over `llama.cpp` (CPU, Q4_K_M GGUF) or torch (GPU). |
| Endpoint | `arcjev/serve.py:79` `build_app`; `arcjev/client.py`; `arcjev/agent.py` | Flask `POST /v1/act`, a client, and the ARC framework agent for Kaggle. |
| Play harness | `arcjev/play.py:190` `play_game`, `:52` `HELD_OUT` | Offline `Arcade`, writes `runs/<time>-<pid>-<policy>/`. |
| Scorer | `.avo/score`, `.avo/config.json` (`dominate`, `floor: 0.1`), `.avo/protected.txt` | One config per training game (20). Holdout in `log` only. |
| Kaggle | `scripts/build_notebook.py`, `scripts/release.sh`, `example.ipynb` | Notebook and dataset build. Never pushed (no credentials). |
| Fine-tuning | `docs/adr/history.md` "Phase 8" | Planned, not built. |
| CLM | `CLM/` submodule (last commit, 2026-09-26) | Another one-pass option scorer (CLM-8B). No code uses it yet. |

What is **not** there:

- No world model. Nothing predicts the next frame or stores a state graph.
- No hypothesis about the goal. The only goal signal is the prompt question at
  `arcjev/decisions.py:36`.
- No experiment selection. Exploration is the argmax plus two loop breakers.
- No memory past 8 steps, none across levels, none across games or episodes.
- No learning from results. The weights are frozen, and phase 8 was never built.

### 2.2 Development process

- Phases 0 to 9 were built by four "ralph" loops on `PLAN.md` (`logs/2026*/run.log`). Their cost
  was about $71.7 in total. The last iterations of two runs cost $0.02 to $0.09 each, so the loop was
  idle by then (inference: nothing left to do and no way to measure).
- `PROGRESS.jsonl` has three iterations. Each ends with "next: measure" and "blocker: No GPU".
- `.avo/` holds only `config.json`, `gate.sha256`, `protected.txt` and `score`. There is no
  `attempts.jsonl`, no `runs/`, and no lineage commit.
- `PLAN.md` and `TASKS.md` are deleted in the working tree and not committed.

### 2.3 avocode's own `bench/arcagi3`

- Ten community games from `theredbluepill/arc-interactive` (MIT). A random walk scores 0.277
  (`bench/arcagi3/README.md`).
- 24 rollouts of 250 actions per game, `floor: 0.1` measured from rng noise
  (`bench/arcagi3/bench/run.py:55`, `:75`).
- A new `Policy` is built for each episode (`run.py:152`), so nothing persists across rollouts.
- Only a scripted ladder exists: 0.277 → 0.320 committed, cell clicks refused. No agent run
  (`docs/paper/evaluation.md` §1.2).

---

## 3. Results so far

Every number has a source. Inferences are marked.

### 3.1 Random baseline (official public games)

| Setting | Result | Source |
| --- | --- | --- |
| 25 games, 200 actions, seeds 0, 1, 2 | competition 0.0000, 0.0000, 0.1143; 1 level in total | `knowledge/arcjev-research.md` "Phase 2 measurements" |
| Same, other rng layout | 0.0057, 0.0374, 0.1606 | same |
| 20 train games, 3 seeds, 200 actions | 0.0381 competition, 0.0476 subset mean | `task.md`; `knowledge/arcjev-research.md` "Phase 6 findings" |
| 5 held-out games, same | 0.0000 at every seed | same |
| 20 train games, 60 actions, seed 0 | 0 levels; effective actions 22 to 60 of 60 | `evidence/dense-signal-random-train.txt` |
| Reset budget 0 to 50 | no steady gain | `knowledge/arcjev-research.md` "Reset budget" |

### 3.2 The decider (Qwen3.5-4B through SemIf)

| Run | Games × actions | Levels | Time per action | Source |
| --- | --- | --- | --- | --- |
| v2, 1 seed | 5 × 30 | 0 | 21.4 s (3,217 s for 150) | `logs/phase6/decider-v2.json` |
| v2 | ls20 × 50 | 0 | 20.4 s | `evidence/score-ls20-decider.json`; `PROGRESS.jsonl` iter 2 |
| v2 | ls20 × 5 | 0 | 11.6 s | `runs/20260922T223304Z-1642311-decider/summary.txt` |
| v2 | ls20 × 10 | 0 | 19.2 s | `runs/20260922T225322Z-2092682-decider/summary.txt` |
| v3 | lp85, vc33, ls20 × 20 (lp85 hit GAME_OVER at 16) | 0 | 23.7 s | `runs/20260925T175224Z-355525-decider/summary.txt` |
| "arm A" | — | no result | — | `evidence/decider-arm-a.json` is 0 bytes; `.txt` is only llama.cpp load log (inference: aborted) |

- In total the decider played about 271 actions and completed 0 levels (sum of the rows above).
- First qualitative read: on ft09 the model clicked the same cell twice, although the history said
  the first click did nothing (`knowledge/arcjev-research.md` "Phase 3 measurements").

### 3.3 Facts about the games and the engine

| Fact | Value | Source |
| --- | --- | --- |
| Public games, levels | 25 games, 183 levels | `environment_files/*/*/metadata.json` (counted 2026-10-16) |
| Human baseline, sum | 17,135 actions (train 20 games: 145 levels, 13,309 actions) | same |
| First-level baseline | 7 (vc33) to 78 (g50t) actions | same |
| Engine speed | 893 to 2,748 random actions/s (ls20, ft09, vc33, sb26) | measured 2026-10-16, scratch script, arcjev `.venv` |
| Determinism | the same code gives the same frame hash on two runs; `seed=0` and `seed=5` give the same hash | same measurement, 4 games × 300 actions |
| NVIDIA AVO claim | 183 levels in 6,624 actions, Claude Opus 5, text grid | `knowledge/arcjev-research.md:170` quoting the NVIDIA blog. Not checked here. |

Note: 183 levels is the whole public set. The NVIDIA agent used fewer actions than the human
baseline. So the ceiling is high, and a strong LLM in the loop can reach it.

### 3.4 A metric mismatch in arcjev

`task.md` says `primary` is "the mean fraction of levels completed". But `.avo/score` averages
`PlayResult.score` (`.avo/score` lines 158-163), and `play.py:249-256` fills that from
`arcade.get_scorecard()`. That is the competition formula: `(baseline / actions)^2` per level,
weighted by level index (`arc_agi/scorecard.py:168-206`). Inference: the scale is 0 to 100, but the
log prints "of 1.0". The effect: `f` also punishes actions spent on exploration.

---

## 4. Why it stalled

Ranked by how much each cause blocked progress.

1. **`f` could not be measured.** At about 20 s per action on CPU, the shipped budget (25 games × 3
   seeds × 200 actions) is about 8.5 days (`PROGRESS.jsonl` iter 1 and 2). Every iteration ended on
   "No GPU". No GPU was rented. Without a measurement there is no loop of any kind.
2. **The signal is all zeros at a budget that fits.** At 50 to 200 actions, random and the decider
   both read 0.0 on almost every game (§3.1, §3.2). Under `dominate`, a zero config cannot rank a
   change. The dense pair `effective_actions` and `distinct_frames` was added to `log`, but it
   rewards motion, saturates on 5 of 20 games, and is one number, not two
   (`knowledge/arcjev-research.md` "Dense progress signal").
3. **The wrong primitive for the job.** A frozen 4B model scores one step at a time, greedily, from
   an 8-step window. It has no state graph, no plan and no stored rule. ARC-AGI-3 levels need tens to
   hundreds of steps of directed search (§3.3 baselines). The model also does not use the evidence
   it is given (the ft09 double click). This is where the learning-loop hypothesis is right.
4. **No learning loop, at either level.**
   - Inside the agent: no analysis → model → hypothesis → experiment → update. Notes are recomputed
     from 8 steps, then forgotten (`arcjev/state.py:18`, `arcjev/memory.py:55`).
   - In development: no `avo run`, no versions, no recorded dead ends. Three `PROGRESS.jsonl` lines
     and about $72 of build loops went to scaffolding.
5. **Deployment before signal.** Phases 3 to 5 (endpoint, framework agent, Kaggle notebook) were
   built before any policy beat random. They hold most of the code and none of the score.
6. **Noise and floor not measured.** `floor: 0.1` is copied from the avocode bench
   (`.avo/score` lines 42-44). Random play swings 0.0000 to 0.1143 between seeds (§3.1). A game that
   leaves zero by luck then vetoes later commits at -100%.
7. **Metric mismatch.** See §3.4. The efficiency term makes exploration cost score, which works
   against any learning policy.

Not blockers: engine speed (≥ 890 actions/s offline), reproducibility (the engine is deterministic),
and the observation format (an exact 64x64 grid is enough; `knowledge/arcjev-research.md:162`).

---

## 5. The plan

### 5.1 Idea in one paragraph

Keep the LLM, but move it. The **coding agent** is the slow, smart learner: it reads rollouts, forms
a theory of why levels fail, and changes the policy code. The **policy** is fast Python with its own
inner learning loop: it explores, builds a world model of the current game, tests hypotheses about
the goal, and plans. `f` runs offline at engine speed, so one full score takes about a minute, and a
turn can run many experiments. Hard levels make the agent plateau, so the supervisor fires.

### 5.2 Two loops

```
OUTER (one avocode turn, the coding agent)            INNER (one game episode, the policy)
analysis   read levels.json, strips, surprise stats   perceive  objects, agent sprite, HUD, diff
model      knowledge/model.md + avo mem               model     state graph + action-effect rules
hypothesis "levels X fail because Y" (--hypothesis)   hypothesis goal and mechanic candidates
experiment .avo/score --config g, then avo score      experiment pick the action that splits them
update     avo commit / avo mem add / avo know add    update    predict → observe → revise, keep across levels
```

#### Inner loop: the candidate's skeleton

Ship `src/` with this structure and a random baseline inside it. The agent improves the parts. It may
also replace them.

| Module | Data | Job |
| --- | --- | --- |
| `src/perceive.py` | `Percept`: background colour, objects (colour, cells, bbox, id), HUD rows, frame key | Segment the frame. Track objects from frame to frame. |
| `src/model.py` | `WorldModel`: `graph[state][action] → next_state`; `effects[action] → Effect` (shift, toggle, none, with counts); hazards (states before GAME_OVER) | Learn from each transition. Predict the next percept. |
| `src/hypo.py` | `Hypothesis`: kind (`goal` or `mechanic`), predicate, prior, support, contradictions | Keep a ranked set: "reach colour c", "fill pattern", "match the key shape", "click toggles". |
| `src/explore.py` | frontier of untried `(state, action)` pairs | Choose an experiment: an untried action, or the action where live hypotheses predict different results. Else plan by BFS in the graph to the goal under the best hypothesis. |
| `src/memory.py` | per game: action meanings, object roles, the goal type that worked; per level: the state graph | Keep game knowledge across levels in one episode. Reset the state graph at a new level. |
| `src/policy.py` | `Policy(action_space, rng)`, `act(frame)` | Run the loop once per call: perceive → update → check prediction → revise → choose → predict. |

Optional hook: `Policy.explain()` returns `{"predicted": key, "hypotheses": [...]}`. The harness
compares the prediction with the real next frame and logs a **surprise rate** per game. This is a
diagnostic in `log` and artifacts, never a `scores` entry.

Reusable parts from arcjev (copy, not import): `state.translation` (shift detector),
`candidates.find_candidates` (click targets), `memory.action_notes` (effect counts), and the
`frame_key` hash (`arcjev/types.py:162`). The SemIf decider, the endpoint and the Kaggle code stay
out: they cannot run at bench speed.

#### Outer loop: what the agent does in a turn

1. **Analysis.** Read `avo best`, the per-level line in `log`, and `.avo/artifacts/` of the best
   version (strips of unsolved levels, surprise rates).
2. **Model.** Update `knowledge/model.md` (AVO-9): what limits the score now, and the evidence.
3. **Hypothesis.** One sentence with a prediction: "a wall model will solve ls20 L2-L3 and tr87 L1".
   Pass it as `avo score --hypothesis ... --expect ls20:+0.28` (AVO-8).
4. **Experiment.** `.avo/score --config <game>` while iterating. Then the full `avo score`.
5. **Update.** `avo commit --why`. Record a refusal or a wrong prediction with `avo mem add`. Add a
   new game mechanic to K with `avo know add`.

`avo fan` fits well here: N directions (wall model, click semantics, goal hypotheses) on a small
model, one promoted.

### 5.3 Mapping onto avocode

| avocode concept | ARC bench |
| --- | --- |
| target repo | new `bench/arcagi3-learn/`, materialised by `bench/init.sh --target arcagi3-learn` |
| candidate | `src/**` only |
| `f` | `.avo/score` → `bench/run.py --config <game>` per game |
| configs | the 20 train games (all of the 25 public games except `HELD_OUT`) |
| `scores[g]` | smoothed solve count for game `g` (§5.4) |
| `primary` | plain mean fraction of train levels solved, over seeds |
| `reduce`, `floor` | `dominate`, `floor` from ARC-6 (start value 0.05) |
| `supervise` | `stall: 5`, `thrash: 3` (defaults); tune per supervisor-bench.md §4 |
| K | ARC-AGI-3 docs; a mechanics catalogue written from train games only; exploration papers; this plan |
| `avo mem` | dead ends, floor and budget facts, refused ideas with the blocking config |
| lineage | each version's per-game vector; per-level detail in `.avo/artifacts/v<NNN>/levels.json` |
| holdout | 5 official public games + 8 arc-interactive games, scored outside `f` |

### 5.4 The metric

**Episode shape: a game with level skip.** One `Policy` object plays a whole game, so it can carry
what it learned from level to level. Each level has its own budget:
`budget[k] = max(50, B × baseline_actions[k])`, with `B = 3` as a start (ARC-7 sets it). When the
budget runs out, the harness calls `set_level(k + 1)` (`arcengine/base_game.py:148`) and marks level
`k` as failed. A GAME_OVER inside a level resets that level (`level_reset`, `base_game.py:326`) and
the budget keeps counting.

Why: in the plain chain, an unsolved level 1 hides all later levels. With skip, a policy that solves
level 4 but not level 1 gets credit. The vector moves in steps of one level, not one game.

The policy is told a skip happened by a frame field `level_index` (the harness adds it). It gets no
game id, no seed and no baseline.

**Per-game score.** Let `n_g` be the number of solved (level, seed) pairs, out of `L_g × S`. Then

```
scores[g] = (n_g + c) / (L_g × S + c)        c = smoothing constant, from ARC-6 (start: 20)
primary   = Σ n_g / Σ (L_g × S)              plain solve rate over all train levels
```

Why the smoothing: `avo commit` compares relative deltas. A game at 0 or near 0 swings ±100% on one
lucky level and vetoes every commit (`sq01` in `bench/arcagi3/bench/run.py:44`). With `c = 20`,
`S = 3`, one level on one seed moves a game by at most 1/20 = 5%, which `floor` absorbs. One level on
all three seeds moves it by at least 3/(20 + 30) = 6%, which `floor: 0.05` lets through. ARC-6 checks
these numbers. If avocode gains an absolute floor or `dominate-z` (AVO-15), drop the smoothing.

**In `log`, never in `scores`:**

- Per game, one line of per-level marks, such as `ls20 ✓✓✗✗✗✗✗ 2/7 (s0 2, s1 2, s2 2)`.
- Competition score, by the official formula, in the plain chain mode with no skip. This is the
  number to compare with Kaggle.
- Surprise rate per game, when `explain()` exists.
- Actions per solved level, as a ratio to the human baseline.

**Seeds.** The engine is deterministic and ignores `seed` (§3.3). So `S` seeds only vary the
policy's `rng`. A fully deterministic policy gets the same result on every seed. Start with `S = 3`.

**Run time.** Train budget at `B = 3`: about 40,000 actions per seed, 120,000 for `S = 3`. At about
1,500 actions/s that is 80 s of engine time, split over 20 configs with `avo score --parallel`. Plus
policy time, capped by the compute gate. Target: full `f` ≤ 3 min on this machine.

### 5.5 Noise and floor

- ARC-6 measures, on the shipped baseline and on one ladder rung:
  (a) the same code three times: the vector must be bit-identical, or it is a bug;
  (b) a "twin" policy with the same behaviour but a different rng draw order: per-game spread.
- Set `floor` to the 90th percentile of the twin spread, but below the gain of one level on all
  seeds in the largest game. If those two do not fit together, raise `S` or `c` and measure again.
- Record the numbers with `avo mem add` and in the bench README, as `bench/arcagi3/README.md` does.
- AVO-14 (re-measure the incumbent) is not needed here: the score has no machine drift. Wall time
  is used only by the compute gate.

### 5.6 Holdout

- **Official holdout:** `ft09 lp85 sk48 tn36 wa30` (the arcjev `HELD_OUT`, `arcjev/play.py:52`).
  Keep it, so the numbers stay comparable with arcjev's random baseline (0.0000).
- **Out-of-family holdout:** the 8 arc-interactive games in `test/fixtures/arcagi3/holdout.lock`.
- **Official API:** `test/fixtures/arcagi3/score-api.sh` with `ARC_API_KEY`, when one is present.
- Holdout files live **outside** the target repo. `test/fixtures/arcagi3-learn/score-holdout.sh
  <target>` runs the target's own `bench/run.py --games-dir <holdout>` for each committed version.
  The report draws the holdout line next to the train line.
- Holdout never gates a commit. Under `dominate` every entry is a veto, and gating on the holdout
  spends it.

### 5.7 Anti-gaming

| Threat | Defence |
| --- | --- |
| Edit `f`, the games or the floor | Hash gate over `bench/run.py`, `bench/games.lock`, `bench/setup.sh`, `test/`, `requirements.txt`, `.avo/score`, `.avo/config.json`, `.avo/protected.txt`. Off-repo check by `bench/init.sh --verify`. |
| Reach the engine from `act` | **Run the policy in a child process.** Only frames go in and actions come out, over a pipe. Today's bench runs `act` in the same process (`bench/arcagi3/bench/run.py:152-160`), so `sys._getframe(1).f_locals["env"]` could reach the engine. Inference from code; not tested. |
| Network, file reads outside `src/` | Audit hook in the child: no socket, no `open` outside `src/`. Raises a `BaseException` and sets a flag, as today. |
| Read the game source during a turn | Train game sources are installed outside the worktree (`~/.cache/avocode/arcagi3-learn/games`, path given only to `bench/run.py`). `task.md` forbids it. `avo run` agent settings deny reads of that path (open question: does `bypassPermissions` honour deny rules?). |
| Lookup table of frame hashes → action lists | Gate: `src/` ≤ 200 KB, and no more than 64 literals of 8+ hex digits or 32+ ints in one literal. Alarm outside `f`: the train-minus-holdout gap per version, drawn in the report. |
| Not reproducible (wall clock, `os.urandom`) | Determinism gate: one game scored twice per `f` run. A mismatch gives `correct: false` with the log line `policy is not reproducible`. |
| Slow brute force | Compute gate: CPU time of the child process per config ≤ `cap` (start: 60 s at `B = 3`). The log line is `policy exceeded the compute budget on <game>`. Margin 3x over the measured scripted ladder, so a busy box does not trip it. |
| Drop a game | `dominate` refuses a vector with a missing config. |

The compute gate and the determinism gate are also the bench's **thrash** sources. An agent that
builds a deeper search hits the compute cap. The log line is the same each time, so three tries in a
row fire thrash (`src/supervise.ts:135` `failureSignature` reads the first log line).

### 5.8 Why this bench will plateau

Inference, to check in ARC-7 and ARC-13:

- The first rungs are cheap: skip no-op actions, explore by frame-graph frontier, aim clicks at
  objects. These should solve the short early levels (baselines of 7 to 78 actions).
- Later levels need a goal theory (pattern match, key and door, counter) and multi-step plans. A
  code-level policy without an LLM at run time will run out of easy ideas there. That is the stall.
- The compute cap makes "search harder" fail the same way. That is the thrash.
- 145 train levels give a fine scale (about 0.7% per level), so progress before the plateau shows.

---

## 6. Visuals

Built on [visuals.md](visuals.md): the scorer fills the optional `artifacts` field (AVO-11), files
go under `.avo/artifacts/` (gitignored), and `avo commit` copies them to `.avo/artifacts/v<NNN>/`.

To keep `f` fast, `f` writes only small JSON. Images come from **replay**: the engine and a fixed
policy are deterministic, so `bench/replay.py` can re-create any rollout of any version from its
commit.

| File | Written by | Format | Content |
| --- | --- | --- | --- |
| `.avo/artifacts/levels.json` | `f`, every run | JSON, ≤ 50 KB | per game, level, seed: `solved`, `actions`, `budget`, `baseline`, `game_overs`, `surprise` |
| `.avo/artifacts/strip-<game>.png` | `f`, only for levels whose status changed vs best | PNG, ARC 16-colour palette, 4 px per cell | per changed level: 8 frames evenly spaced over the attempt + the last frame, in one row; a green or red bar under the row for solved or failed |
| `.avo/artifacts/rollout-<game>-L<k>.gif` | `bench/replay.py <rev> --game g --level k --seed s` | GIF, 2 px per cell, ≤ 300 frames (every n-th step), ≤ 2 MB | one level attempt, with the step counter and the action drawn in the margin |
| `.avo/artifacts/heatmap.svg` | `bench/report.py` | SVG | rows = 145 train levels (grouped by game) + holdout levels; columns = versions; cell colour = solved on 0 to S seeds; a new solve outlined |
| `.avo/artifacts/progress.svg` | `bench/report.py` from `avo report --json` (AVO-10) | SVG | x = attempt index; y = primary; dots = attempts (filled pass, hollow refused, cross failed); step line = best; dashed line = holdout per version; red rule = stall; amber rule = thrash; label = intervention id |
| `.avo/report/index.html` | `avo report --html` (AVO-11) | one HTML file | the panels of visuals.md §2, with panel 7 holding the heatmap, progress and the strips of the newest version |

Rules:

- Pillow is the only image library, pinned in the protected `requirements.txt`. No matplotlib.
- Artifacts never enter the candidate diff or the lineage commit.
- An artifact that fails to render is a warning in `log`, never `correct: false`.
- When a run ends, publish `index.html` as a private Artifact page for sharing.

Until AVO-10 and AVO-11 land, `bench/report.py` reads `.avo/runs/*/manifest.json` directly:
`iterations[].decision` (action, primary), `iterations[].agent_versions`,
`iterations[].supervision.signals` and `iterations[].intervention.kinds` (`src/run.ts:68-125`).

---

## 7. Tasks

Size: **S** ≤ half a day, **M** ≤ 2 days, **L** more. Put each task in `bd` once it is installed
(see `tasks.md`).

### ARC-1 — corpus licence and pinning
- **Goal:** know if the 25 official public games may be used in a local bench.
- **Acceptance:** the Kaggle rules and the ARC Prize terms are read and quoted in the bench README.
  If use is allowed, `bench/games.lock` pins the 50 files with the hashes already in arcjev's
  `.avo/gate.sha256`, and `bench/setup.sh --from <dir>` installs them outside the worktree. If not,
  record the decision and take the fallback in §8.
- **Size:** S. **Deps:** none.

### ARC-2 — bench scaffold
- **Goal:** `bench/arcagi3-learn/` exists and `bench/init.sh --target arcagi3-learn` materialises it.
- **Acceptance:** layout as in `bench/arcagi3/`; README, `task.md`, `requirements.txt`
  (`arc-agi==0.9.9`, `arcengine==0.9.3`, Pillow), `.avo/config.json`, `.avo/protected.txt`.
  `.avo/score --configs` lists the 20 train games without Python.
- **Size:** M. **Deps:** ARC-1.

### ARC-3 — harness with level skip and child process
- **Goal:** the episode shape of §5.4 and the isolation of §5.7.
- **Acceptance:** `bench/run.py --config g` plays all levels with per-level budgets and skip, the
  policy runs in a child process over a pipe, and it prints one JSON line with `score`,
  `per_level`, `chain_competition`, `actions`, `cpu_s`. A test shows that a policy calling
  `sys._getframe` or `gc.get_objects` cannot see the engine. IPC overhead ≤ 20% of a random run.
- **Size:** L. **Deps:** ARC-2.

### ARC-4 — gates
- **Goal:** every `correct: false` reason in §5.7 works and has a distinct first log line.
- **Acceptance:** one test per gate with a bad policy fixture: hash drift, contract break, network,
  file read, compute cap, non-determinism, `src/` size and literal limits. Each gives
  `correct: false` and a stable first log line (the thrash signature).
- **Size:** M. **Deps:** ARC-3.

### ARC-5 — learning-loop skeleton in `src/`
- **Goal:** the baseline the agent starts from has the shape of §5.2.
- **Acceptance:** the six modules exist with the data types above and a random-walk behaviour. The
  contract suite passes. `explain()` returns a prediction, and the harness logs a surprise rate.
  The baseline scores the same as a plain random walk (inference; check it).
- **Size:** M. **Deps:** ARC-3.

### ARC-6 — noise, smoothing and floor
- **Goal:** `S`, `c` and `floor` come from measurement.
- **Acceptance:** three identical runs give bit-identical vectors. The twin test (§5.5) is run on the
  baseline and on rung 2 of ARC-7. The chosen `S`, `c`, `floor` and the spread table are in the
  README and in `avo mem`.
- **Size:** S. **Deps:** ARC-4, ARC-7 rung 2.

### ARC-7 — scripted headroom ladder
- **Goal:** prove there is room to climb and a place to stall, before any agent spend.
- **Acceptance:** fixtures under `test/fixtures/arcagi3-learn/`: rung 0 random; rung 1 skip no-op
  actions; rung 2 frame-graph frontier explorer; rung 3 rung 2 + object-aimed clicks; rung 4 rung 3
  + a simple goal hypothesis (move toward the rarest colour). Each rung: train and holdout solve
  rate, per-game vector, CPU time, and `avo commit` decision vs the rung before. Sets `B` and the
  compute cap. Passes go/no-go gate G1 (§8).
- **Size:** L. **Deps:** ARC-4, ARC-5.

### ARC-8 — artifacts from `f`
- **Goal:** `levels.json` and the changed-level strips of §6.
- **Acceptance:** `f` lists them in `artifacts`. A full `f` writes ≤ 5 MB. The strips use the ARC
  palette. A render error is a warning only.
- **Size:** M. **Deps:** ARC-3, AVO-11 (schema field; until then write the files and skip the field).

### ARC-9 — replay and report
- **Goal:** GIFs, heatmap and progress curve of §6.
- **Acceptance:** `bench/replay.py <rev> --game g --level k --seed s` reproduces the recorded
  actions and level result of that version bit for bit, and writes a GIF. `bench/report.py` builds
  `heatmap.svg` and `progress.svg` for the e2e fixture lineage, with an intervention rule at the
  right attempt.
- **Size:** M. **Deps:** ARC-8; AVO-10 when available.

### ARC-10 — holdout scripts
- **Goal:** a holdout number for each version.
- **Acceptance:** `test/fixtures/arcagi3-learn/score-holdout.sh <target> [--rev v<N>]` scores the
  5 official and 8 arc-interactive holdout games with the target's own `bench/run.py`.
  `bench/verify-run.sh --target arcagi3-learn` runs it for every version and skips, not fakes, when
  the corpus is missing.
- **Size:** S. **Deps:** ARC-3.

### ARC-11 — seed K
- **Goal:** the directive and the agent have real material to cite.
- **Acceptance:** at least 6 docs in `knowledge/`: the ARC-AGI-3 game and scoring docs; a mechanics
  catalogue written by a human from the **train** games only (movement, click toggles, keys, counters,
  pattern match); 2-3 public write-ups on graph-based exploration for ARC-AGI-3 (find and cite them
  with `avo know search`; none checked yet); a note on this plan's metric. No doc names a ladder
  rung beyond rung 1.
- **Size:** S. **Deps:** ARC-2.

### ARC-12 — `task.md` and README for the agent
- **Goal:** the agent knows the two loops and the rules in under 2 minutes of reading.
- **Acceptance:** `task.md` states the outer loop steps of §5.2 with the exact commands, the rules,
  and two real examples (one commit, one refusal) from ARC-7. ASD-STE100 style.
- **Size:** S. **Deps:** ARC-6, ARC-7.

### ARC-13 — pilot run (= BENCH-2 for ARC)
- **Goal:** check progress, plateau and cost with a real agent.
- **Acceptance:** `avo run --agent claude --max-iters 10` with a $40 cap (AVO-1) and one `avo fan`
  step. Recorded in `evidence/arcagi3-learn-pilot.txt`: versions, refusals, interventions,
  since-best series, cost per turn, holdout per version. Passes gate G2 (§8).
- **Size:** M. **Deps:** ARC-7 to ARC-12, AVO-1, AVO-5.

### ARC-14 — long run
- **Goal:** a real stall and a real thrash, with the effect of each.
- **Acceptance:** 40 turns or $150. At least one stall and one thrash intervention in the manifest.
  For each: since-best, the directive, turns to the next version (AVO-7). Train and holdout curves
  in `progress.svg`. `bench/verify-run.sh --target arcagi3-learn` passes.
- **Size:** L. **Deps:** ARC-13, AVO-7.

### ARC-15 — e2e test and CI
- **Goal:** the bench does not rot.
- **Acceptance:** `test/e2e-arcagi3-learn.sh` checks the gates, `--configs`, one config with the
  ladder rung 1, and the replay of that config. It skips the game half when the corpus is missing,
  as `test/e2e-arcagi3.sh` does.
- **Size:** M. **Deps:** ARC-4, ARC-9.

Order: ARC-1 → ARC-2 → ARC-3 → (ARC-4, ARC-5, ARC-10, ARC-11) → ARC-7 → ARC-6 → (ARC-8 → ARC-9) →
ARC-12 → ARC-15 → ARC-13 → ARC-14.

---

## 8. Risks, open questions, go/no-go

### Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Kaggle terms forbid local use of the public games | no official corpus | fallback A below |
| The model saw the public games or their solutions in training | train gains are memory | out-of-family holdout (arc-interactive), gap alarm |
| Headroom too small (rung 4 solves most levels) | no plateau | raise difficulty: lower `B` to 2 |
| Headroom too large (rung 2 ≈ rung 0) | no progress, only stall | raise `B`; or fallback |
| `dominate` over 20 configs is too strict | nothing commits | measure in ARC-13; try `reduce: mean` with weights only as a last step, and record why |
| Level skip changes the game (skipped levels are not designed to start cold) | some later levels are unfair | ARC-7 lists levels no rung solves; they stay, as the hard tail |
| Compute gate is timing based | flaky `correct: false` | CPU time, not wall time; 3x margin; check flakiness in ARC-6 |
| Agent turns at about $3 each (S9b-2a: $2.73) | campaign cost | AVO-1 budgets; `avo fan` on a small model |

### Open questions

1. Do Claude Code deny rules hold under `--permission-mode bypassPermissions`? If not, how do we keep
   the agent from reading game sources during a turn?
2. Should the policy keep memory across games inside one `f` run? Today: no. It would make the
   bench "learning to learn", but it couples configs, which `avo score --parallel` cannot do.
3. Absolute floor or `dominate-z` (AVO-15) instead of smoothing? Smoothing needs no avocode change,
   but it makes `scores` harder to read.
4. Is `B = 3` right? Human baselines are first-time players, so 3x leaves room for exploration.
   ARC-7 decides.
5. Should arcjev itself be revived? Not for this bench. Its useful parts are copied (§5.2). Its
   per-step LLM design needs a GPU and still has no learning loop.

### Go/no-go: when to fall back

Fallback A (licence only): keep this design but run it on the arc-interactive corpus (MIT, 18+
games, already pinned). Fallback B: Craftax, per `PLAN_CRAFTAX.md`.

| Gate | When | Go if | Else |
| --- | --- | --- | --- |
| G0 | ARC-1 | official games may be used locally | fallback A, same plan |
| G1 | ARC-7 | rung 0 solves ≤ 5% of train levels; the best rung solves 15% to 60%; each rung that should commit does; full `f` ≤ 5 min; three runs bit-identical | one retune of `B`; then fallback B |
| G2 | ARC-13 | ≥ 2 versions in 10 turns; ≥ 1 turn with no version; cost ≤ $5 per turn; holdout moves the same direction as train for ≥ 1 version | if 0 versions: one retune (lower `floor` or `B`); then fallback B. If every turn commits: lower `B` and repeat once |
| G3 | ARC-14 | ≥ 1 stall and ≥ 1 thrash in 40 turns | report as "bench too easy" and run BENCH-3 on Craftax |

Fall back to Craftax as soon as two gates in a row need a retune.
