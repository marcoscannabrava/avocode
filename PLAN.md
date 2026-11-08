# Implementation Plan

This plan tells how to build the agent in `ARCHITECTURE.md`, the benchmark command `./bench/arcagi3.py`, and the run viewer.

Read these documents with this plan:

| Document | Contents |
|---|---|
| `README.md` | How to use the tool when it is done |
| `docs/data-model.md` | Domain types, events, and the run folder format |
| `docs/code-architecture.md` | Layers, modules, ports, and import rules |
| `docs/viewer.md` | Viewer screens, metrics, and charts |

## 1. Goals

1. Build the Player, Game, and Scorer loop from `ARCHITECTURE.md`.
2. Make `./bench/arcagi3.py` play ARC-AGI-3 games and write one run folder.
3. Make the run folder hold enough data to replay each round of each game.
4. Make a browser viewer that reads the run folder while it grows.
5. Keep the code in small modules with clear interfaces. Test the full loop with no network.

## 2. Current State of the Repo

- `ARCHITECTURE.md` gives the agent design. There is no code yet.
- `ARC-AGI-3-Agents/` is a git submodule with the official harness.
  - `agents/agent.py` shows how to call the game: `arc_env.step(action, data=...)`. The game comes from `arc_agi.Arcade().make(game_id, scorecard_id=...)`.
  - The game sends `FrameData`: a list of grids (colors 0 to 15), `state`, `levels_completed`, `win_levels`, `available_actions`, and `full_reset`.
  - `GameAction` has `RESET`, simple actions `ACTION1` to `ACTION5` and `ACTION7`, and `ACTION6` (a click with `x` and `y` from 0 to 63).
  - `agents/templates/my_agent.py` imports `arcjev`. That package is not in the repo or in `uv.lock`. Milestone 9 removes the file.

## 3. Key Decisions

1. **The benchmark owns the loop.** `bench/arcagi3.py` uses `arc_agi` directly. It does not use the submodule `Agent` or `Swarm`. So one class (`GameSession`) owns each step and each event. A thin submodule adapter comes last, for contest entries.
2. **Clean context.** Each LLM call is one new request. It gets the Model and the State(s) only. Memory lives in `GameModel` only.
3. **The first Model.** The Scorer makes `M_0` from `S_{-1} = None` and `S_0`.
4. **The Scorer gets the old Model.** The signature in `ARCHITECTURE.md` shows only two States. The Scorer also needs the old Model and the recent actions, or the memory of failed rounds is lost.
5. **Status comes from code first.** `WIN` gives `success`. `GAME_OVER` gives `failed`. All else gives `ongoing`. The Scorer LLM updates the Model. It does not set the status.
6. **Levels are not rounds.** A round is one try, from `RESET` to `RESET`. A level is a second index on steps. A level gain is `ongoing`. The Scorer writes what worked to `level_notes`.
7. **Skip the Scorer on no-ops.** If the grid did not change and status is `ongoing`, the Scorer does not call the LLM. It notes the no-op in `allowable_actions`. A config flag turns this off. This halves cost on no-op steps.
8. **Recording is a side channel.** The Player and the Scorer do not know about events. `GameSession` and the `RecordingLLM` wrapper emit them.
9. **Three files per game.** `events.jsonl` is small and polled often. `frames.jsonl` and `llm.jsonl` are large and read only on demand. See `docs/data-model.md` section 4.1.
10. **The viewer derives all metrics.** The run folder stores raw events. The viewer computes totals. There is one source of truth.
11. **No viewer build step.** Plain HTML, JavaScript modules, and SVG. Python standard library serves it.

## 4. Milestones

Do the milestones in order. Each one ends with tests that pass. Milestone 7 can start after Milestone 5, in parallel with Milestone 6.

```
M0 ─► M1 ─► M2 ─► M3 ─► M4 ─► M5 ─┬─► M6 ─► M8 ─► M9
                                    └─► M7 ──┘
```

### M0: Project setup

1. Add a root `pyproject.toml` for the `avocode` package. Python 3.12 or later.
2. Dependencies: `pydantic`, `python-dotenv`, `arc-agi`, `anthropic`, `openai`.
3. Dev dependencies: `pytest`, `ruff`, `mypy`, `import-linter`, `jsonschema`.
4. Add `.env.example` with `ARC_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AVOCODE_LLM`.
5. Add `.gitignore` entries: `runs/`, `.env`, `.venv/`.
6. Add `import-linter` contracts for the import rules in `docs/code-architecture.md` section 2.
7. Make empty packages from the module layout in `docs/code-architecture.md` section 3.

Done when: `uv sync`, `uv run pytest`, `uv run ruff check`, and `uv run lint-imports` all pass.

### M1: Domain and perception

1. `core/`: `Grid`, `State`, `Status`, `Outcome`, `Action`, `GameModel`, `FailedRound`. See `docs/data-model.md` section 2.
2. `Action` short form: `A1`, `A6@12,40`, `RESET`. Parse and print.
3. `perception/encode.py`: grid to hex text, with an option to crop empty borders.
4. `perception/objects.py`: `find_blobs()`. Connected cells of one color.
5. `perception/diff.py`: `grid_diff()`. Changed cells and their bounding box.
6. `perception/summary.py`: a short text form of a State for prompts and `FailedRound.last_state`.

Done when: unit tests pass on small hand-made grids, such as the grid in `ARCHITECTURE.md`.

### M2: Ports and test adapters

1. `ports.py`: `GameEngine`, `LLMClient`, `RunObserver`, `Clock`, `LLMRequest`, `LLMReply`.
2. `engine/toy.py`: a small grid game from the `ARCHITECTURE.md` example. Arrows move the player. A wall gives `GAME_OVER`. The goal gives a level. Two levels give `WIN`. A button cell changes the grid, to test `ACTION6`.
3. `llm/fake.py`: `FakeLLM`. Returns scripted replies in order. Records each request.
4. `llm/base.py`: parse JSON against a Pydantic schema. Try one time more on a bad reply.
5. `record/memory.py`: `MemoryRecorder`. Keeps events in a list.

Done when: tests play `ToyEngine` by hand to `WIN` and to `GAME_OVER`.

### M3: Player and Scorer

1. `scorer/status.py`: `status_from_state()`. The rules in decision 5.
2. `scorer/scorer.py`:
   - Get the status from `status.py`.
   - On `success`, return the old Model.
   - On a no-op with `ongoing`, update `allowable_actions` without the LLM (decision 7).
   - Else, send the old Model, both States, the diff, and the recent actions to the LLM. Get a new `GameModel`. Raise `version` by one if anything changed.
   - On `failed`, make sure the new Model has one more `FailedRound`.
   - If the LLM fails twice, keep the old Model. Report `model_kept`.
3. `player/player.py`: send the Model, the State, and the recent actions to the LLM. Get an `Action`. If it is not in `available_actions`, use a fallback and report `bad_action`.
4. `prompts.py` in both packages. Short prompts. Each template has a hash. `manifest.json` and `llm.jsonl` store it. The Player prompt shows `failed_rounds` and `open_questions`. It tells the Player not to repeat a failed action sequence.

Done when: tests with `FakeLLM` check each rule in this milestone.

### M4: Recording

1. `record/events.py`: Pydantic models for each event in `docs/data-model.md` sections 4.3 to 4.9.
2. `record/jsonl.py`: `JsonlRecorder`. One per game. Writes `events.jsonl`, `frames.jsonl`, `llm.jsonl`. One line per write, then flush. Adds `v`, `seq`, `ts`, `game`.
3. `record/run_log.py`: `RunLog`. Writes `run.jsonl` with a lock. Writes `manifest.json` with temp file and rename. Updates `runs/latest`.
4. `llm/recording.py`: `RecordingLLM` and `StepContext`. Emits `llm_start` and `llm_end`. Writes the `llm.jsonl` line.
5. `llm/pricing.py`: cost per million tokens per model. Unknown models cost `null`, not `0`.

Done when:

- A test writes events and reads them back with the models.
- A test checks each line against the JSON schema.
- A test cuts a file in the middle of a line. The reader skips the partial line.

### M5: Game session

1. `budget.py`: action and round limits.
2. `session.py`: `GameSession.run()`. The step order is in `docs/code-architecture.md` section 5.
3. Detect `repeat_state` with a set of grid hashes per round.
4. Detect `repeat_round` when the first N actions of a round match a failed round.
5. Catch each exception in a step. Emit `error`. End the game with outcome `error`.
6. Add `tests/make_fixture.py`. It plays `ToyEngine` with `FakeLLM` and writes `tests/fixtures/runs/toy/`. The fixture has a failed round, a level gain, and a win.

Done when:

- A session test on `ToyEngine` ends with `success`.
- A session test forces `GAME_OVER`. It checks the `RESET` step, the new round, and the new `FailedRound`.
- A test rebuilds each round of the fixture with only the files (`docs/data-model.md` section 5).

### M6: Benchmark command and real adapters

1. `engine/arc.py`: `ArcEngine`. Convert `FrameDataRaw` to `State`, and `Action` to `GameAction` (with `x` and `y` for `ACTION6`).
2. `llm/anthropic.py` and `llm/openai.py`. Return token counts, including cache tokens.
3. `config.py`: `Settings` from env vars and CLI options. Defaults in section 5.
4. `bench/games.py`: get the game list. Filter by `--games` prefixes, like the submodule `main.py`.
5. `bench/runner.py`: thread pool, one `GameSession` per game. Open and close the scorecard.
6. `bench/arcagi3.py`: commands `run` (the default), `view`, `list`, `schema`. Options in `README.md`.
7. Ctrl+C: stop new steps, write `round_end` and `game_end` with `aborted`, close the scorecard, write `run_end`.
8. Print a summary table at the end: game, outcome, levels, steps, rounds, cost.

Done when: `./bench/arcagi3.py --games ls20 --max-actions 20` plays real steps and writes a valid run folder.

### M7: Viewer

Build the viewer on the fixture run first. No API key is needed. Build the screens in this order, because each one depends on the one before:

1. `server.py`: static files and `Range` reads. Bind to `127.0.0.1`. Serve only under `runs/`. Reject `..`.
2. `tail.js`, `store.js`: read growing JSONL files by byte offset. Index by step, round, and `call_id`.
3. `metrics.js`: the metrics in `docs/viewer.md` section 3. Test with `node --test` on the fixture.
4. Run overview, with health dots and sort.
5. Round player, with grid canvas, diff outline, click point, step strip, and keys.
6. Game view: progress timeline, round table, action table, action strip.
7. Model history: version list and field diff.
8. LLM call panel.
9. Game view extras: click map, change map, latency scatter.
10. `--serve` option in `bench/arcagi3.py`.

Done when:

- The viewer shows each screen for the fixture run.
- During a real run with `--serve`, new steps show in less than 5 seconds.
- `metrics.js` tests pass.

### M8: Tune on real games

1. Run on `ls20` first. Use the viewer debug workflows in `docs/viewer.md` section 6.
2. Answer the open question in `docs/data-model.md` section 1: what does `RESET` do after `GAME_OVER`?
3. Tune prompts and perception output. Do not change the loop for one game.
4. Use a `--tag` on each run. Record the score, steps per level, and cost for each prompt hash.

### M9: Submodule adapter

1. Add `ARC-AGI-3-Agents/agents/templates/avocode_agent.py`. It is a subclass of `Agent`. Each `choose_action()` call runs one `GameSession` step.
2. Add `"avocode"` to `AVAILABLE_AGENTS`.
3. Delete `agents/templates/my_agent.py`.
4. Add `avocode` to the submodule `pyproject.toml` as an editable path dependency.

Done when: `uv run main.py --agent=avocode --game=ls20` plays in the submodule folder.

## 5. Configuration

`config.py` reads env vars. CLI options override them.

| Variable | CLI option | Default |
|---|---|---|
| `AVOCODE_LLM` | `--llm` | `anthropic` |
| `AVOCODE_PLAYER_MODEL` | `--player-model` | `claude-sonnet-5-5` |
| `AVOCODE_SCORER_MODEL` | `--scorer-model` | `claude-opus-5-5` |
| `AVOCODE_MAX_ACTIONS` | `--max-actions` | `400` |
| `AVOCODE_MAX_ROUNDS` | `--max-rounds` | `20` |
| `AVOCODE_WORKERS` | `--workers` | `1` |
| `AVOCODE_RUNS_DIR` | `--out` | `runs` |
| `AVOCODE_SKIP_NOOP_SCORER` | none | `true` |

The Player runs on each step, so it uses a faster model. The Scorer makes the hypotheses, so it uses a stronger model.

## 6. Risks

| Risk | Action |
|---|---|
| Two LLM calls per step cost too much. | Skip the Scorer on no-ops. Use prompt cache on the stable prompt prefix. Track the cache rate in the viewer. |
| A 64x64 grid uses many tokens. | Crop empty borders. Send blobs and diffs with the grid. |
| The LLM gives bad JSON or a bad action. | Check with Pydantic. Try one time more. Then use a fallback and a warning. |
| The Model grows too large. | Keep the last 10 failed rounds. Ask the Scorer to merge old hypotheses. |
| The agent loops. | Detect `repeat_state` and `repeat_round`. Show both to the Player and in the viewer. |
| Run files grow too large. | Frames are separate. If needed, add key frames and diffs, and change `v`. |
| The event format changes and breaks old runs. | Every line has `v`. The viewer rejects unknown versions with a clear message. |
| A game thread crashes. | The session catches it, writes `error`, and ends that game only. |

## 7. Out of Scope

- Training or fine-tuning models.
- Image input to the LLM. Text grids come first.
- A compare screen for two runs. This is later work in `docs/viewer.md`.
