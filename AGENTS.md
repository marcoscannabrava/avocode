# AGENTS.md

Instructions for coding agents in this repo.

## What this is

avocode is an agent that plays ARC-AGI-3 games. One loop joins three parts:

- The **Player** (LLM) reads the game Model and the State. It picks the next action.
- The **Game** runs the action. It gives the next State.
- The **Scorer** (LLM) compares two States. It updates the Model and sets the status.

Read these documents before a large change:

| Document | Subject |
|---|---|
| `ARCHITECTURE.md` | How the agent thinks |
| `docs/code-architecture.md` | Layers, modules, import rules |
| `docs/data-model.md` | Domain types, events, run folder format |
| `docs/perception.md` | Objects, changes, HUD, surroundings |
| `docs/viewer.md` | Viewer screens, metrics, charts |

## Commands

Use `uv` for all Python commands. Python 3.12 or later.

```bash
uv sync                         # install deps, dev group included
uv run pytest                   # all tests, also viewer tests if Node is installed
uv run ruff check .             # lint (line length 100)
uv run mypy                     # strict type check of avocode/
uv run lint-imports             # layer import rules
```

Run all four checks before you say a change is done.

Benchmark (needs `ARC_API_KEY` and an LLM key in `.env`):

```bash
./bench/arcagi3.py --games ls20 --max-actions 20     # smoke run, one game
./bench/arcagi3.py view runs/<run_id>                # open the viewer
./bench/arcagi3.py list                              # past runs
./bench/arcagi3.py schema                            # event JSON schema
```

Fixture run for the viewer (no API key):

```bash
uv run python -m tests.make_fixture
./bench/arcagi3.py view tests/fixtures/runs/toy
```

### Stale venv

The repo folder was once `avocode_v2`. If `uv run pytest` fails with "Failed to spawn", the `.venv` scripts point to the old path. Make the venv again:

```bash
rm -rf .venv && uv sync
```

## Layout

```
avocode/
├── core/          # pure data types (stdlib + pydantic only)
├── perception/    # grid to objects, diffs, text for prompts
├── ports.py       # GameEngine, LLMClient, RunObserver, Clock, StepContext
├── player/        # Player.choose() and its prompts
├── scorer/        # Scorer.score(), status rules, prompts
├── session.py     # GameSession: the loop for one game
├── budget.py      # action and round limits
├── config.py      # Settings from env vars and CLI
├── engine/        # arc.py (real), toy.py (tests)
├── llm/           # anthropic, openai, openrouter, fake, recording, pricing
└── record/        # JSONL writer, run log, memory recorder
bench/
├── arcagi3.py     # CLI: run, view, list, schema
├── runner.py      # plays games on worker threads
└── viewer/        # static HTML + JS modules, no build step
tests/             # pytest; FakeLLM and ToyEngine, no network
ARC-AGI-3-Agents/  # official harness, git submodule
```

## Import rules

`import-linter` enforces these rules (`pyproject.toml`). A test also runs it.

| Module | Can import |
|---|---|
| `core` | stdlib, `pydantic` |
| `perception`, `ports` | `core` |
| `player`, `scorer` | `core`, `perception`, `ports` |
| `session` | `core`, `perception`, `ports`, `player`, `scorer` |
| `engine/*`, `llm/*`, `record/*` | `core`, `ports`, their own SDK |
| `bench` | all |

Also:

- `player` and `scorer` do not import each other.
- `engine`, `llm`, and `record` do not import each other.
- Only `engine/arc.py` imports `arc_agi` or `arcengine`.
- Only the provider files in `llm/` import `anthropic` or `openai`.

Do not break a rule to make a change easy. Add a port or move the code.

## Design rules

- **Ports and adapters.** Services use ports from `ports.py`. Real and fake adapters supply them. Wire adapters in `bench/`, not in services.
- **Recording is a side channel.** The Player and the Scorer take a plain `LLMClient`. `RecordingLLM` wraps it and sends events. The session sets `StepContext` (`round`, `step`).
- **One source for the run format.** The Pydantic models in `core/events.py` define the run folder format. The writer, the `schema` command, and the tests use them. Change the format there only. Update `docs/data-model.md` and the viewer too.
- **One game crash does not stop the run.** The session catches step errors, emits `error`, and ends the game.
- **Viewer has no build step.** Plain ES modules in `bench/viewer/`. The server uses the stdlib only. It binds to `127.0.0.1` and serves only files under `runs/`.

## Add an LLM provider

1. Add `avocode/llm/<name>.py`. Use `llm/base.py` for the JSON parse and retry.
2. Add the provider to `make_client()` in `llm/factory.py`.
3. Add default models to `DEFAULT_MODELS` in `config.py`.
4. Add token prices to `llm/pricing.py`.
5. Add the module to the import-linter contracts in `pyproject.toml`.
6. Add a test in `tests/test_adapters.py` that uses no network.
7. Update `README.md`, `.env.example`, and `docs/code-architecture.md`.

## Tests

- Tests must not use the network or API keys. Use `FakeLLM`, `ToyEngine`, and `MemoryRecorder`.
- Use the helpers in `tests/helpers.py` (`state()`, `scorer_reply()`).
- Viewer logic (`metrics.js`, `tail.js`) has `node --test` tests in `bench/viewer/tests/`.
- After a change to the event format, make the fixture again with `uv run python -m tests.make_fixture`.

## Code style

- Type hints on all code in `avocode/`. `mypy --strict` must pass.
- Start each module with `from __future__ import annotations` and a one-line docstring.
- Ruff rules: default plus `I` (import sort), `UP`, `B`.
- Comments: 7 words or fewer. Function names: 4 words or fewer.
- User-facing message strings: 10 words or fewer.
- Use the active voice and the most common word.

## Documentation style

- Write docs in ASD-STE100 Simplified Technical English. Use short sentences and one instruction per sentence.
- Aim for a Flesch Reading Ease score near 80.
- When code changes a layer, a port, or the run format, update the related document in `docs/`.

## Do not

- Do not import `ARC-AGI-3-Agents/agents/templates/my_agent.py`. It needs `arcjev`, which is not installed.
- Do not run a full benchmark without a request. It costs API money. Use `--games ls20 --max-actions 20` for a smoke run.
