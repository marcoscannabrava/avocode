import pytest
from pydantic import BaseModel

from avocode.core import Action
from avocode.engine.toy import SOLUTIONS, ToyEngine
from avocode.llm.fake import FakeLLM
from avocode.ports import LLMRequest
from avocode.record.memory import MemoryRecorder


def play(engine: ToyEngine, moves: list[str]):  # type: ignore[no-untyped-def]
    state = engine.reset()
    for move in moves:
        state = engine.step(Action.parse(move))
    return state


def test_toy_wins() -> None:
    engine = ToyEngine()
    first = engine.reset()
    assert first.game_state == "NOT_FINISHED" and first.full_reset
    state = play(engine, SOLUTIONS[0])
    assert state.levels_completed == 1 and state.game_state == "NOT_FINISHED"
    for move in SOLUTIONS[1]:
        state = engine.step(Action.parse(move))
    assert state.game_state == "WIN" and state.levels_completed == 2


def test_toy_wall_game_over_and_reset() -> None:
    engine = ToyEngine()
    state = play(engine, ["A1"])
    assert state.game_state == "GAME_OVER"
    assert engine.step(Action.parse("A2")).game_state == "GAME_OVER"
    state = engine.step(Action.parse("RESET"))
    assert state.game_state == "NOT_FINISHED" and not state.full_reset


def test_toy_reset_keeps_level() -> None:
    engine = ToyEngine()
    play(engine, SOLUTIONS[0])
    engine.step(Action.parse("A1"))  # wall
    state = engine.step(Action.parse("RESET"))
    assert state.levels_completed == 1


def test_toy_door_blocks_until_click() -> None:
    engine = ToyEngine()
    play(engine, SOLUTIONS[0])
    before = engine.step(Action.parse("A4"))
    for move in ["A4", "A4", "A2"]:
        before = engine.step(Action.parse(move))
    assert engine.step(Action.parse("A2")).grid == before.grid  # door
    after = engine.step(Action.parse("A6@2,4"))
    assert 2 not in after.grid.cells


class Pick(BaseModel):
    action: str


def request() -> LLMRequest:
    return LLMRequest(role="player", system="sys", user="go", schema=Pick)


def test_fake_llm_in_order() -> None:
    llm = FakeLLM([{"action": "A1"}, '```json\n{"action": "A2"}\n```'])
    assert llm.complete(request()).parsed == {"action": "A1"}
    assert llm.complete(request()).parsed == {"action": "A2"}
    assert len(llm.requests) == 2
    with pytest.raises(RuntimeError):
        llm.complete(request())


def test_fake_llm_retry_once() -> None:
    llm = FakeLLM(["not json", {"action": "A3"}])
    reply = llm.complete(request())
    assert reply.ok and reply.retries == 1 and reply.parsed == {"action": "A3"}
    assert "not valid JSON" in llm.users[1]


def test_fake_llm_fails_twice() -> None:
    llm = FakeLLM(["nope", {"wrong": 1}])
    reply = llm.complete(request())
    assert not reply.ok and reply.parsed is None and reply.error


def test_memory_recorder() -> None:
    from avocode.core.events import WarningEvent

    rec = MemoryRecorder()
    rec.emit(WarningEvent(code="bad_json", message="x"))
    assert rec.of_type("warning")[0].code == "bad_json"
