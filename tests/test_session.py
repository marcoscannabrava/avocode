import threading
from pathlib import Path
from typing import Any

import jsonschema
import pytest

from avocode.budget import Budget
from avocode.core import Action, Grid, Outcome, State
from avocode.core.events import LLMRecord, all_schemas
from avocode.engine.toy import SOLUTIONS, ToyEngine
from avocode.llm.fake import FakeLLM
from avocode.llm.recording import RecordingLLM
from avocode.perception import grid_diff
from avocode.player.player import Player
from avocode.ports import LLMRequest, StepContext
from avocode.record.jsonl import read_jsonl
from avocode.record.memory import MemoryRecorder
from avocode.scorer.scorer import Scorer
from avocode.session import GameSession
from tests import make_fixture
from tests.helpers import scorer_reply

FIXTURE = Path(__file__).parent / "fixtures" / "runs" / "toy"


def moves(*shorts: str) -> list[dict[str, Any]]:
    out = []
    for s in shorts:
        a = Action.parse(s)
        out.append({"action": a.name, "x": a.x, "y": a.y, "reason": s})
    return out


def scorer_default(req: LLMRequest) -> dict[str, Any]:
    if "This round FAILED" in req.user:
        return scorer_reply(failed_rounds=[{"round": 1, "actions": ["A1"], "last_state": "x",
                                            "hypothesis": "wall kills"}])
    return scorer_reply()


def session(player_moves: list[str], budget: Budget | None = None,
            stop: threading.Event | None = None, engine: Any = None) -> tuple[GameSession,
                                                                             MemoryRecorder]:
    rec = MemoryRecorder()
    ctx = StepContext()
    player = Player(RecordingLLM(FakeLLM(moves(*player_moves)), rec, ctx), "fake")
    scorer = Scorer(RecordingLLM(FakeLLM(default=scorer_default), rec, ctx), "fake")
    return GameSession(engine or ToyEngine(), player, scorer, rec, budget, ctx=ctx,
                       stop=stop), rec


def test_session_wins() -> None:
    sess, rec = session([*SOLUTIONS[0], *SOLUTIONS[1]])
    result = sess.run()
    assert result.outcome is Outcome.WON
    assert result.levels_completed == 2 and result.steps == len(SOLUTIONS[0] + SOLUTIONS[1])
    types = [e.type for e in rec.events]
    assert types[0] == "game_start" and types[-1] == "game_end"
    assert [e.level for e in rec.of_type("level_complete")] == [1, 2]
    assert rec.of_type("round_end")[0].outcome == "won"
    assert [s for s, _ in rec.frame_log] == list(range(result.steps + 1))
    steps = rec.of_type("step")
    assert steps[0].call_ids == ["p-1", "s-1"]
    assert steps[-1].status == "success"
    assert result.cost_usd == 0.0 and result.in_tokens > 0


def test_session_game_over_resets() -> None:
    sess, rec = session(["A1", *SOLUTIONS[0], *SOLUTIONS[1]])
    result = sess.run()
    assert result.outcome is Outcome.WON and result.rounds == 2
    steps = rec.of_type("step")
    assert steps[0].status == "failed"
    reset = steps[1]
    assert reset.action.name == "RESET" and reset.round == 2 and reset.round_step == 1
    assert reset.call_ids == []
    ends = rec.of_type("round_end")
    assert ends[0].outcome == "failed" and ends[0].hypothesis == "wall kills"
    starts = rec.of_type("round_start")
    assert [s.reason for s in starts] == ["initial", "failed"]
    assert len(result.model.failed_rounds) == 1
    assert result.model.failed_rounds[0].round == 1
    types = [e.type for e in rec.events]
    assert types.index("round_end") < types.index("round_start", 2)


def test_action_budget() -> None:
    sess, rec = session(["A2", "A1"] * 10, Budget(max_actions=4, max_rounds=5))
    result = sess.run()
    assert result.outcome is Outcome.BUDGET and result.steps == 4
    assert rec.of_type("round_end")[-1].outcome == "budget"
    assert any(w.code == "repeat_state" for w in rec.of_type("warning"))


def test_round_budget() -> None:
    sess, rec = session(["A1"] * 5, Budget(max_actions=50, max_rounds=2))
    result = sess.run()
    assert result.outcome is Outcome.BUDGET and result.rounds == 2
    assert [e.outcome for e in rec.of_type("round_end")] == ["failed", "failed"]


def test_repeat_round_warning() -> None:
    start = ["A2", "A2", "A2", "A4", "A1"]  # A1 hits the wall
    sess, rec = session([*start, *start, "A2"], Budget(max_actions=12, max_rounds=5))
    sess.scorer.llm.inner.default = lambda req: scorer_reply(failed_rounds=[
        {"round": 1, "actions": start, "last_state": "x", "hypothesis": "h"}])
    sess.run()
    codes = [w.code for w in rec.of_type("warning")]
    assert "repeat_round" in codes


def test_bad_action_warning() -> None:
    sess, rec = session([], Budget(max_actions=1))
    sess.player.llm.inner.replies = [{"action": "ACTION5"}]
    sess.run()
    warning = rec.of_type("warning")[0]
    assert warning.code == "bad_action"
    assert "fallback_action" in rec.of_type("step")[0].flags


class BrokenEngine(ToyEngine):
    def step(self, action: Action) -> State:
        raise RuntimeError("engine down")


def test_exception_ends_game_with_error() -> None:
    sess, rec = session(["A2"], engine=BrokenEngine())
    result = sess.run()
    assert result.outcome is Outcome.ERROR
    error = rec.of_type("error")[0]
    assert error.where == "engine" and "engine down" in error.message
    assert rec.of_type("round_end")[0].outcome == "error"
    assert rec.events[-1].type == "game_end"


def test_stop_aborts() -> None:
    stop = threading.Event()
    stop.set()
    sess, rec = session(["A2"], stop=stop)
    assert sess.run().outcome is Outcome.ABORTED
    assert rec.of_type("round_end")[0].outcome == "aborted"


def test_noop_step_skips_scorer() -> None:
    engine = ToyEngine()
    sess, rec = session(["A6@0,5"], Budget(max_actions=1), engine=engine)
    sess.run()
    step = rec.of_type("step")[0]
    assert step.diff.noop and "scorer_skipped" in step.flags and step.call_ids == ["p-1"]


# Rebuild rounds from files only.


def rebuild_rounds(run_dir: Path, game: str) -> dict[int, list[dict[str, Any]]]:
    game_dir = run_dir / "games" / game
    events = list(read_jsonl(game_dir / "events.jsonl"))
    frames = {f["step"]: f for f in read_jsonl(game_dir / "frames.jsonl")}
    calls = {c["call_id"]: LLMRecord.model_validate(c) for c in read_jsonl(game_dir / "llm.jsonl")}
    models = {e["version"]: e["model"] for e in events if e["type"] == "model_update"}
    rounds: dict[int, list[dict[str, Any]]] = {}
    current: int | None = None
    for e in events:
        if e["type"] == "round_start":
            current = e["round"]
            rounds[current] = []
        elif e["type"] == "step":
            assert e["round"] == current
            rounds[current].append(e)
        elif e["type"] == "round_end":
            assert e["round"] == current
            current = None
    for steps in rounds.values():
        prev = frames[steps[0]["step"] - 1]
        for i, step in enumerate(steps, start=1):
            assert step["round_step"] == i
            cur = frames[step["step"]]
            old = Grid.from_hex(prev["frames"][-1], prev["w"], prev["h"])
            new = Grid.from_hex(cur["frames"][-1], cur["w"], cur["h"])
            assert grid_diff(old, new).summary() == step["diff"]
            assert step["model_version"] == 0 or step["model_version"] in models
            for call_id in step["call_ids"]:
                assert calls[call_id].step == step["step"]
            prev = cur
    return rounds


def test_fixture_rebuilds(tmp_path: Path) -> None:
    summary = make_fixture.build(tmp_path)
    assert summary.results[0].outcome is Outcome.WON
    rounds = rebuild_rounds(summary.run_dir, "toy")
    assert len(rounds) == 2
    assert rounds[2][0]["action"]["name"] == "RESET"
    schemas = all_schemas()
    validators = {k: jsonschema.Draft202012Validator(v) for k, v in schemas.items()}
    for name in ("events.jsonl", "frames.jsonl", "llm.jsonl"):
        for line in read_jsonl(summary.run_dir / "games" / "toy" / name):
            validators[name].validate(line)
    for line in read_jsonl(summary.run_dir / "run.jsonl"):
        validators["run.jsonl"].validate(line)
    events = [e["type"] for e in read_jsonl(summary.run_dir / "games" / "toy" / "events.jsonl")]
    assert {"level_complete", "warning", "model_update"} <= set(events)


@pytest.mark.skipif(not FIXTURE.exists(), reason="fixture not built")
def test_committed_fixture_rebuilds() -> None:
    assert len(rebuild_rounds(FIXTURE, "toy")) == 2
