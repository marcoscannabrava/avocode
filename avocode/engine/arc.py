"""ARC-AGI-3 games through arc_agi."""

from __future__ import annotations

from typing import Any

from arc_agi import Arcade
from arcengine import FrameData, FrameDataRaw, GameAction

from avocode.core.action import Action
from avocode.core.state import Grid, State


def to_state(raw: FrameDataRaw, last: Grid | None = None) -> State:
    """Convert raw frame data to a State."""
    frames = tuple(Grid.from_rows(arr.tolist()) for arr in raw.frame)
    if not frames:
        frames = (last or Grid(0, 0, ()),)
    names = tuple("RESET" if n == 0 else f"ACTION{n}" for n in raw.available_actions)
    state = raw.state.value if hasattr(raw.state, "value") else str(raw.state)
    return State(frames=frames, game_state=state, levels_completed=raw.levels_completed,
                 win_levels=raw.win_levels, available_actions=names,
                 full_reset=bool(raw.full_reset))


def frame_to_state(frame: FrameData, last: Grid | None = None) -> State:
    """Convert submodule FrameData to a State."""
    frames = tuple(Grid.from_rows(grid) for grid in frame.frame)
    if not frames:
        frames = (last or Grid(0, 0, ()),)
    names = tuple("RESET" if n == 0 else f"ACTION{n}" for n in frame.available_actions)
    state = frame.state.value if hasattr(frame.state, "value") else str(frame.state)
    return State(frames=frames, game_state=state, levels_completed=frame.levels_completed,
                 win_levels=frame.win_levels, available_actions=names,
                 full_reset=bool(frame.full_reset))


def to_game_action(action: Action) -> tuple[GameAction, dict[str, Any]]:
    """GameAction and its data."""
    game_action = GameAction.from_name(action.name)
    data: dict[str, Any] = {}
    if action.name == "ACTION6":
        data = {"x": action.x, "y": action.y}
    return game_action, data


class ArcEngine:
    """One ARC game. Thin wrapper on the env."""

    def __init__(self, game_id: str, env: Any) -> None:
        self.game_id = game_id
        self.env = env
        self._last: Grid | None = None

    def reset(self) -> State:
        return self._convert(self.env.reset())

    def step(self, action: Action) -> State:
        game_action, data = to_game_action(action)
        reasoning = {"reason": action.reason[:500]} if action.reason else {}
        return self._convert(self.env.step(game_action, data=data, reasoning=reasoning))

    def _convert(self, raw: FrameDataRaw | None) -> State:
        if raw is None:
            raise RuntimeError(f"{self.game_id}: no frame data from the game")
        state = to_state(raw, self._last)
        self._last = state.grid
        return state


class ArcArcade:
    """Game list, scorecard, and engines."""

    def __init__(self) -> None:
        self.arcade = Arcade()
        self.card_id: str | None = None

    def list_games(self) -> list[str]:
        return [env.game_id for env in self.arcade.get_environments()]

    def open_scorecard(self, tags: list[str]) -> str:
        self.card_id = str(self.arcade.open_scorecard(tags=tags))
        return self.card_id

    def close_scorecard(self) -> dict[str, Any] | None:
        if self.card_id is None:
            return None
        card, self.card_id = self.card_id, None
        scorecard = self.arcade.close_scorecard(card)
        if scorecard is None:
            return None
        data: dict[str, Any] = scorecard.model_dump(mode="json")
        return data

    def make_engine(self, game_id: str) -> ArcEngine:
        env = self.arcade.make(game_id, scorecard_id=self.card_id)
        if env is None:
            raise RuntimeError(f"could not make game {game_id}")
        return ArcEngine(game_id, env)
