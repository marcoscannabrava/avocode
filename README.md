# avocode

avocode is an agent that plays ARC-AGI-3 games. It uses two LLMs and one game engine in a loop:

- The **Player** reads the game Model and the current State. It picks the next action.
- The **Game** runs the action. It gives the next State.
- The **Scorer** compares the previous and current States. It updates the Model and sets the status.

`ARCHITECTURE.md` gives the full design.

> **Status: M0 to M7 and M9 are done.** M8 (tune on real games) needs API keys. `PLAN.md` gives the build steps.

## Requirements

- Python 3.12 or later
- [uv](https://docs.astral.sh/uv/)
- An ARC-AGI-3 API key from [three.arcprize.org](https://three.arcprize.org/)
- An LLM API key (Anthropic or OpenAI)

## Setup

```bash
git clone --recurse-submodules <repo-url> avocode_v2
cd avocode_v2
uv sync
cp .env.example .env
```

Put your keys in `.env`:

```bash
ARC_API_KEY=...
ANTHROPIC_API_KEY=...     # or OPENAI_API_KEY
AVOCODE_LLM=anthropic     # or openai
```

## Run the benchmark

```bash
./bench/arcagi3.py
```

This command plays all available ARC-AGI-3 games. It writes one run folder to `runs/<run_id>/`. It prints a summary table at the end.

Common options:

```bash
# Play two games, four at a time
./bench/arcagi3.py --games ls20,ft09 --workers 4

# Limit actions and resets per game
./bench/arcagi3.py --games ls20 --max-actions 200 --max-rounds 10

# Open the live viewer during the run
./bench/arcagi3.py --games ls20 --serve
```

All options:

| Option | Default | Use |
|---|---|---|
| `--games` | all | Comma-separated game ids or prefixes |
| `--workers` | `1` | Games to play at the same time |
| `--max-actions` | `400` | Action limit per game |
| `--max-rounds` | `20` | Round limit per game |
| `--llm` | `anthropic` | LLM provider |
| `--player-model` | from config | Model for the Player |
| `--scorer-model` | from config | Model for the Scorer |
| `--out` | `runs` | Parent folder for run folders |
| `--tag` | none | Label for the run. You can use it more than one time. |
| `--serve` | off | Start the viewer during the run |
| `--port` | `8765` | Viewer port |

Other commands:

```bash
./bench/arcagi3.py view runs/<run_id>   # open the viewer on a run
./bench/arcagi3.py view                 # open the viewer on runs/latest
./bench/arcagi3.py list                 # list past runs with scores
./bench/arcagi3.py schema               # print the event JSON schema
```

## The run folder

Each run makes one folder. The agent adds lines to the files while it plays. You can read a run while it is still running.

```
runs/<run_id>/
├── manifest.json        # config, git commit, prompt hashes, summary
├── run.jsonl            # run events: games started and ended
└── games/<game_id>/
    ├── events.jsonl     # rounds, steps, Model updates, errors
    ├── frames.jsonl     # grids for each step
    └── llm.jsonl        # each LLM prompt, reply, tokens, and cost
```

`runs/latest` is a link to the newest run.

The files have enough data to replay each round of each game, step by step. `docs/data-model.md` gives the format.

## The viewer

The viewer is a browser page. It reads the run folder and updates every two seconds.

It shows:

- **Run overview:** score, progress, cost, and health for each game.
- **Game view:** levels against steps, rounds, action counts, cost, and LLM latency.
- **Round player:** the grid at each step, the changed cells, the action, and the Player's reason.
- **Model history:** each version of the Model, the changes, and the failed-round hypotheses.
- **LLM calls:** the full prompt and reply for each call.

`docs/viewer.md` gives the design.

## Tests

```bash
uv run pytest
uv run lint-imports
```

The tests use a small grid game and a fake LLM. They do not use the network. `uv run pytest` also runs the viewer tests with `node --test` if Node is installed.

To make the fixture run again, and to see it in the viewer:

```bash
uv run python -m tests.make_fixture
./bench/arcagi3.py view tests/fixtures/runs/toy
```

## Repository layout

```
avocode_v2/
├── ARCHITECTURE.md      # agent design
├── PLAN.md              # build plan
├── README.md
├── docs/
│   ├── data-model.md    # domain types and run folder format
│   ├── code-architecture.md
│   └── viewer.md
├── avocode/             # agent package
├── bench/
│   ├── arcagi3.py       # benchmark command
│   └── viewer/          # browser viewer
├── tests/
└── ARC-AGI-3-Agents/    # official harness (git submodule)
```

## Documents

- `ARCHITECTURE.md`: how the agent thinks
- `PLAN.md`: build steps and milestones
- `docs/data-model.md`: domain types, events, and run folder format
- `docs/code-architecture.md`: layers, modules, and dependency rules
- `docs/viewer.md`: viewer screens, metrics, and charts
