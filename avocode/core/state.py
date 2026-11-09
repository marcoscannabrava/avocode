"""Grid, State, Status, and Outcome."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class Status(StrEnum):
    SUCCESS = "success"
    ONGOING = "ongoing"
    FAILED = "failed"


class Outcome(StrEnum):
    """How a game ends."""

    WON = "won"
    BUDGET = "budget"
    ERROR = "error"
    ABORTED = "aborted"


@dataclass(frozen=True)
class Grid:
    width: int
    height: int
    cells: tuple[int, ...]  # row-major, colors 0..15

    def __post_init__(self) -> None:
        if len(self.cells) != self.width * self.height:
            raise ValueError("cell count does not match size")

    @classmethod
    def from_rows(cls, rows: list[list[int]] | tuple[tuple[int, ...], ...]) -> Grid:
        height = len(rows)
        width = len(rows[0]) if height else 0
        cells = tuple(int(c) for row in rows for c in row)
        return cls(width, height, cells)

    @classmethod
    def from_text(cls, text: str) -> Grid:
        """Parse rows of hex digits."""
        rows = [line.strip() for line in text.strip().splitlines() if line.strip()]
        return cls.from_rows([[int(ch, 16) for ch in row] for row in rows])

    def at(self, x: int, y: int) -> int:
        return self.cells[y * self.width + x]

    def rows(self) -> list[list[int]]:
        w = self.width
        return [list(self.cells[i * w : (i + 1) * w]) for i in range(self.height)]

    def to_hex(self) -> str:
        """One hex digit per cell, row by row."""
        return "".join(format(c, "x") for c in self.cells)

    @classmethod
    def from_hex(cls, text: str, width: int, height: int) -> Grid:
        return cls(width, height, tuple(int(ch, 16) for ch in text))


@dataclass(frozen=True)
class State:
    frames: tuple[Grid, ...]
    game_state: str  # NOT_PLAYED, NOT_FINISHED, WIN, GAME_OVER
    levels_completed: int
    win_levels: int
    available_actions: tuple[str, ...]
    full_reset: bool = False

    @property
    def grid(self) -> Grid:
        """The last frame."""
        return self.frames[-1]
