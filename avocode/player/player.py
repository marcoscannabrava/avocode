"""Player: pick the next action."""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from pydantic import BaseModel

from avocode.core.action import Action
from avocode.core.model import GameModel
from avocode.core.state import State
from avocode.perception.encode import background_color, encode_grid
from avocode.perception.objects import find_blobs
from avocode.perception.summary import summarize_state
from avocode.player import prompts
from avocode.ports import LLMClient, LLMRequest


class PlayerReply(BaseModel):
    action: str
    x: int | None = None
    y: int | None = None
    reason: str = ""


@dataclass
class Choice:
    action: Action
    flags: list[str] = field(default_factory=list)
    warnings: list[tuple[str, str]] = field(default_factory=list)


class Player:
    def __init__(self, llm: LLMClient, model_name: str = "") -> None:
        self.llm = llm
        self.model_name = model_name

    def choose(
        self, model: GameModel, state: State, recent: list[Action] | None = None,
        round_: int = 1, notes: list[str] | None = None,
    ) -> Choice:
        recent = recent or []
        reply = self.llm.complete(self._request(model, state, recent, round_, notes or []))
        flags = ["json_retry"] if reply.retries else []
        problem = reply.error or "no reply"
        if reply.parsed is not None:
            data = PlayerReply.model_validate(reply.parsed)
            try:
                action = _to_action(data)
            except ValueError as exc:
                problem = f"bad action {data.action!r}: {exc}"
            else:
                if action.name in state.available_actions:
                    return Choice(action, flags)
                problem = f"{action.name} is not available"
        fallback = fallback_action(state, len(recent))
        warning = ("bad_action", f"{problem[:200]}; used {fallback.short}")
        return Choice(fallback, flags + ["fallback_action"], [warning])

    def _request(
        self, model: GameModel, state: State, recent: list[Action], round_: int,
        notes: list[str],
    ) -> LLMRequest:
        failed = "\n".join(
            f"- round {f.round}: actions {' '.join(f.actions[-30:])}; why: {f.hypothesis}"
            for f in model.failed_rounds
        ) or "none"
        user = prompts.USER.format(
            version=model.version,
            goal=model.prompt or "unknown",
            elements=json.dumps(model.element_breakdown) if model.element_breakdown else "unknown",
            actions_seen=json.dumps(model.allowable_actions) if model.allowable_actions else "none",
            level_notes="; ".join(model.level_notes) or "none",
            questions="; ".join(model.open_questions) or "none",
            failed=failed,
            round=round_, round_step=len(recent) + 1,
            levels=state.levels_completed, win_levels=state.win_levels,
            available=", ".join(state.available_actions),
            recent=" ".join(a.short for a in recent[-30:]) or "none",
            notes="".join(f"Note: {n}\n" for n in notes),
            state=summarize_state(state) + "\n" + encode_grid(state.grid, crop=True),
        )
        return LLMRequest(role="player", system=prompts.SYSTEM, user=user, schema=PlayerReply,
                          model=self.model_name, prompt_hash=prompts.PROMPT_HASH)


def _to_action(data: PlayerReply) -> Action:
    name = data.action.strip().upper()
    if name in ("ACTION6", "A6"):
        if data.x is None or data.y is None:
            raise ValueError("ACTION6 needs x and y")
        return Action("ACTION6", data.x, data.y, reason=data.reason)
    return Action.parse(name, reason=data.reason)


def fallback_action(state: State, turn: int) -> Action:
    """A safe action when the Player fails."""
    simple = [a for a in state.available_actions if a not in ("RESET", "ACTION6")]
    if simple:
        return Action(simple[turn % len(simple)], reason="fallback")
    if "ACTION6" in state.available_actions:
        blobs = find_blobs(state.grid, background=background_color(state.grid))
        if blobs:
            x0, y0, x1, y1 = blobs[turn % len(blobs)].bbox
            return Action("ACTION6", (x0 + x1) // 2, (y0 + y1) // 2, reason="fallback")
        return Action("ACTION6", state.grid.width // 2, state.grid.height // 2, reason="fallback")
    return Action("RESET", reason="fallback")
