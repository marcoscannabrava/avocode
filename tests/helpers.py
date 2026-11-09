"""Shared test helpers."""

from __future__ import annotations

from typing import Any

from avocode.core import Grid, State


def state(text: str = "000\n060\n000", game_state: str = "NOT_FINISHED", levels: int = 0,
          actions: tuple[str, ...] = ("ACTION1", "ACTION2", "ACTION6")) -> State:
    return State((Grid.from_text(text),), game_state, levels, 2, actions)


def scorer_reply(**overrides: Any) -> dict[str, Any]:
    reply: dict[str, Any] = {
        "element_breakdown": {"6": "player"},
        "allowable_actions": {},
        "prompt": "reach the goal",
        "level_notes": [],
        "failed_rounds": [],
        "open_questions": ["what does ACTION6 do?"],
        "summary": "first look",
    }
    reply.update(overrides)
    return reply
