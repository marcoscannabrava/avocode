"""Write and read JSONL run files."""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import IO, Any

from avocode.core.events import Envelope, FramesLine, LLMRecord
from avocode.core.state import State


def utc_stamp(when: float | None = None) -> str:
    """ISO time in UTC, with ms."""
    moment = datetime.now(UTC) if when is None else datetime.fromtimestamp(when, UTC)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


class LineWriter:
    """Add one JSON line, then flush."""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._file: IO[str] = path.open("a", encoding="utf-8")
        self._lock = threading.Lock()
        self.seq = 0

    def write_event(self, event: Envelope, game: str | None) -> None:
        with self._lock:
            event.seq = self.seq
            event.ts = event.ts or utc_stamp()
            if game is not None:
                event.game = game
            self._write(event.model_dump(mode="json", exclude_none=False))
            self.seq += 1

    def write(self, data: dict[str, Any]) -> None:
        with self._lock:
            self._write(data)

    def _write(self, data: dict[str, Any]) -> None:
        self._file.write(json.dumps(data, separators=(",", ":")) + "\n")
        self._file.flush()

    def close(self) -> None:
        self._file.close()


class JsonlRecorder:
    """Writes the three files of one game."""

    def __init__(self, game_dir: Path, game: str) -> None:
        self.dir = game_dir
        self.game = game
        self._events = LineWriter(game_dir / "events.jsonl")
        self._frames = LineWriter(game_dir / "frames.jsonl")
        self._llm = LineWriter(game_dir / "llm.jsonl")

    def emit(self, event: Envelope) -> None:
        self._events.write_event(event, self.game)

    def frames(self, step: int, state: State) -> None:
        grid = state.grid
        line = FramesLine(step=step, w=grid.width, h=grid.height,
                          frames=[g.to_hex() for g in state.frames])
        self._frames.write(line.model_dump())

    def llm_call(self, record: LLMRecord) -> None:
        self._llm.write(record.model_dump(mode="json"))

    def close(self) -> None:
        for writer in (self._events, self._frames, self._llm):
            writer.close()


def read_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    """Read full lines. Skip a partial last line."""
    data = path.read_bytes()
    end = data.rfind(b"\n")
    if end < 0:
        return
    for raw in data[: end + 1].splitlines():
        if raw.strip():
            yield json.loads(raw)
