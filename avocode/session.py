"""GameSession: the loop for one game."""

from __future__ import annotations

import threading
import traceback
from dataclasses import dataclass, field

from avocode.budget import Budget
from avocode.core import events as ev
from avocode.core.action import Action
from avocode.core.model import GameModel
from avocode.core.state import Outcome, State, Status
from avocode.perception.diff import grid_diff
from avocode.player.player import Choice, Player
from avocode.ports import Clock, GameEngine, RunObserver, StepContext, SystemClock
from avocode.scorer.scorer import ScoreInput, Scorer, ScoreResult
from avocode.scorer.status import status_from_state

REPEAT_PREFIX = 5  # actions that make a repeat round


@dataclass
class GameResult:
    game: str
    outcome: Outcome
    levels_completed: int = 0
    win_levels: int = 0
    steps: int = 0
    rounds: int = 0
    in_tokens: int = 0
    out_tokens: int = 0
    cost_usd: float | None = 0.0
    duration_s: float = 0.0
    model: GameModel = field(default_factory=GameModel)


@dataclass
class _Round:
    number: int
    start_step: int
    start_level: int
    actions: list[Action] = field(default_factory=list)
    seen: set[tuple[object, ...]] = field(default_factory=set)
    repeat_warned: bool = False


class GameSession:
    def __init__(
        self, engine: GameEngine, player: Player, scorer: Scorer, observer: RunObserver,
        budget: Budget | None = None, clock: Clock | None = None,
        ctx: StepContext | None = None, stop: threading.Event | None = None,
    ) -> None:
        self.engine = engine
        self.player = player
        self.scorer = scorer
        self.obs = observer
        self.budget = budget or Budget()
        self.clock = clock or SystemClock()
        self.ctx = ctx or StepContext()
        self.stop = stop or threading.Event()
        self.model = GameModel()
        self.state: State | None = None
        self.status = Status.ONGOING
        self.step = 0
        self.round: _Round | None = None
        self.rounds = 0
        self.level_start_step = 0
        self.level_start_round = 1
        self.notes: list[str] = []
        self._start = self.clock.now()
        self._where = "session"
        self._t: list[float] = []
        self._choice = Choice(Action("RESET"))

    def run(self) -> GameResult:
        """Play until win, budget, stop, or error."""
        try:
            self._where = "engine"
            self.begin(self.engine.reset())
            while (outcome := self.stop_reason()) is None:
                action = self.decide()
                self._where = "engine"
                state = self.engine.step(action)
                self.observe(action, state)
            return self.end(outcome)
        except Exception as exc:  # noqa: BLE001 - one game must not stop the run
            return self.fail(exc)

    # Step API. run() and the submodule adapter use it.

    def begin(self, state: State) -> None:
        """Take the first State. Make Model 0."""
        self._start = self.clock.now()
        self.ctx.begin(1, 0)
        self.state = state
        self.obs.frames(0, state)
        self.obs.emit(ev.GameStart(
            win_levels=state.win_levels, available_actions=list(state.available_actions),
            budget=ev.Budget(max_actions=self.budget.max_actions,
                             max_rounds=self.budget.max_rounds),
        ))
        self._open_round(state, "initial")
        self._where = "scorer"
        result = self.scorer.score(ScoreInput(None, state, self.model, round=1, step=0))
        self._where = "session"
        self._apply(result)

    def stop_reason(self) -> Outcome | None:
        """Why to stop now, or None."""
        if self.status is Status.SUCCESS:
            return Outcome.WON
        if self.stop.is_set():
            return Outcome.ABORTED
        if not self.budget.actions_left(self.step):
            return Outcome.BUDGET
        if self.status is Status.FAILED and not self.budget.rounds_left(self.rounds):
            return Outcome.BUDGET
        return None

    def decide(self) -> Action:
        """Pick the next action. RESET after a failed round."""
        self.step += 1
        self._t = [self.clock.now()]
        if self.status is Status.FAILED:
            self.ctx.begin(self.rounds + 1, self.step)
            self._choice = Choice(Action("RESET", reason="round failed"))
            self._t.append(self._t[0])
            return self._choice.action
        rnd = self.round
        assert rnd is not None and self.state is not None
        self.ctx.begin(rnd.number, self.step)
        self._where = "player"
        self._choice = self.player.choose(self.model, self.state, list(rnd.actions),
                                          rnd.number, self.notes)
        self._where = "session"
        self._t.append(self.clock.now())
        for code, message in self._choice.warnings:
            self._warn(code, message)
        return self._choice.action

    def observe(self, action: Action, state: State) -> None:
        """Take the State after an action."""
        self._t.append(self.clock.now())
        if action.name == "RESET" and self.status is Status.FAILED:
            self._after_reset(state)
            return
        rnd = self.round
        prev = self.state
        assert rnd is not None and prev is not None
        rnd.actions.append(action)
        old_version = self.model.version
        self._where = "scorer"
        result = self.scorer.score(ScoreInput(prev, state, self.model, action,
                                              list(rnd.actions), rnd.number, self.step))
        self._where = "session"
        t0, t1, t2 = self._t
        t3 = self.clock.now()
        self.state = state
        self._apply(result)
        self._check_repeats(state)
        ms = {"player": _ms(t0, t1), "engine": _ms(t1, t2), "scorer": _ms(t2, t3)}
        self._emit_step(prev, state, action, old_version, self._choice.flags + result.flags, ms)
        self._check_level(prev, state)
        if result.status is Status.FAILED:
            self._close_round("failed", result.hypothesis)
        elif result.status is Status.SUCCESS:
            self._close_round("won")

    def fail(self, exc: BaseException) -> GameResult:
        """Record an exception. End the game."""
        self.obs.emit(ev.Error(where=self._where, message=f"{type(exc).__name__}: {exc}",
                               traceback=traceback.format_exc(), step=self.step))
        return self.end(Outcome.ERROR)

    def _after_reset(self, state: State) -> None:
        prev = self.state
        assert prev is not None
        self.state = state
        self.status = status_from_state(state)
        self._open_round(state, "failed")
        assert self.round is not None
        self.round.seen.add(_key(state))
        self._emit_step(prev, state, Action("RESET", reason="round failed"), self.model.version,
                        [], {"engine": _ms(self._t[1], self._t[2])})

    # Helpers

    def _apply(self, result: ScoreResult) -> None:
        self.status = result.status
        for code, message in result.warnings:
            self._warn(code, message)
        if result.changed:
            old = self.model
            self.obs.emit(ev.ModelUpdate(
                version=result.model.version, parent=old.version if old.version else None,
                step=self.step, model=result.model.model_dump(mode="json"),
                changes=result.changes, summary=result.summary,
            ))
        self.model = result.model

    def _open_round(self, state: State, reason: str) -> None:
        self.rounds += 1
        start = self.step - 1 if reason == "failed" else self.step  # RESET step is in round
        self.round = _Round(self.rounds, start, state.levels_completed)
        self.notes = []
        self.obs.emit(ev.RoundStart(round=self.rounds, level=state.levels_completed,
                                    full_reset=state.full_reset, reason=reason))  # type: ignore[arg-type]

    def _close_round(self, outcome: str, hypothesis: str = "") -> None:
        rnd = self.round
        if rnd is None:
            return
        level = self.state.levels_completed if self.state else rnd.start_level
        self.obs.emit(ev.RoundEnd(
            round=rnd.number, outcome=outcome, steps=self.step - rnd.start_step,  # type: ignore[arg-type]
            levels_gained=level - rnd.start_level, hypothesis=hypothesis,
        ))
        self.round = None

    def _emit_step(self, prev: State, state: State, action: Action, version: int,
                   flags: list[str], ms: dict[str, int]) -> None:
        rnd_number = self.round.number if self.round else self.rounds
        start = self.round.start_step if self.round else self.step - 1
        self.obs.emit(ev.Step(
            step=self.step, round=rnd_number, round_step=self.step - start,
            level=prev.levels_completed,
            action=ev.StepAction(name=action.name, x=action.x, y=action.y),
            reason=action.reason, model_version=version,
            before=ev.Before(game_state=prev.game_state,
                             levels_completed=prev.levels_completed),
            after=ev.After(game_state=state.game_state, levels_completed=state.levels_completed,
                           available_actions=list(state.available_actions)),
            status=self.status.value,
            diff=ev.DiffSummary.model_validate(grid_diff(prev.grid, state.grid).summary()),
            frames=len(state.frames), flags=sorted(set(flags)),
            call_ids=list(self.ctx.call_ids), ms=ms,
        ))
        self.obs.frames(self.step, state)

    def _check_level(self, prev: State, state: State) -> None:
        if state.levels_completed <= prev.levels_completed:
            return
        rnd = self.round
        assert rnd is not None
        self.obs.emit(ev.LevelComplete(
            level=state.levels_completed, round=rnd.number, step=self.step,
            steps_in_level=self.step - self.level_start_step,
            rounds_in_level=rnd.number - self.level_start_round + 1,
        ))
        self.level_start_step = self.step
        self.level_start_round = rnd.number
        rnd.seen = {_key(state)}

    def _check_repeats(self, state: State) -> None:
        rnd = self.round
        assert rnd is not None
        key = _key(state)
        if key in rnd.seen and self.status is Status.ONGOING:
            self._warn("repeat_state", "State seen before in this round")
            self.notes = _add_note(self.notes, "The last action led to a State seen before "
                                   "in this round. Try something new.")
        rnd.seen.add(key)
        if rnd.repeat_warned or len(rnd.actions) != REPEAT_PREFIX:
            return
        prefix = [a.short for a in rnd.actions]
        for failed in self.model.failed_rounds:
            if failed.actions[:REPEAT_PREFIX] == prefix:
                rnd.repeat_warned = True
                self._warn("repeat_round", f"first {REPEAT_PREFIX} actions match round "
                           f"{failed.round}")
                self.notes = _add_note(self.notes, f"This round repeats the start of failed "
                                       f"round {failed.round}. Change course.")
                break

    def _warn(self, code: str, message: str) -> None:
        self.obs.emit(ev.WarningEvent(code=code, message=message, step=self.step))  # type: ignore[arg-type]

    def end(self, outcome: Outcome) -> GameResult:
        """Close the round. Emit game_end."""
        if self.round is not None:
            round_outcome = "won" if outcome is Outcome.WON else outcome.value
            self._close_round(round_outcome)
        state = self.state
        duration = round(self.clock.now() - self._start, 3)
        result = GameResult(
            game=self.engine.game_id, outcome=outcome,
            levels_completed=state.levels_completed if state else 0,
            win_levels=state.win_levels if state else 0,
            steps=self.step, rounds=self.rounds,
            in_tokens=self.ctx.in_tokens, out_tokens=self.ctx.out_tokens,
            cost_usd=self.ctx.cost_usd, duration_s=duration, model=self.model,
        )
        self.obs.emit(ev.GameEnd(
            outcome=outcome.value, levels_completed=result.levels_completed, steps=self.step,
            rounds=self.rounds, in_tokens=result.in_tokens, out_tokens=result.out_tokens,
            cost_usd=result.cost_usd, duration_s=duration,
        ))
        return result


def _key(state: State) -> tuple[object, ...]:
    return (state.grid.cells, state.levels_completed)


def _ms(start: float, end: float) -> int:
    return int((end - start) * 1000)


def _add_note(notes: list[str], note: str) -> list[str]:
    return notes if note in notes else [*notes, note]
