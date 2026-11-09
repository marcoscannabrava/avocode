"""Keep events in lists, for tests."""

from __future__ import annotations

from typing import Any

from avocode.core.events import Envelope, LLMRecord
from avocode.core.state import State


class MemoryRecorder:
    def __init__(self) -> None:
        self.events: list[Envelope] = []
        self.frame_log: list[tuple[int, State]] = []
        self.llm_records: list[LLMRecord] = []

    def emit(self, event: Envelope) -> None:
        self.events.append(event)

    def frames(self, step: int, state: State) -> None:
        self.frame_log.append((step, state))

    def llm_call(self, record: LLMRecord) -> None:
        self.llm_records.append(record)

    def of_type(self, kind: str) -> list[Any]:
        return [e for e in self.events if getattr(e, "type", None) == kind]
