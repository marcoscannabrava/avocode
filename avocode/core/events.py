"""Event models: the run folder format.

The writer adds the envelope fields.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

SCHEMA_VERSION = 1


class Envelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    v: int = SCHEMA_VERSION
    seq: int | None = None
    ts: str | None = None
    game: str | None = None


# run.jsonl events


class RunStart(Envelope):
    type: Literal["run_start"] = "run_start"
    run_id: str
    games: list[str]
    config: dict[str, Any] = Field(default_factory=dict)


class GameStartRun(Envelope):
    type: Literal["game_start"] = "game_start"
    worker: int = 0


class GameEndRun(Envelope):
    type: Literal["game_end"] = "game_end"
    outcome: str
    levels_completed: int
    win_levels: int
    steps: int
    rounds: int
    cost_usd: float | None


class RunEnd(Envelope):
    type: Literal["run_end"] = "run_end"
    outcome: str
    duration_s: float
    games_won: int
    levels_total: int
    cost_usd: float | None


RunEvent = Annotated[RunStart | GameStartRun | GameEndRun | RunEnd, Field(discriminator="type")]


# events.jsonl events


class Budget(BaseModel):
    max_actions: int
    max_rounds: int


class GameStart(Envelope):
    type: Literal["game_start"] = "game_start"
    win_levels: int
    available_actions: list[str]
    budget: Budget
    rules: str = ""  # rules from past games


class RoundStart(Envelope):
    type: Literal["round_start"] = "round_start"
    round: int
    level: int
    full_reset: bool
    reason: Literal["initial", "failed", "retry"]


class LLMStart(Envelope):
    type: Literal["llm_start"] = "llm_start"
    call_id: str
    role: Literal["player", "scorer"]
    round: int
    step: int


class LLMEnd(Envelope):
    type: Literal["llm_end"] = "llm_end"
    call_id: str
    role: Literal["player", "scorer"]
    ok: bool
    retries: int
    in_tokens: int
    out_tokens: int
    cache_tokens: int
    latency_ms: int
    cost_usd: float | None
    error: str | None = None


class StepAction(BaseModel):
    name: str
    x: int | None = None
    y: int | None = None


class Before(BaseModel):
    game_state: str
    levels_completed: int


class After(BaseModel):
    game_state: str
    levels_completed: int
    available_actions: list[str]


class DiffSummary(BaseModel):
    cells: int
    noop: bool
    bbox: list[int] | None


class Step(Envelope):
    type: Literal["step"] = "step"
    step: int
    round: int
    round_step: int
    level: int
    action: StepAction
    reason: str = ""
    model_version: int
    before: Before
    after: After
    status: Literal["success", "ongoing", "failed"]
    diff: DiffSummary
    frames: int
    flags: list[str] = Field(default_factory=list)
    call_ids: list[str] = Field(default_factory=list)
    ms: dict[str, int] = Field(default_factory=dict)


class ModelUpdate(Envelope):
    type: Literal["model_update"] = "model_update"
    version: int
    parent: int | None
    step: int
    model: dict[str, Any]
    changes: list[str]
    summary: str = ""


class LevelComplete(Envelope):
    type: Literal["level_complete"] = "level_complete"
    level: int
    round: int
    step: int
    steps_in_level: int
    rounds_in_level: int


class RoundEnd(Envelope):
    type: Literal["round_end"] = "round_end"
    round: int
    outcome: Literal["failed", "won", "budget", "error", "aborted"]
    steps: int
    levels_gained: int
    hypothesis: str = ""


class RulesUpdate(Envelope):
    type: Literal["rules_update"] = "rules_update"
    step: int
    games: int  # games behind these rules
    rules: str
    summary: str = ""


WarningCode = Literal[
    "bad_action", "bad_json", "model_kept", "repeat_state", "repeat_round", "rules_kept",
]


class WarningEvent(Envelope):
    type: Literal["warning"] = "warning"
    code: WarningCode
    message: str
    step: int | None = None


class Error(Envelope):
    type: Literal["error"] = "error"
    where: str
    message: str
    traceback: str = ""
    step: int | None = None


class GameEnd(Envelope):
    type: Literal["game_end"] = "game_end"
    outcome: str
    levels_completed: int
    steps: int
    rounds: int
    in_tokens: int
    out_tokens: int
    cost_usd: float | None
    duration_s: float


GameEvent = Annotated[
    GameStart | RoundStart | LLMStart | LLMEnd | Step | ModelUpdate | LevelComplete
    | RoundEnd | RulesUpdate | WarningEvent | Error | GameEnd,
    Field(discriminator="type"),
]

Event = Envelope


# frames.jsonl and llm.jsonl lines


class FramesLine(BaseModel):
    model_config = ConfigDict(extra="forbid")

    step: int
    w: int
    h: int
    frames: list[str]


class LLMRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    call_id: str
    role: Literal["player", "scorer"]
    step: int
    round: int
    provider: str
    model: str
    prompt_hash: str
    system: str
    user: str
    reply: str
    parsed: dict[str, Any] | None
    ok: bool
    retries: int
    error: str | None
    in_tokens: int
    out_tokens: int
    cache_tokens: int
    latency_ms: int
    cost_usd: float | None


class Manifest(BaseModel):
    v: int = SCHEMA_VERSION
    run_id: str
    started: str
    ended: str | None = None
    git: dict[str, Any] = Field(default_factory=dict)
    argv: list[str] = Field(default_factory=list)
    config: dict[str, Any] = Field(default_factory=dict)
    prompts: dict[str, str] = Field(default_factory=dict)
    games: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    scorecard: str | None = None
    summary: dict[str, Any] | None = None


GAME_EVENTS: TypeAdapter[Any] = TypeAdapter(GameEvent)
RUN_EVENTS: TypeAdapter[Any] = TypeAdapter(RunEvent)


def all_schemas() -> dict[str, Any]:
    """JSON schema for each run file."""
    return {
        "events.jsonl": GAME_EVENTS.json_schema(),
        "run.jsonl": RUN_EVENTS.json_schema(),
        "frames.jsonl": FramesLine.model_json_schema(),
        "llm.jsonl": LLMRecord.model_json_schema(),
        "manifest.json": Manifest.model_json_schema(),
    }
