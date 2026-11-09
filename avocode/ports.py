"""Interfaces the loop uses."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from pydantic import BaseModel

from avocode.core.action import Action
from avocode.core.events import Envelope, LLMRecord
from avocode.core.state import State

Role = Literal["player", "scorer"]


class GameEngine(Protocol):
    game_id: str

    def reset(self) -> State: ...

    def step(self, action: Action) -> State: ...


@dataclass
class LLMRequest:
    role: Role
    system: str
    user: str
    schema: type[BaseModel]
    model: str = ""
    prompt_hash: str = ""


@dataclass
class LLMReply:
    text: str
    parsed: dict[str, Any] | None
    ok: bool = True
    retries: int = 0
    error: str | None = None
    in_tokens: int = 0
    out_tokens: int = 0
    cache_tokens: int = 0  # cache reads
    cache_write_tokens: int = 0
    cost_usd: float | None = None  # cost the provider reports
    provider: str = ""
    model: str = ""


class LLMClient(Protocol):
    def complete(self, req: LLMRequest) -> LLMReply: ...


class RunObserver(Protocol):
    def emit(self, event: Envelope) -> None: ...

    def frames(self, step: int, state: State) -> None: ...

    def llm_call(self, record: LLMRecord) -> None: ...


class Clock(Protocol):
    def now(self) -> float: ...


class SystemClock:
    def now(self) -> float:
        return time.time()


@dataclass
class StepContext:
    """Where the loop is now."""

    round: int = 0
    step: int = 0
    call_ids: list[str] = field(default_factory=list)

    in_tokens: int = 0
    out_tokens: int = 0
    cost_usd: float | None = 0.0

    def begin(self, round_: int, step: int) -> None:
        self.round, self.step = round_, step
        self.call_ids = []

    def add_usage(self, in_tokens: int, out_tokens: int, cost: float | None) -> None:
        """Add tokens and cost. Unknown cost wins."""
        self.in_tokens += in_tokens
        self.out_tokens += out_tokens
        if cost is None or self.cost_usd is None:
            self.cost_usd = None
        else:
            self.cost_usd = round(self.cost_usd + cost, 6)
