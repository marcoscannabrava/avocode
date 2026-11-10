# Viewer Design

The viewer is a browser page. It reads a run folder (see `docs/data-model.md`). It works on a live run and on a finished run. It has no build step.

Start it:

```bash
./bench/arcagi3.py --serve           # during a run
./bench/arcagi3.py view runs/<id>    # after a run
```

Then open `http://127.0.0.1:8765`.

## 1. Questions the Viewer Must Answer

Each screen exists to answer one or more of these questions. If a chart does not help answer one, do not add it.

| # | Question | Where |
|---|---|---|
| Q1 | Is the run healthy now? Is a game stuck or broken? | Run overview |
| Q2 | How well does the agent play? | Run overview, game view |
| Q3 | Why did this round fail? | Round player, Model history |
| Q4 | Does the agent know what each action does? | Game view: action table |
| Q5 | Is the agent in a loop? | Game view, round player |
| Q6 | Does the Model get better, or does it only change? | Model history |
| Q7 | Where do the time and the money go? | Run overview, game view |
| Q8 | What did the LLM see, and what did it say? | LLM call panel |

## 2. Screens

The URL hash holds the position. You can copy a link to one step:

```
#/                                   run overview
#/game/ls20                          game view
#/game/ls20/round/3                  round player, first step
#/game/ls20/round/3/step/31          round player at step 31
#/game/ls20/model/7                  Model history at version 7
#/game/ls20/llm/s-31                 one LLM call
#/runs                               all runs, one row per run and game
```

### 2.1 Run overview (Q1, Q2, Q7)

```
┌──────────────────────────────────────────────────────────────────────┐
│ run 20261108-153012-a1b2c3d  ● live  12m 40s  $3.12  git a1b2c3d*     │
│ levels 7/24   games won 1/4   steps 812   errors 0   warnings 9      │
├──────────────────────────────────────────────────────────────────────┤
│ game   state      levels   rounds  steps/budget   $     last event   │
│ ls20   ● playing  ███░ 3/4   5     212/400 ▓▓▓░   1.10  2 s          │
│ ft09   ✓ won      ████ 4/4   2     140/400 ▓░░░   0.62  —            │
│ vc33   ⚠ waiting  ░░░░ 0/8   9     380/400 ▓▓▓▓   1.20  48 s scorer  │
│ lp85   ✗ error    █░░░ 1/8   1      80/400 ▓░░░   0.20  error       │
├──────────────────────────────────────────────────────────────────────┤
│ [levels over time, one line per game]  [cost by role, stacked bar]   │
└──────────────────────────────────────────────────────────────────────┘
```

Rules:

- **Health dot.** Green when the last event is less than 30 s old. Yellow when an `llm_start` is open for more than 30 s ("waiting"). Red on an `error` event, or no event for 120 s with no open call ("stalled").
- **Sort.** Problems first: error, stalled, waiting, playing, then done.
- **Levels bar.** `levels_completed / win_levels`. This is the main score.
- **Budget bar.** Steps used against `max_actions`. It shows which games will run out soon.
- **Run header** shows the git commit and a `*` when the tree was dirty. You must know which code made the run.

### 2.2 Game view (Q2, Q4, Q5, Q7)

Top: the number tiles for the game (see section 3).

Main chart: **progress timeline**.

```
level
  3 ┤                          ┌──────────
  2 ┤              ┌───────────┘
  1 ┤      ┌───────┘
  0 ┼──────┘
    └┬─────┬─────┬─────┬─────┬─────┬─────► step
     │ r1  │ r2 ✗│ r3 ✗│  r4  ✓L2 │ r5
```

- X axis: step. Y axis: `levels_completed`.
- Rounds show as bands behind the line. Band color shows the round outcome: failed, won, budget, error.
- Marks on the line show `model_update` events. Hover shows the Model change summary.
- Click a band to open the round player.

Below the timeline:

- **Round table.** One row per round: start level, end level, steps, outcome, Scorer hypothesis (first line), no-op rate, cost. Click a row to open the round.
- **Action table** (Q4). One row per action type:

  | action | uses | no-op % | levels gained after | Model says |
  |---|---|---|---|---|
  | ACTION1 | 120 | 4% | 2 | "moves player up" |
  | ACTION5 | 40 | 95% | 0 | "unknown" |

  A high no-op rate with a confident "Model says" text is a strong sign of a wrong belief.
- **Action strip** (Q5). One row per round. One small colored cell per step, colored by action. Repeated patterns are easy to see. Cells for `repeat_state` steps have a red border.
- **Rules.** Two panels: the rules from past games at game start, and the rules after this game. The panels show only when the run carries rules.
- **Click map.** The last grid of the game, with a heat layer of all `ACTION6` click points. It shows if the agent clicks the same place again and again.
- **Change map.** A heat layer of how often each cell changed. It shows which parts of the board respond to actions.
- **LLM cost and latency.** A scatter plot. X: step. Y: latency. Color: role. A list of calls with errors or retries.

### 2.3 Round player (Q3, Q5)

```
┌───────────────────────────────┬──────────────────────────────────────┐
│                               │ step 31  (round 3, step 8)  level 1  │
│                               │ action  ACTION6 @ (12, 40)           │
│      [ 64x64 grid canvas ]    │ reason  "Click the blue key to test  │
│                               │          if it opens the door."      │
│   changed cells: outline      │ status  ongoing   diff 14 cells      │
│   click point: crosshair      │ Model   v7  (changed: allowable_…)   │
│                               │ calls   player 2.3 s  scorer 4.1 s   │
│                               │ flags   —                            │
├───────────────────────────────┴──────────────────────────────────────┤
│ ◀◀  ◀  ▶  ▶▶   speed 1x   [════════●══════════════]  8 / 23           │
│ step strip: ■■□■■■■●■■□□■■■■■■■■■■✗                                  │
└──────────────────────────────────────────────────────────────────────┘
```

- **Grid.** Canvas with the 16 ARC colors. Changed cells have an outline. The `ACTION6` point has a crosshair. A toggle shows the previous grid ("before / after").
- **Frames.** If a step has more than one frame, a small control plays them. Some games animate.
- **Step strip.** One cell per step. Hollow cells are no-ops. The last cell shows the round outcome.
- **Side panel.** The action, the Player reason, the status, and the Model version. Links open the Model at that version and each LLM call.
- **Keys.** `←` `→` step. `space` play or pause. `[` `]` previous or next round. `d` toggle diff. `m` open Model.
- **End of round.** At the last step, the panel shows the Scorer hypothesis from `round_end`.

### 2.4 Model history (Q3, Q6)

- **Version list** on the left. Each row: version, step, round, and the change summary.
- **Diff** on the right. It compares the selected version with its parent, field by field. Added text is green. Removed text is red.
- **Failed rounds.** A list of all `failed_rounds` entries with their hypotheses. Repeated hypotheses are grouped, with a count. Many copies of one hypothesis means the agent does not learn from it.
- **Churn chart.** Model versions per round, as bars. Many versions and no level gain means the Model only changes and does not improve.

### 2.5 LLM call panel (Q8)

- Header: role, model, tokens in, tokens out, cache tokens, latency, cost, retries, error.
- Tabs: **System**, **User**, **Reply**, **Parsed**.
- The User tab shows the grid text in a monospace font.
- A **Copy as JSON** button. You can paste the call into a test or an API console to try it again.

## 3. Metrics

`metrics.js` computes all numbers from events. The run folder stores no totals, except `game_end` and `run_end`. One source of truth means the viewer and the files can not disagree.

| Metric | Formula | Why it helps |
|---|---|---|
| Levels | `levels_completed / win_levels` | The main score |
| Games won | games with outcome `won` | Run score |
| Steps per level | steps between `level_complete` events | Efficiency. ARC-AGI-3 rewards fewer actions. |
| Rounds per level | rounds between `level_complete` events | How many tries a level takes |
| No-op rate | steps with `diff.noop` / steps | High values show actions the agent does not understand |
| Repeat-state rate | `repeat_state` warnings / steps | Shows loops |
| Repeat-round count | `repeat_round` warnings | Shows that failed rounds do not teach the agent |
| Fallback rate | `bad_action` warnings / Player calls | Player prompt or parse problems |
| JSON fail rate | calls with `retries > 0` or `ok: false` / calls, per role | Prompt or schema problems |
| Model churn | `model_update` count / rounds | Learning signal or noise |
| Cost | sum of `cost_usd`, per role, per game, per level | Budget control |
| Tokens per call | `in_tokens`, `cache_tokens`, per role | Prompt size. Low cache rate means a prompt prefix changes. |
| Latency p50 and p95 | from `llm_end.latency_ms`, per role | Speed and provider problems |
| Step rate | steps per minute, last 5 minutes | Throughput |
| Time to finish | steps left / step rate | When the run will end |
| Last event age | now minus last `ts` | Stall check |

## 4. Charts

Use few chart types. Each one has a clear job.

| Chart | Type | Screen |
|---|---|---|
| Levels over time, all games | step line, one per game | Run overview |
| Cost by role | stacked bar per game | Run overview |
| Progress timeline | step line with round bands | Game view |
| Action strip | grid of cells (rounds × steps) | Game view |
| Click map and change map | heat layer on grid | Game view |
| LLM latency | scatter plot | Game view |
| Model churn | bars per round | Model history |

Chart rules:

- Draw charts as plain SVG in `charts.js`. No chart library. The charts are simple, and this keeps the viewer offline.
- Use the same color for a role (Player, Scorer) and for an outcome (won, failed, budget, error) on all screens.
- Do not use the 16 ARC colors for chart data. Those colors are for grids only, so the two do not mix.
- Support light and dark mode.

## 5. Live Updates

1. Each two seconds, `tail.js` asks for new bytes of `run.jsonl` and each open game `events.jsonl`. It uses HTTP `Range` from the last offset.
2. `store.js` adds the new events to arrays and indexes (by step, by round, by `call_id`).
3. `metrics.js` updates the numbers for the changed games only.
4. Views draw again only when their data changed.
5. `frames.jsonl` and `llm.jsonl` load only when a screen needs them. The viewer keeps a byte index of lines, so it can read one step without the full file.
6. A **Follow** toggle in the round player jumps to the newest step of a live game.

If the run folder schema version `v` is not known, the viewer shows a clear message. It does not show wrong data.

## 6. Debug Workflows

**"The run is slow."** Run overview → find the yellow game → game view → latency scatter. Is it one role? Is it one long call? Open the call to see the prompt size.

**"Round 3 failed. Why?"** Game view → click round 3 → step to the end. Read the Scorer hypothesis. Press `m` to see what the Model believed at the start of the round. Step back to the first step where the reason looks wrong. Open its Player call.

**"The agent does not get past level 1."** Game view → action table. Look for a high no-op rate. Look at the change map: does any action change the board near the goal? Model history → failed rounds: are the hypotheses the same each time?

**"A prompt change made it worse."** Compare the `prompts` hashes in two manifests. Compare steps per level and no-op rate. (A two-run compare screen is a later milestone.)

## 7. Later Work

- A compare screen for two runs: same games, side by side.
- Export a round as an animated GIF for reports.
- A search box for LLM text across a game.
