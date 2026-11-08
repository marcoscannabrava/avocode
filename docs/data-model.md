# Data Model

This document gives the data types of avocode and the format of the run folder. The domain types are in `avocode/core/`. The event types are in `avocode/record/events.py`. The Pydantic event models are the one source of truth for the format. `./bench/arcagi3.py schema` prints the JSON schema from them.

## 1. Terms

| Term | Meaning |
|---|---|
| **Run** | One call of `./bench/arcagi3.py`. It plays one or more games. It has one `run_id`. |
| **Game** | One ARC-AGI-3 game in a run, for example `ls20`. One game has many levels. |
| **Level** | One stage of a game. The game reports `levels_completed` and `win_levels`. |
| **Round** | One try at the game. A round starts with a `RESET` and stops at the next `RESET`, at a win, or at the budget limit. The Scorer status `failed` stops a round. |
| **Step** | One action and its result. Step `i` takes `S_{i-1}` and action `a_i`, and gives `S_i`. |
| **State** | What the game shows after a step. This is `S_i` in `ARCHITECTURE.md`. |
| **Model** | What the agent believes about the game. This is `M_i` in `ARCHITECTURE.md`. It has a version number. |
| **LLM call** | One request to the Player or the Scorer LLM. |

The tree is: Run → Game → Round → Step. A Level is a second index on steps. One round can pass through many levels. One level can take many rounds.

Open question: after `GAME_OVER`, does `RESET` restart the level or the full game? `FrameData.full_reset` tells this. The agent records `full_reset` on each `round_start` event, so the viewer is correct in both cases. Find the answer in Step 7 of `PLAN.md`.

## 2. Domain Types

These types are pure data. They do not import the ARC toolkit or an LLM SDK.

```python
class Status(str, Enum):
    SUCCESS = "success"
    ONGOING = "ongoing"
    FAILED = "failed"

class Outcome(str, Enum):        # how a game ends
    WON = "won"
    BUDGET = "budget"            # action or round limit
    ERROR = "error"
    ABORTED = "aborted"          # user stop (Ctrl+C)

@dataclass(frozen=True)
class Grid:
    width: int
    height: int
    cells: tuple[int, ...]       # row-major, colors 0..15

@dataclass(frozen=True)
class State:
    frames: tuple[Grid, ...]     # one or more per step
    game_state: str              # NOT_PLAYED, NOT_FINISHED, WIN, GAME_OVER
    levels_completed: int
    win_levels: int
    available_actions: tuple[str, ...]
    full_reset: bool

    @property
    def grid(self) -> Grid:      # last frame
        return self.frames[-1]

@dataclass(frozen=True)
class Action:
    name: str                    # RESET, ACTION1..ACTION7
    x: int | None = None         # ACTION6 only
    y: int | None = None
    reason: str = ""             # from the Player

class FailedRound(BaseModel):
    round: int
    actions: list[str]           # short form, e.g. "A1", "A6@12,40"
    last_state: str              # text summary
    hypothesis: str              # why it failed

class GameModel(BaseModel):
    version: int = 0
    element_breakdown: dict[str, str] = {}   # color or object -> role
    allowable_actions: dict[str, str] = {}   # action -> seen effect
    prompt: str = ""                         # goal hypothesis
    level_notes: list[str] = []              # what solved past levels
    failed_rounds: list[FailedRound] = []
    open_questions: list[str] = []           # things to test next
```

Notes:

- `Grid.cells` is a tuple, so a `State` is hashable. The loop can find repeated States with a set.
- `GameModel` is Pydantic because the Scorer LLM returns it as JSON. Pydantic checks the reply.
- `open_questions` is new. It tells the Player what to test. This makes exploration a part of the Model, not a hidden habit of the prompt.
- `version` goes up by one on each change. Each step event stores the version it used. So the viewer can show the Model that the Player saw at any step.

## 3. Derived Types

The perception code makes these from a `Grid`. They are not stored in the Model. They are stored in events only as summaries.

```python
@dataclass(frozen=True)
class Blob:                      # connected cells of one color
    id: int
    color: int
    size: int
    bbox: tuple[int, int, int, int]   # x0, y0, x1, y1

@dataclass(frozen=True)
class GridDiff:
    changed: tuple[tuple[int, int, int, int], ...]  # x, y, old, new
    @property
    def noop(self) -> bool: return not self.changed
```

## 4. The Run Folder

```
runs/
├── latest -> 20261108-153012-a1b2c3d
└── 20261108-153012-a1b2c3d/
    ├── manifest.json
    ├── run.jsonl
    ├── stdout.log
    └── games/
        └── ls20-016295f7601e/
            ├── events.jsonl
            ├── frames.jsonl
            └── llm.jsonl
```

The `run_id` is `<UTC date>-<UTC time>-<short git commit>`.

### 4.1 Why three files per game

| File | Size per step | Who reads it | When |
|---|---|---|---|
| `events.jsonl` | about 0.5 KB | overview, charts | always, every poll |
| `frames.jsonl` | 4 to 30 KB | round player | only when you open a round |
| `llm.jsonl` | 5 to 50 KB | LLM call panel | only when you open a call |

The viewer polls `events.jsonl` for all games. It must stay small. Large data goes to the other two files. The files link by `step` and `call_id`.

One writer owns each game folder. So there are no locks on game files. `run.jsonl` has one lock, because all game threads write to it.

### 4.2 Write rules

1. The writer adds one full JSON object and one `\n` per write. Then it flushes.
2. The writer never edits a line that is already written.
3. A reader must skip a last line that has no `\n`. It is not complete yet.
4. `manifest.json` is the only file that changes. The writer writes a temp file, then renames it. A reader never sees a half file.

### 4.3 Event envelope

Each line in `events.jsonl` and `run.jsonl` has these fields:

```json
{"v": 1, "seq": 42, "ts": "2026-11-08T15:31:07.123Z", "type": "step", "game": "ls20-016295f7601e", ...}
```

| Field | Meaning |
|---|---|
| `v` | Schema version. Change it on each breaking change. |
| `seq` | Line number in this file, from 0. A gap tells you that data is lost. |
| `ts` | UTC time of the event |
| `type` | Event type (see below) |
| `game` | Game id. Not in `run_start` and `run_end`. |

### 4.4 `run.jsonl` events

| Type | Fields |
|---|---|
| `run_start` | `run_id`, `games` (list), `config` |
| `game_start` | `game`, `worker` |
| `game_end` | `game`, `outcome`, `levels_completed`, `win_levels`, `steps`, `rounds`, `cost_usd` |
| `run_end` | `outcome`, `duration_s`, `games_won`, `levels_total`, `cost_usd` |

The viewer finds games from `run.jsonl`. It does not list folders.

### 4.5 `events.jsonl` events

| Type | When | Fields |
|---|---|---|
| `game_start` | first | `win_levels`, `available_actions`, `budget` (`max_actions`, `max_rounds`) |
| `round_start` | after each `RESET` | `round`, `level`, `full_reset`, `reason` (`initial`, `failed`, `retry`) |
| `llm_start` | before each LLM call | `call_id`, `role` (`player`, `scorer`), `round`, `step` |
| `llm_end` | after each LLM call | `call_id`, `role`, `ok`, `retries`, `in_tokens`, `out_tokens`, `cache_tokens`, `latency_ms`, `cost_usd`, `error` |
| `step` | after each action | see 4.6 |
| `model_update` | when the Scorer changes the Model | `version`, `parent`, `step`, `model` (full), `changes` (list of changed field paths), `summary` |
| `level_complete` | when `levels_completed` goes up | `level`, `round`, `step`, `steps_in_level`, `rounds_in_level` |
| `round_end` | before the next `RESET` or at game end | `round`, `outcome` (`failed`, `won`, `budget`, `error`), `steps`, `levels_gained`, `hypothesis` |
| `warning` | a recoverable problem | `code`, `message`, `step` |
| `error` | an exception | `where`, `message`, `traceback`, `step` |
| `game_end` | last | `outcome`, `levels_completed`, `steps`, `rounds`, `in_tokens`, `out_tokens`, `cost_usd`, `duration_s` |

`llm_start` and `llm_end` are two events, not one. If a call hangs, the viewer sees an open `llm_start` and shows "waiting for Player, 45 s".

Warning codes:

| Code | Meaning |
|---|---|
| `bad_action` | The Player gave an action that is not available. The loop used a fallback. |
| `bad_json` | An LLM reply did not match the schema. |
| `model_kept` | The Scorer failed twice. The loop kept the old Model. |
| `repeat_state` | The State is the same as an earlier State in this round. |
| `repeat_round` | The first actions of this round are the same as a failed round. |

### 4.6 The `step` event

```json
{
  "v": 1, "seq": 57, "ts": "...", "type": "step", "game": "ls20-016295f7601e",
  "step": 31, "round": 3, "round_step": 8, "level": 1,
  "action": {"name": "ACTION6", "x": 12, "y": 40},
  "reason": "Click the blue key to test if it opens the door.",
  "model_version": 7,
  "before": {"game_state": "NOT_FINISHED", "levels_completed": 1},
  "after":  {"game_state": "NOT_FINISHED", "levels_completed": 1,
             "available_actions": ["ACTION1", "ACTION2", "ACTION6"]},
  "status": "ongoing",
  "diff": {"cells": 14, "noop": false, "bbox": [10, 38, 14, 42]},
  "frames": 3,
  "flags": ["scorer_skipped"],
  "call_ids": ["p-31", "s-31"],
  "ms": {"player": 2310, "engine": 85, "scorer": 4120}
}
```

| Field | Meaning |
|---|---|
| `step` | Step number in the game. It does not reset with a new round. |
| `round_step` | Step number in the round, from 1 |
| `level` | Level index when the action started (`levels_completed` before) |
| `diff` | Summary only. The viewer gets the full diff from `frames.jsonl`. |
| `flags` | Short markers: `fallback_action`, `scorer_skipped`, `json_retry` |
| `ms` | Time for each part of the step |

A `RESET` is also a step. Its action name is `RESET`. This keeps frames and steps one to one.

### 4.7 `frames.jsonl`

One line per step, and one line with `step: 0` for the first State.

```json
{"step": 31, "w": 64, "h": 64, "frames": ["0000a...<4096 hex chars>", "..."]}
```

Each grid is one string. Each character is one cell as a hex digit (`0` to `f`), row by row. A 64x64 grid is 4096 characters. This format is easy to read in a text editor and fast to parse in the browser.

If the files become too large, add key frames and diffs later. Change `v` when you do.

### 4.8 `llm.jsonl`

One line per LLM call. The line is written when the call ends.

```json
{
  "call_id": "s-31", "role": "scorer", "step": 31, "round": 3,
  "provider": "anthropic", "model": "claude-opus-5-5",
  "prompt_hash": "9f2c…",
  "system": "...", "user": "...",
  "reply": "...", "parsed": {"...": "..."},
  "ok": true, "retries": 0, "error": null,
  "in_tokens": 5120, "out_tokens": 610, "cache_tokens": 4096,
  "latency_ms": 4120, "cost_usd": 0.021
}
```

`prompt_hash` is the hash of the prompt template, not the filled prompt. It tells you which prompt version made the call.

### 4.9 `manifest.json`

```json
{
  "v": 1,
  "run_id": "20261108-153012-a1b2c3d",
  "started": "2026-11-08T15:30:12Z",
  "ended": null,
  "git": {"commit": "a1b2c3d…", "dirty": true},
  "argv": ["--games", "ls20"],
  "config": {"llm": "anthropic", "player_model": "...", "scorer_model": "...",
             "max_actions": 400, "max_rounds": 20, "workers": 1},
  "prompts": {"player": "<hash>", "scorer": "<hash>"},
  "games": ["ls20-016295f7601e"],
  "summary": null
}
```

The writer fills `ended` and `summary` at the end. If `ended` is `null` and no event came for 60 s, the run probably crashed.

## 5. How to Rebuild a Round

To show round 3 of `ls20`:

1. Read `events.jsonl`. Find `round_start` with `round: 3`. Get the steps until the next `round_end`.
2. Read `frames.jsonl`. Get the lines for those steps. Also get the line for the step before the round, as the start grid.
3. For each step, draw the grid. Draw the diff from the previous grid. Show the action and `reason`.
4. For the Model at a step, find the last `model_update` with `version` equal to the step's `model_version`.
5. For the LLM calls at a step, read `llm.jsonl` lines by `call_ids`.

All five parts use only the run folder. No live process is needed.
