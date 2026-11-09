# Plan: Improve the Viewer

Evidence: run `20261109-230247-9b16e07` (game `ls20-9607627b`, 100 steps, 1 round, 1 of 7 levels, $1.23). The screenshots are in `runs/20261109-230247-9b16e07/screenshots/`.

## 1. Summary

The viewer shows the main numbers well. But it does not show fast why the agent loses steps. In this run, the Player sent `ACTION1` six times into a wall (steps 52 to 57). The Scorer did not run on these steps, so the Model stayed at v53. To see this, you must hover six cells and open six LLM calls. Two bugs give wrong numbers: the run time shows "14m 60s", and each Player call shows a cost of "$0.000". The change map mixes level 1 changes onto the level 2 grid. There is no screen to compare runs by prompt hash.

## 2. Findings per Page

### 2.1 Run overview (`01-run-overview.png`)

What works:

- The tiles show levels, steps, warnings, cost, and the two prompt hashes.
- The header shows the git commit with `*`, and the tags `m8` and `baseline`.
- The game table shows the levels bar and the budget bar.

What is wrong or missing:

| Element | Problem |
|---|---|
| Header, duration | It shows "14m 60s". The real time is 899.586 s, so it must show "15m 0s". Bug in `html.js:31`. |
| Header | It does not show the LLM models or the effort. `manifest.config` has `player_model: gpt-6-luna`, `player_effort: low`, `scorer_model: gpt-6.1-sol`, `scorer_effort: medium`. You need these to compare runs. |
| Header | It does not show `max_actions` or `skip_noop_scorer`. These settings change the result. |
| Run picker (top right) | It lists run IDs only. You cannot see the tags, the prompt hashes, or the score. You must guess which run to open. |
| Cost by role chart | The label shows only the total "$1.23". The Player part ($0.03) and the Scorer part ($1.20) have no numbers. The Scorer uses 98% of the money. |
| Levels over steps chart | The x ticks are 0, 13, 26, 39. These numbers are hard to read. Use 0, 20, 40. |

### 2.2 Game view (`02-game-view.png`)

What works:

- The action table shows `ACTION1` with 16% no-op and the "Model says" text.
- The action strip shows the six red-border cells at steps 52 to 57. The loop is easy to see.
- The latency scatter shows that the Scorer is slow (p50 6.8 s) and the Player is fast (p50 2.0 s).

What is wrong or missing:

| Element | Problem |
|---|---|
| Tile "last event" | It shows "12 s" for a finished game. The tile "time to finish" shows "—" for the same game. Bug in `views/game.js:200`. |
| Tile "Model churn" | It shows "96.0". With one round, this number has no meaning. "Model updates per step" (96 of 100) is clearer. |
| Tile "steps per level" | It shows "70". It does not show the 30 steps on level 2 that did not finish. |
| Tiles | There is no "cost per level" tile. `docs/viewer.md` section 3 lists it. |
| Tiles | There is no count of lost steps (no-op steps and repeat-state steps). |
| Progress chart | 96 orange Model dots sit on the level line at y=0 and y=1. They hide the line. The chart does not mark the `level_complete` step (70) or the warning steps (52 to 57). |
| Rounds table, "Scorer hypothesis" | It is empty. A round that ends with `budget` has no hypothesis. The column shows nothing useful for this run. |
| Action strip | The cell tooltip shows only "52: A1". It does not show the reason, the diff, the flags, or the warning. The strip has no mark at the level-up step. |
| Click map | It shows "no clicks". `ls20` has no `ACTION6`, so the panel takes space for nothing. |
| Change map | The background is the last grid (level 2). The heat comes from all steps, most of them on level 1. Step 70 (the level change) adds 1475 cells of heat. So the map shows level 1 changes on the level 2 board. Bug in `views/game.js:160` to `views/game.js:177`. |
| Change map | The bottom bar (a ticker) changes on each step. It gets the most heat. The heat does not show which cells respond to which action. |

### 2.3 Round player, first step (`03-round-player-start.png`)

What works:

- The grid, the diff outline, and the step controls work.
- The side panel shows the reason, the diff size, the Model change, and links to both calls.
- The keys help text is clear.

What is wrong or missing:

| Element | Problem |
|---|---|
| Side panel, Model | It shows field paths, for example "allowable_actions.ACTION1, element_breakdown.color 3, obj#0, x=14..53 ...". It does not show the Scorer `summary` text. The summary is shorter and easier to read. |
| Side panel | It does not show the goal hypothesis (`model.prompt`) or the `open_questions` that the Player saw. You must open "Full Model" and read JSON. |
| Below the strip | There is no list of steps with their reasons. To read reasons, you must step one by one. |
| Page | Most of the page below the strip is empty. |

### 2.4 Round player, step 70 (`04-round-player-step.png`)

What works:

- The frame control "frame 2/2" shows that the step has two frames.

What is wrong or missing:

| Element | Problem |
|---|---|
| Side panel, step | It shows "level 0". This step completed level 1. The `level_complete` event exists (step 70), but the panel does not show it. |
| Side panel, status | It shows "ongoing · NOT_FINISHED". It does not say "level complete". |
| Grid | The diff outlines 1475 cells, because the board changed to the new level. The outlines hide the new board. |
| Step strip | The cell for step 70 looks the same as the other `ACTION1` cells. |
| Level names | The panel says "level 0". The tiles say "1/7". The two words mean different things. Users can mix them up. |

### 2.5 Model history (`05-model-history.png`)

What works:

- The version list shows one useful summary per version.
- The field diff shows removed text in red and added text in green.

What is wrong or missing:

| Element | Problem |
|---|---|
| Version list | The URL selects v60. The list shows v1 to v18. The list does not scroll to v60. |
| Version list | All 96 rows look the same. You cannot see which versions changed the goal (`prompt`) and which changed only coordinates. |
| Diff, `element_breakdown` | The keys contain coordinates, for example "colors 9/c, obj#6, x=19..23 y=30..34". When the coordinates change, the key changes. The diff then shows a full delete and a full add. You cannot see the real change. |
| Diff | Changed lines show the full old text and the full new text. Most words are the same. There is no word-level mark. |
| "Model versions per round" chart | It shows one bar of 96. With one round, it gives no information. |
| Failed rounds | It shows "None." This is correct, but the panel uses space. |

### 2.6 LLM call, Player (`06-llm-player.png`)

What works:

- The tiles show model, tokens, latency, and the prompt hash.
- The User tab shows the full prompt in monospace.
- "Copy as JSON" works.

What is wrong or missing:

| Element | Problem |
|---|---|
| Tile "cost" | It shows "$0.000". The real cost is about $0.0003. Bug in `html.js:9`. |
| Header | There is no link to the Scorer call of the same step (`s-70`). There is no link to the previous or next Player call. |
| User tab | The prompt is one long block. You cannot jump to "Current State", the object list, the HUD history, or "around". |
| User tab | You cannot see what changed from the previous Player prompt (`p-69`). For perception work, this is the main question. |
| Page | The grid is not on this page. You must compare object coordinates with the grid in your head. |

Note on the prompt (not a viewer problem): the line "Actions in this round so far" shows only the last 30 of 69 actions. The words "so far" are not correct.

### 2.7 LLM call, Scorer (`07-llm-scorer.png`)

The same points as 2.6 apply. Also:

| Element | Problem |
|---|---|
| User tab | The Scorer prompt starts with the full old Model as JSON. The new state is far below. You must scroll a lot. |
| Reply tab | The reply is the full new Model. There is no diff to the old Model on this page. (The Model history page has it, but you must go there.) |

## 3. Ranked Improvements

Size: S is less than half a day. M is one or two days. L is more than two days.

Bugs and cheap fixes come first.

| # | Problem | Change | Helps | Files | Size | Test |
|---|---|---|---|---|---|---|
| 1 | Duration shows "14m 60s". | Round the total seconds first. Then split into minutes and seconds. | Q7 | `html.js` | S | New `tests/html.test.js`: `duration(899.586)` gives "15m 0s". `duration(59.6)` gives "1m 0s". |
| 2 | Player cost shows "$0.000". | Show 4 decimals below $0.01. Show "<$0.0001" for smaller values. Keep 2 decimals above $1. | Q7 | `html.js` | S | `html.test.js`: `money(0.000168)` is not "$0.000". |
| 3 | "last event" shows an age for a finished game. | Show "—" when `m.outcome` is set. Use the same rule as `views/run.js:22`. | Q1 | `views/game.js` | S | Open the game view of this run. The tile shows "—". |
| 4 | Change map puts level 1 heat on the level 2 grid. | Make one change map per level. Use the first grid of the level as the background. Skip steps where `levels_completed` changes. Add a level selector. Move the heat count to a pure function `changeCounts(steps, frames, level)` in `metrics.js`. | Q4, perception tuning | `views/game.js`, `metrics.js` | M | Unit test on the toy fixture: the level 1 map has no counts from level 2 steps. Visual check on this run: step 70 adds no heat. |
| 5 | Step 70 shows "level 0" and no level-up. | In the side panel, show "level 0 → 1, level complete" when `after.levels_completed > before.levels_completed`. Mark the cell in both strips with a green bar. Turn the diff off for that step, and show the text "new level, diff hidden". | Q2, Q3 | `views/round.js`, `views/game.js`, `index.html` (CSS) | S | Open step 70. The panel shows the level-up. The grid has no outlines. |
| 6 | You must step one by one to read reasons. | Add a step log table below the strip in the round player. Columns: step, action, diff cells, flags, warnings, Model version, reason. Highlight the current row. Click a row to go to that step. Add a toggle "problems only" (no-op, repeat state, fallback, scorer skipped). | Q3, Q5, Q8; "why does it lose steps" | `views/round.js` | M | Open round 1. Turn on "problems only". Rows 11 and 52 to 57 show. The six reasons are almost the same. |
| 7 | Cell tooltips show only "52: A1". | Put the reason, the diff cells, the flags, and the warning code in the `title` of each strip cell. | Q5 | `views/game.js`, `views/round.js` | S | Hover cell 53. The tooltip shows "no-op, repeat_state, scorer_skipped" and the reason. |
| 8 | The side panel does not show what the Player believed. | Below "Model", show the goal (`model.prompt`) and `open_questions` of `s.model_version`. Show the Scorer `summary` in place of the field paths. Keep the field paths in the tooltip. | Q8, Q3 | `views/round.js` | S | Open step 53. The panel shows the goal of v53. |
| 9 | No count of lost steps. | Add a "lost steps" tile: no-op steps plus repeat-state steps, without double count. Add a "loops" list: each run of 3 or more same-action steps that are no-op or repeat state, with a link to the first step. Put the logic in `metrics.js` as `lostSteps(g)` and `loopRuns(g)`. | Q5, tuning | `metrics.js`, `views/game.js` | S | Unit test on the toy fixture. On this run, the list shows "steps 52–57, ACTION1 ×6". |
| 10 | Progress chart is hard to read. | Draw Model updates as short ticks in a thin lane below the x axis, not on the line. Add a second lane for warnings (red) and level-ups (green). Use round tick steps (1, 2, 5, 10, 20, 50). | Q2, Q5, Q6 | `charts.js`, `views/game.js` | S | Export `ticks` and test it: `ticks(100, 8)` gives multiples of 20. Visual check on this run. |
| 11 | Run header has no models or settings. | Show player and scorer model with effort, `max_actions`, and `skip_noop_scorer`. Read them from `manifest.config`. | Prompt compare | `views/run.js` | S | Visual check. |
| 12 | Game tiles miss numbers from the design. | Add "cost per level". Show the current level in "steps per level" as "70, 30+". Replace "Model churn" with "Model updates / step" when there is one round, or show both. | Q2, Q6, Q7 | `metrics.js`, `views/game.js` | S | Unit test: `stepsPerLevel` with an open level. |
| 13 | Click map panel is empty for `ls20`. | Hide the click map when `ACTION6` is not in `available_actions`. Give the change map the full width. | Layout | `views/game.js` | S | Visual check. |
| 14 | Cost chart has no part values. | Write the Player and Scorer amounts on the bar or in the legend. | Q7 | `charts.js`, `views/run.js` | S | Visual check. |
| 15 | LLM page has no navigation. | Add links: the other role of the same step, the previous call, and the next call of the same role. Add keys `←` and `→`. | Q8 | `views/llm.js` | S | Open `p-70`. Click "scorer" to go to `s-70`. |
| 16 | You cannot see what changed in the prompt. | Add a tab "Diff vs previous" on the LLM page. It compares the User text with the previous call of the same role, line by line. Unchanged lines fold. | Q8, perception tuning | `views/llm.js`, new `textdiff.js` | M | Unit test for the line diff. Open `p-53`: only the history lines and the action list change. |
| 17 | The prompt is one long block. | Split the User text at known headings ("Model", "Current State", "history:", "around"). Show a small table of contents with links. Keep the raw text. | Q8 | `views/llm.js` | S | Visual check on `p-70` and `s-70`. |
| 18 | Model history is hard to scan. | Scroll the selected version into view. Mark rows that change `prompt`, `allowable_actions`, or `open_questions` with a short label. Add a filter "goal changes only". | Q6 | `views/model.js` | S | Open `#/.../model/60`. Row v60 is visible. |
| 19 | Model diff shows full delete and add. | Match `element_breakdown` entries by the object ID (`obj#N`) in the key, not by the full key. Mark changed words inside a line. | Q6 | `views/model.js`, `textdiff.js` | M | Unit test: two keys with the same `obj#6` and new coordinates pair up. |
| 20 | Run picker shows only IDs. | Show tags, prompt hashes, and levels in each option. Read each `manifest.json`. | Prompt compare | `app.js` | S | Visual check with the 6 runs in `runs/`. |
| 21 | No run compare screen. | See section 3.1. | Prompt compare, Q2 | new `views/runs.js`, `app.js`, `metrics.js` | M (table), L (side by side) | See section 3.1. |
| 22 | Grid not on the LLM page. | Show the grid of that step next to the User text. Click an `obj#N` line to outline its box on the grid. | Q8, perception tuning | `views/llm.js`, `grid.js` | M | Visual check: click `obj#6` on `p-70`. The box at x=34..38 y=15..19 shows. |

### 3.1 Run compare

This is worth it. The main task now is to tune prompts and perception. Each change makes a new run. Today you must run `./bench/arcagi3.py list` and open runs one by one.

Do it in two steps.

**Step A: runs table (M).** Add a route `#/runs`.

1. Read the run list from `/api/config` (the server already returns it).
2. For each run, read `manifest.json` and each game `events.jsonl`. The events files are small (about 0.5 KB per step).
3. Use the same `metrics.js` functions as the game view. Do not compute numbers in Python.
4. Show one row per run and game. Columns: run, tags, player hash, scorer hash, models, levels, steps per level, no-op rate, repeat-state rate, lost steps, cost, cost per level.
5. Group or sort by prompt hash. Highlight the hash that differs from the row above.
6. Add a small chart: steps per level, one point per run, in run order.

Test: a unit test that loads two toy runs and checks the rows. Visual check with the 6 runs in `runs/`.

**Step B: two-run compare (L).** Add a route `#/compare/<a>/<b>`.

1. Show the tiles of both runs side by side, with the difference.
2. Show both action tables side by side.
3. Draw both level lines on one progress chart.
4. Show a line diff of the System prompt of the first Player call and the first Scorer call. Use `textdiff.js` from item 16. This shows what the prompt hash change means.

Do step B only after step A is in use. Step A answers most questions.

## 4. Things Not to Do

| Idea | Why not |
|---|---|
| Use a chart library (Chart.js, D3, Plotly). | The design says plain SVG in `charts.js`. The viewer must work offline. |
| Add a build step (React, TypeScript, a bundler). | The viewer has no build step. Plain ES modules load directly. |
| Compute metrics or compare tables in `server.py`. | `metrics.js` is the one source of truth. Two copies can disagree. The server stays a stdlib file server. |
| Add an index database (for example SQLite) for runs. | The run folder is the only data. A second store can go out of date. Read the small `events.jsonl` files instead. |
| Use the 16 ARC colors for heat, lanes, or action cells. | ARC colors are for grids only. Charts use the role and outcome colors. |
| Load all of `llm.jsonl` to search text on each page. | The file is 5 to 50 KB per call. Load it only on the LLM page, or on request for a search. |
| Ask an LLM inside the viewer to explain a step. | It costs money, it needs an SDK, and the server is stdlib only. |
| Add WebSockets for live updates. | HTTP Range polling works and needs no extra code in the server. |
| Store totals in the run folder for the viewer. | The design keeps totals only in `game_end` and `run_end`. The viewer computes the rest. |
| Build the GIF export now. | It is planned later work. It does not help the current tuning task. |
