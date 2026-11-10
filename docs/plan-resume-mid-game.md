# Plan: resume a run mid-game

## Context

A run can stop before it ends: Ctrl+C, a crash, or a closed laptop. Today a stopped run is lost. The next run starts every game again at step 0 and pays for the LLM calls again.

The run folder already holds the full history of each game:
- `events.jsonl` has one `step` event per action (action, status) and one `model_update` event per Model change (the full Model).
- `frames.jsonl` has the grid after each step.
- `llm.jsonl` has the tokens and cost of each call.

`Player` and `Scorer` keep no state between calls (`avocode/player/player.py`, `avocode/scorer/scorer.py`). All game state is in `GameSession` (`avocode/session.py`): Model, status, rounds, `seen`, notes, `Tracker`, and level counters. Thus we can rebuild it.

Goal: `arcagi3.py resume <run_id|latest>` continues each unfinished game from its last full step, in the same run folder, with no LLM calls for old steps.

## Approach: replay through the real loop

Do not rebuild the session state by hand. Send the recorded actions through the normal `GameSession` loop, with a replay Player and a replay Scorer that return recorded results. The same code then rebuilds the rounds, `seen`, notes, `Tracker` and counters. The engine also gets the same actions, so its state matches.

During replay, the session writes to a null observer. After replay, it changes back to the real Player, Scorer and recorder, and continues.

### 1. Read the history: new `avocode/record/history.py`

`load_history(game_dir) -> GameHistory`:
- `steps`: for each `step` event in order: `Action(name, x, y, reason)` and `status`.
- `models`: Model at step N, from the last `model_update` with `step == N` (step 0 included). Use `GameModel.model_validate`.
- `grids`: the last frame hex per step, from `frames.jsonl`, for the replay check.
- `usage`: sum of `in_tokens`, `out_tokens`, `cost_usd` in `llm.jsonl` (calls of a lost partial step count, because they were paid).
- `outcome`: outcome of the last `game_end`, or `None`.
- `seq`: count of lines in `events.jsonl`.

Use `read_jsonl` (`avocode/record/jsonl.py:79`). It already skips a partial last line.

### 2. Replay parts: new `avocode/session_replay.py` (or in `session.py`)

- `ReplayPlayer.choose(...)` returns `Choice(steps[n].action)` for the next non-RESET step. RESET after a failed round comes from `decide()`, not the Player, so skip those steps.
- `ReplayScorer.score(inp)` returns `ScoreResult(model, status, changes, hypothesis)`. Take `model` from `models` at `inp.step`, or else `inp.model`. Take `status` from the recorded step (step 0: `status_from_state`). Compute `changes = model.changes_from(inp.model)` and `hypothesis` as in `Scorer._finish` (`avocode/scorer/scorer.py:105`).
- `NullObserver`: `emit` and `frames` do nothing.

### 3. `GameSession` changes (`avocode/session.py`)

- Split `run()` into `run(history=None)`. When `history` is given, call `_replay(history)` before the main `while` loop. Do not call `begin()` again.
- `_replay(history)`: swap `player`, `scorer`, `obs` to the replay parts. Run `begin(engine.reset())`, then `decide` / `engine.step` / `observe` for each recorded step. After each engine step, compare the grid hex to `history.grids[step]`. On a mismatch, raise `ReplayError("replay differs at step N")`. Then swap the real parts back, seed `ctx` with `history.usage`, and emit `GameResume(from_step, run_id)`.
- Replay errors go to the current `fail()` path. The game ends as `error` with no LLM cost.

### 4. Events (`avocode/core/events.py`)

- Add `GameResume(Envelope)`: `type="game_resume"`, `from_step`, `steps_replayed`. Add it to `all_schemas`.
- `bench/viewer/store.js:42` keeps the last `game_end`, so a second `game_end` already works. Make sure the viewer ignores `game_resume`, or shows it as a marker.

### 5. Append to an existing folder

- `LineWriter(path, seq=0)` (`avocode/record/jsonl.py:22`): take a start `seq`. Before opening, cut the file at the last `\n` so a partial line does not join a new line.
- `JsonlRecorder(game_dir, game, seq=0)`: pass `seq` to the events writer.
- `RunLog.open(runs_dir, run_id)` (`avocode/record/run_log.py`): open an existing folder, no `mkdir`, continue `run.jsonl` seq.

### 6. Runner (`bench/runner.py`)

- `Runner.resume(run_dir, settings_overrides) -> RunLog`: read `manifest.json`, make `Settings` from `manifest.config` plus overrides (`--max-actions`, `--max-rounds`, `--workers`). Add a `resumes` entry to the manifest: `{started, git, argv, scorecard, games}`.
- Games to resume: last `game_end` outcome is `aborted` or `error`, or there is no `game_end`. Other games keep their result.
- `play_game(game, worker, history=None)`: pass history to the recorder (`seq`) and to `session.run(history)`.
- `finish()`: build the summary from all games. For games not resumed, make a `GameResult` from their last `game_end` event.
- Manifest model (`Manifest` in `avocode/core/events.py`): add `resumes: list[dict] = []`.

### 7. CLI (`bench/arcagi3.py`)

- Add `resume` to `COMMANDS`. Args: `run` (id or `latest`), `--max-actions`, `--max-rounds`, `--workers`, `--force`, `--serve`.
- If the prompt hashes in the manifest differ from the current `PROMPT_HASH`, stop with "Prompts changed since this run. Use --force." A changed commit with the same prompts gives only a note.
- Open a new scorecard. The old one is closed. The replayed actions count on the new scorecard. Say this in the output.
- Reuse `Tee`, `install_stop`, `summary_table`. `Tee` appends to `stdout.log`.

## Limits

- Replay works only if the game is deterministic for the same actions. The grid check finds a mismatch and stops that game. It does not guess.
- The scorecard on the ARC side is a new one. It also counts the replayed actions.
- A game that ended with `budget` does not resume. A later change can allow it when the new budget is larger.

## Verification

1. Unit tests in `tests/test_session.py` with the toy engine (`avocode/engine/toy.py`) and the fake LLM in `tests/helpers.py`:
   - Run a game to the end. Run it again, stop after step K (set `stop`), then resume. The final Model, rounds, steps and `step` events after K must match the full run.
   - Change one recorded grid. Resume must end with `error` and the message "replay differs at step K". No LLM calls.
2. `tests/test_record.py`: `LineWriter` cuts a partial last line and continues `seq`. `RunLog.open` appends to `run.jsonl`. `load_history` reads a fixture folder.
3. `uv run pytest`, plus the viewer tests (`tests/test_viewer_js.py`).
4. End to end: `uv run bench/arcagi3.py --games ls20 --max-actions 30`, press Ctrl+C near step 10, then `uv run bench/arcagi3.py resume latest`. In the viewer, check that steps continue from 11, with one `game_resume` marker, and that the cost includes the first part.
