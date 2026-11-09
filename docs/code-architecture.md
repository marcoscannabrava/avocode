# Code Architecture

This document tells how the code is divided and which parts can import which. `docs/data-model.md` gives the data types.

## 1. Main Ideas

1. **The domain is pure.** `core` has data types only. It has no I/O.
2. **Ports and adapters.** The loop uses interfaces (ports). Real and fake code (adapters) supply each port. Tests use fakes. The benchmark uses the real ARC game and a real LLM.
3. **Recording is a side channel.** The Player and the Scorer do not know about the run folder. The loop and an LLM wrapper send events to an observer.
4. **One source for the format.** The Pydantic event models define the run folder format. The writer, the schema command, and the tests all use them.
5. **No build step for the viewer.** It is static HTML and JavaScript modules. Python serves it.

## 2. Layers

```
                ┌────────────────────────────────────────┐
  app           │ bench/arcagi3.py      bench/viewer/    │
                └───────────────┬────────────────────────┘
                                │ builds and joins
                ┌───────────────▼────────────────────────┐
  services      │ session.py   player/   scorer/         │
                └───────┬───────────────────────┬────────┘
                        │ uses ports            │
                ┌───────▼────────┐      ┌───────▼────────┐
  ports         │ GameEngine     │      │ LLMClient      │
                │ RunObserver    │      │ Clock          │
                └───────┬────────┘      └───────┬────────┘
                        │ supplied by           │
                ┌───────▼───────────────────────▼────────┐
  adapters      │ engine/arc.py  engine/toy.py           │
                │ llm/anthropic.py llm/openai.py llm/fake│
                │ record/jsonl.py record/memory.py       │
                └───────────────┬────────────────────────┘
                                │ all use
                ┌───────────────▼────────────────────────┐
  domain        │ core/   perception/                    │
                └────────────────────────────────────────┘
```

Import rules:

| Module | Can import |
|---|---|
| `core` | standard library, `pydantic` |
| `perception` | `core` |
| `ports` | `core` |
| `player`, `scorer` | `core`, `perception`, `ports` |
| `session` | `core`, `perception`, `ports`, `player`, `scorer` |
| `engine/*`, `llm/*`, `record/*` | `core`, `ports`, and their own SDK |
| `bench` | all |

Only `engine/arc.py` imports `arc_agi` and `arcengine`. Only `llm/anthropic.py` and `llm/openai.py` import an LLM SDK. A test checks these rules with `import-linter` (see `PLAN.md`).

## 3. Module Layout

```
avocode/
├── __init__.py
├── config.py                # Settings from env and CLI
├── core/
│   ├── state.py             # Grid, State, Status, Outcome
│   ├── action.py            # Action, short form
│   ├── model.py             # GameModel, FailedRound
│   └── events.py            # Pydantic event models
├── perception/
│   ├── encode.py            # grid to text for prompts
│   ├── objects.py           # find_blobs()
│   ├── diff.py              # grid_diff()
│   └── summary.py           # short State text
├── ports.py                 # GameEngine, LLMClient, RunObserver, Clock
├── player/
│   ├── player.py            # Player.choose()
│   └── prompts.py
├── scorer/
│   ├── scorer.py            # Scorer.score()
│   ├── status.py            # status_from_state()
│   └── prompts.py
├── session.py               # GameSession: the loop for one game
├── budget.py                # action and round limits
├── engine/
│   ├── arc.py               # ArcEngine
│   └── toy.py               # ToyEngine
├── llm/
│   ├── base.py              # JSON parse and retry
│   ├── anthropic.py
│   ├── openai.py
│   ├── fake.py              # FakeLLM
│   ├── pricing.py           # cost per token, per model
│   ├── factory.py           # make_client() by provider
│   └── recording.py         # RecordingLLM wrapper
└── record/
    ├── events.py            # exports core/events.py
    ├── jsonl.py             # JsonlRecorder (game files)
    ├── run_log.py           # RunLog (run.jsonl, manifest)
    └── memory.py            # MemoryRecorder for tests

bench/
├── arcagi3.py               # CLI: run, view, list, schema
├── runner.py                # plays games on workers
├── games.py                 # list games from the API
└── viewer/
    ├── server.py            # static files and Range reads
    ├── index.html
    ├── app.js               # routes and screens
    ├── tail.js              # read growing JSONL files
    ├── store.js             # parsed events, indexes
    ├── metrics.js           # derived numbers
    ├── charts.js            # small SVG charts
    ├── grid.js              # draw grids on canvas
    ├── palette.js           # 16 ARC colors
    └── views/
        ├── run.js
        ├── game.js
        ├── round.js
        ├── model.js
        └── llm.js
```

## 4. Ports

```python
class GameEngine(Protocol):
    game_id: str
    def reset(self) -> State: ...
    def step(self, action: Action) -> State: ...

class LLMClient(Protocol):
    def complete(self, req: LLMRequest) -> LLMReply: ...

class RunObserver(Protocol):
    def emit(self, event: Event) -> None: ...
    def frames(self, step: int, state: State) -> None: ...
    def llm_call(self, record: LLMRecord) -> None: ...

class Clock(Protocol):
    def now(self) -> float: ...
```

`LLMRequest` holds `role`, `system`, `user`, `schema`, and `model`. `LLMReply` holds `text`, `parsed`, and token counts. `llm/base.py` does the JSON parse and the one retry for all providers.

## 5. The Game Session

`GameSession` runs the loop from `ARCHITECTURE.md` for one game. It owns the step counter, the round counter, and the step context.

```python
class GameSession:
    def __init__(self, engine, player, scorer, observer, budget, clock): ...
    def run(self) -> GameResult: ...
```

One step in `run()`:

1. Set the step context (`round`, `step`). `RecordingLLM` reads it to tag its events.
2. If status is `failed`: send `RESET`, close the round, open a new round.
3. Else: call `player.choose(model, state)`. Check the action.
4. Call `engine.step(action)`. Measure the time.
5. Make the `GridDiff`. Call `scorer.score(prev, state, model, history)`.
6. If the Model changed, emit `model_update`.
7. If `levels_completed` went up, emit `level_complete`.
8. Emit `step`. Send the frames.
9. Check the budget.

`run()` uses four public methods: `begin()`, `decide()`, `observe()`, and `end()`. The submodule adapter calls the same methods, because the official `Agent` class owns its loop.

The session catches each exception in a step. It emits `error`, ends the game with outcome `error`, and returns. One game crash does not stop the run.

### Step context and the LLM wrapper

`RecordingLLM` wraps a real `LLMClient`. It emits `llm_start`, calls the inner client, writes the `llm.jsonl` line, and emits `llm_end`. It reads `round` and `step` from a small `StepContext` object in `ports.py`. The session updates that object. `RecordingLLM` adds the call ids, tokens, and cost to it. So the Player and the Scorer take a plain `LLMClient` and know nothing about events.

```
Player ──► RecordingLLM ──► AnthropicClient
               │
               └──► RunObserver (llm_start, llm_end, llm.jsonl)
```

## 6. The Benchmark Runner

`bench/arcagi3.py` reads the CLI options and makes a `Settings` object. Then:

1. Make the run folder. Write `manifest.json`. Point `runs/latest` to it.
2. Get the game list (`bench/games.py`). Use the same API as the submodule `main.py`.
3. Open a scorecard with `arc_agi.Arcade`.
4. Make a thread pool with `--workers` threads. For each game, build an `ArcEngine`, a `Player`, a `Scorer`, a `JsonlRecorder`, and a `GameSession`. Run it.
5. If `--serve` is on, start the viewer server in a thread.
6. At the end, close the scorecard. Write `run_end`. Update the manifest. Print a summary table.
7. On Ctrl+C, stop new steps. Let each session write `round_end` and `game_end` with outcome `aborted`. Then do step 6.

Threads are enough. The work waits on the network, not the CPU.

### The bench command and uv

`bench/arcagi3.py` starts with:

```python
#!/usr/bin/env -S uv run python
```

`uv` looks for `pyproject.toml` in the current folder and its parents. So the command uses the root project environment when you run it from any folder in the repo. The file is executable (`chmod +x`).

## 7. The Viewer Server

`bench/viewer/server.py` uses only the standard library. It does two things:

1. It serves the static viewer files.
2. It serves files under the run folder with HTTP `Range` support. A request for `bytes=12000-` returns only the new bytes.

The browser keeps a byte offset for each file. Each poll asks for the bytes after that offset. `tail.js` splits on `\n` and keeps a partial last line for the next poll. So a poll costs only the new data, also for a long run.

The server binds to `127.0.0.1` only. It serves only files under `runs/`. It rejects paths with `..`.

## 8. Role of the Submodule

The benchmark does not use the submodule `Agent` or `Swarm` classes. It uses `arc_agi` directly, so `GameSession` owns the loop and all recording.

The submodule stays for two uses:

1. Reference code and the game list API.
2. A thin adapter, `agents/templates/avocode_agent.py`. It lets you run avocode with the official `main.py`, for a contest entry. It is a late milestone in `PLAN.md`.

`agents/templates/my_agent.py` imports `arcjev`. That package is not in the repo or in `uv.lock`. The adapter milestone removes this file.

## 9. Test Strategy

| Level | What | Tools |
|---|---|---|
| Unit | perception, status rules, action checks, event models | pytest |
| Service | Player and Scorer with `FakeLLM` | pytest |
| Session | full loop on `ToyEngine` with `FakeLLM` and `MemoryRecorder` | pytest |
| Format | the JSONL writer output matches the schema. A reader can rebuild each round. | pytest, JSON schema |
| Viewer | `metrics.js` and `tail.js` on fixture runs | `node --test` |
| Smoke | one real game with a small budget | manual, `./bench/arcagi3.py --games ls20 --max-actions 20` |

A fixture run folder lives in `tests/fixtures/runs/toy/`. A test makes it from `ToyEngine`. The viewer tests and manual viewer work use it, so you can work on the viewer without an API key.
