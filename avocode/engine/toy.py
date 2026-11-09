"""A small grid game for tests.

Colors: 0 floor, 2 door, 3 button,
4 goal, 5 wall, 6 player.
"""

from __future__ import annotations

from avocode.core.action import Action
from avocode.core.state import Grid, State

FLOOR, DOOR, BUTTON, GOAL, WALL, PLAYER = 0, 2, 3, 4, 5, 6
MOVES = {"ACTION1": (0, -1), "ACTION2": (0, 1), "ACTION3": (-1, 0), "ACTION4": (1, 0)}
ACTIONS = ("ACTION1", "ACTION2", "ACTION3", "ACTION4", "ACTION6")

LEVELS = (
    """
    55555555
    56000005
    50005005
    50005045
    50000005
    55555555
    """,
    """
    55555555
    56000005
    50002225
    50002425
    50300225
    55555555
    """,
)

# Moves that solve each level.
SOLUTIONS = (
    ["A2", "A2", "A2", "A4", "A4", "A4", "A4", "A4", "A1"],
    ["A6@2,4", "A4", "A4", "A4", "A2", "A2", "A4"],
)


class ToyEngine:
    """Arrows move, walls kill, goals win."""

    def __init__(self, game_id: str = "toy", levels: tuple[str, ...] = LEVELS) -> None:
        self.game_id = game_id
        self._levels = [Grid.from_text(text) for text in levels]
        self._level = 0
        self._state_name = "NOT_PLAYED"
        self._cells: list[int] = []
        self._width = 0
        self._height = 0

    def reset(self) -> State:
        full = self._state_name in ("NOT_PLAYED", "WIN")
        if full:
            self._level = 0
        self._load(self._level)
        return self._state(full_reset=full)

    def step(self, action: Action) -> State:
        if action.name == "RESET":
            return self.reset()
        if self._state_name != "NOT_FINISHED":
            return self._state()
        if action.name in MOVES:
            self._move(*MOVES[action.name])
        elif action.name == "ACTION6":
            self._click(action.x or 0, action.y or 0)
        return self._state()

    def _load(self, level: int) -> None:
        grid = self._levels[level]
        self._cells = list(grid.cells)
        self._width, self._height = grid.width, grid.height
        self._state_name = "NOT_FINISHED"

    def _move(self, dx: int, dy: int) -> None:
        here = self._cells.index(PLAYER)
        x, y = here % self._width + dx, here // self._width + dy
        if not (0 <= x < self._width and 0 <= y < self._height):
            return
        there = y * self._width + x
        target = self._cells[there]
        if target in (DOOR, BUTTON):
            return
        if target == WALL:
            self._state_name = "GAME_OVER"
            return
        self._cells[here], self._cells[there] = FLOOR, PLAYER
        if target == GOAL:
            self._level += 1
            if self._level == len(self._levels):
                self._state_name = "WIN"
            else:
                self._load(self._level)

    def _click(self, x: int, y: int) -> None:
        if not (0 <= x < self._width and 0 <= y < self._height):
            return
        if self._cells[y * self._width + x] == BUTTON:
            self._cells = [FLOOR if c == DOOR else c for c in self._cells]

    def _state(self, full_reset: bool = False) -> State:
        grid = Grid(self._width, self._height, tuple(self._cells))
        return State(
            frames=(grid,),
            game_state=self._state_name,
            levels_completed=self._level,
            win_levels=len(self._levels),
            available_actions=ACTIONS,
            full_reset=full_reset,
        )
