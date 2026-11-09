"""Scorer: update the Model, set the status."""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from pydantic import BaseModel, Field

from avocode.core.action import Action
from avocode.core.model import MAX_FAILED_ROUNDS, FailedRound, GameModel
from avocode.core.state import State, Status
from avocode.perception.diff import grid_diff
from avocode.perception.summary import state_header, summarize_state
from avocode.perception.tracker import Tracker
from avocode.ports import LLMClient, LLMRequest
from avocode.scorer import prompts
from avocode.scorer.status import status_from_state

NOOP_NOTE = "no-op: grid did not change"


class ScorerReply(BaseModel):
    element_breakdown: dict[str, str] = Field(default_factory=dict)
    allowable_actions: dict[str, str] = Field(default_factory=dict)
    prompt: str = ""
    level_notes: list[str] = Field(default_factory=list)
    failed_rounds: list[FailedRound] = Field(default_factory=list)
    open_questions: list[str] = Field(default_factory=list)
    summary: str = ""


@dataclass
class ScoreInput:
    prev: State | None
    state: State
    model: GameModel
    action: Action | None = None
    round_actions: list[Action] = field(default_factory=list)
    round: int = 1
    step: int = 0
    view: str | None = None  # objects text from a Tracker
    changes: str | None = None  # change text from a Tracker


@dataclass
class ScoreResult:
    model: GameModel
    status: Status
    changes: list[str] = field(default_factory=list)
    summary: str = ""
    hypothesis: str = ""
    flags: list[str] = field(default_factory=list)
    warnings: list[tuple[str, str]] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(self.changes)


class Scorer:
    def __init__(self, llm: LLMClient, model_name: str = "", skip_noop: bool = True) -> None:
        self.llm = llm
        self.model_name = model_name
        self.skip_noop = skip_noop

    def score(self, inp: ScoreInput) -> ScoreResult:
        status = status_from_state(inp.state)
        old = inp.model
        if status is Status.SUCCESS:
            return ScoreResult(old, status)
        diff = grid_diff(inp.prev.grid if inp.prev else None, inp.state.grid)
        if (self.skip_noop and diff.noop and status is Status.ONGOING
                and inp.prev is not None and inp.action is not None):
            return self._noop(inp, status)
        reply = self.llm.complete(self._request(inp, status))
        flags = ["json_retry"] if reply.retries else []
        warnings: list[tuple[str, str]] = []
        if reply.parsed is None:
            warnings.append(("model_kept", f"Scorer failed twice: {reply.error or ''}"[:300]))
            new = old.model_copy(deep=True)
            summary = "kept old Model"
        else:
            data = ScorerReply.model_validate(reply.parsed)
            summary = data.summary
            new = GameModel(**data.model_dump(exclude={"summary"}))
            new.failed_rounds = _merge_failed(old.failed_rounds, new.failed_rounds)
        if status is Status.FAILED:
            _ensure_failed(new, old, inp)
        new.failed_rounds = new.failed_rounds[-MAX_FAILED_ROUNDS:]
        return self._finish(old, new, status, summary, flags, warnings)

    def _noop(self, inp: ScoreInput, status: Status) -> ScoreResult:
        old = inp.model
        new = old.model_copy(deep=True)
        name = inp.action.name  # type: ignore[union-attr]
        seen = new.allowable_actions.get(name)
        if seen is None:
            new.allowable_actions[name] = NOOP_NOTE
        elif "no-op" not in seen:
            new.allowable_actions[name] = seen + " [also seen as no-op]"
        summary = f"{name} did not change the grid" if new != old else ""
        return self._finish(old, new, status, summary, ["scorer_skipped"], [])

    def _finish(
        self, old: GameModel, new: GameModel, status: Status, summary: str,
        flags: list[str], warnings: list[tuple[str, str]],
    ) -> ScoreResult:
        changes = new.changes_from(old)
        new.version = old.version + 1 if changes else old.version
        hypothesis = ""
        if status is Status.FAILED and new.failed_rounds:
            hypothesis = new.failed_rounds[-1].hypothesis
        return ScoreResult(new, status, changes, summary, hypothesis, flags, warnings)

    def _request(self, inp: ScoreInput, status: Status) -> LLMRequest:
        actions = [a.short for a in inp.round_actions]
        failed = ""
        if status is Status.FAILED:
            failed = prompts.FAILED_NOTE.format(round=inp.round, actions_json=json.dumps(actions))
        view, changes = _perceive(inp)
        user = prompts.USER.format(
            version=inp.model.version,
            model=inp.model.model_dump_json(indent=1, exclude={"version"}),
            round=inp.round, step=inp.step,
            levels=inp.state.levels_completed, win_levels=inp.state.win_levels,
            status=status.value,
            actions=" ".join(actions[-30:]) or "none",
            action=_action_text(inp.action),
            state=state_header(inp.state) + "\n" + view,
            changes=changes,
            failed_note=failed,
        )
        return LLMRequest(role="scorer", system=prompts.SYSTEM, user=user, schema=ScorerReply,
                          model=self.model_name, prompt_hash=prompts.PROMPT_HASH)


def _merge_failed(old: list[FailedRound], new: list[FailedRound]) -> list[FailedRound]:
    """Keep old rounds. New entries win."""
    by_round = {f.round: f for f in old}
    by_round.update({f.round: f for f in new})
    return [by_round[r] for r in sorted(by_round)]


def _ensure_failed(new: GameModel, old: GameModel, inp: ScoreInput) -> None:
    """Add a FailedRound if the LLM did not."""
    if any(f.round == inp.round for f in new.failed_rounds):
        return
    new.failed_rounds.append(FailedRound(
        round=inp.round,
        actions=[a.short for a in inp.round_actions],
        last_state=summarize_state(inp.state, max_blobs=4),
        hypothesis="unknown: the Scorer gave no hypothesis",
    ))


def _perceive(inp: ScoreInput) -> tuple[str, str]:
    """Objects and changes; build them if not given."""
    if inp.view is not None and inp.changes is not None:
        return inp.view, inp.changes
    tracker = Tracker()
    if inp.prev is not None:
        tracker.update(inp.prev.grid)
    tracker.update(inp.state.grid, inp.action.name if inp.action else None)
    changes = tracker.changes_text() if inp.prev else "first State, no previous State"
    return inp.view or tracker.objects_text(), inp.changes or changes


def _action_text(action: Action | None) -> str:
    if action is None:
        return "none"
    return action.short + (f" (reason: {action.reason})" if action.reason else "")
