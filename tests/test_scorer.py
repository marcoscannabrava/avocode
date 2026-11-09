from avocode.core import Action, FailedRound, GameModel, Status
from avocode.llm.fake import FakeLLM
from avocode.scorer import prompts
from avocode.scorer.scorer import NOOP_NOTE, ScoreInput, Scorer
from avocode.scorer.status import status_from_state
from tests.helpers import scorer_reply, state


def test_status_rules() -> None:
    assert status_from_state(state(game_state="WIN")) is Status.SUCCESS
    assert status_from_state(state(game_state="GAME_OVER")) is Status.FAILED
    assert status_from_state(state(game_state="NOT_FINISHED")) is Status.ONGOING
    assert status_from_state(state(game_state="NOT_PLAYED")) is Status.ONGOING


def test_first_model_from_none() -> None:
    llm = FakeLLM([scorer_reply()])
    result = Scorer(llm).score(ScoreInput(None, state(), GameModel()))
    assert result.model.version == 1
    assert result.model.element_breakdown == {"6": "player"}
    assert result.summary == "first look"
    assert "first State" in llm.users[0]
    assert llm.requests[0].prompt_hash == prompts.PROMPT_HASH


def test_success_keeps_model_no_llm() -> None:
    llm = FakeLLM()
    old = GameModel(version=3, prompt="x")
    result = Scorer(llm).score(ScoreInput(state(), state(game_state="WIN"), old, Action("ACTION1")))
    assert result.status is Status.SUCCESS and result.model is old and not llm.requests


def test_noop_skips_llm() -> None:
    llm = FakeLLM()
    old = GameModel(version=2)
    s = state()
    result = Scorer(llm).score(ScoreInput(s, s, old, Action("ACTION2")))
    assert not llm.requests
    assert result.model.allowable_actions == {"ACTION2": NOOP_NOTE}
    assert result.model.version == 3 and "scorer_skipped" in result.flags
    again = Scorer(llm).score(ScoreInput(s, s, result.model, Action("ACTION2")))
    assert not again.changed and again.model.version == 3


def test_noop_marks_known_action() -> None:
    old = GameModel(allowable_actions={"ACTION1": "moves up"})
    s = state()
    result = Scorer(FakeLLM()).score(ScoreInput(s, s, old, Action("ACTION1")))
    assert "also seen as no-op" in result.model.allowable_actions["ACTION1"]


def test_noop_skip_off_calls_llm() -> None:
    llm = FakeLLM([scorer_reply()])
    s = state()
    Scorer(llm, skip_noop=False).score(ScoreInput(s, s, GameModel(), Action("ACTION1")))
    assert len(llm.requests) == 1


def test_unchanged_reply_keeps_version() -> None:
    old = GameModel(**{k: v for k, v in scorer_reply().items() if k != "summary"}, version=4)
    llm = FakeLLM([scorer_reply()])
    result = Scorer(llm).score(ScoreInput(state(), state("600\n000\n000"), old, Action("ACTION1")))
    assert result.model.version == 4 and not result.changed


def test_failed_adds_failed_round() -> None:
    llm = FakeLLM([scorer_reply()])  # reply without failed round
    inp = ScoreInput(state(), state("000\n000\n000", game_state="GAME_OVER"), GameModel(),
                     Action("ACTION1"), [Action("ACTION1"), Action("ACTION1")], round=2)
    result = Scorer(llm).score(inp)
    assert result.status is Status.FAILED
    assert len(result.model.failed_rounds) == 1
    assert result.model.failed_rounds[0].round == 2
    assert result.model.failed_rounds[0].actions == ["A1", "A1"]
    assert "FAILED" in llm.users[0]


def test_failed_uses_llm_hypothesis() -> None:
    fr = {"round": 1, "actions": ["A1"], "last_state": "dead", "hypothesis": "hit the wall"}
    llm = FakeLLM([scorer_reply(failed_rounds=[fr])])
    inp = ScoreInput(state(), state(game_state="GAME_OVER"), GameModel(), Action("ACTION1"),
                     [Action("ACTION1")], round=1)
    result = Scorer(llm).score(inp)
    assert len(result.model.failed_rounds) == 1
    assert result.hypothesis == "hit the wall"


def test_llm_fails_twice_keeps_model() -> None:
    old = GameModel(version=5, prompt="old idea")
    llm = FakeLLM(["bad", "worse"])
    result = Scorer(llm).score(ScoreInput(state(), state("600\n000\n000"), old, Action("ACTION1")))
    assert result.model.prompt == "old idea" and result.model.version == 5
    assert result.warnings[0][0] == "model_kept"
    assert "json_retry" in result.flags


def test_llm_fails_on_failed_still_adds_round() -> None:
    old = GameModel(version=5)
    llm = FakeLLM(["bad", "worse"])
    inp = ScoreInput(state(), state(game_state="GAME_OVER"), old, Action("ACTION1"), round=3)
    result = Scorer(llm).score(inp)
    assert result.model.failed_rounds[-1].round == 3 and result.model.version == 6


def test_failed_rounds_capped() -> None:
    many = [FailedRound(round=i).model_dump() for i in range(12)]
    llm = FakeLLM([scorer_reply(failed_rounds=many)])
    result = Scorer(llm).score(ScoreInput(state(), state("600\n000\n000"), GameModel(),
                                          Action("ACTION1")))
    assert len(result.model.failed_rounds) == 10
    assert result.model.failed_rounds[0].round == 2


def test_prompt_has_object_changes() -> None:
    llm = FakeLLM(default=scorer_reply())
    Scorer(llm).score(ScoreInput(state(), state("000\n006\n000"), GameModel(), Action("ACTION4")))
    user = llm.users[0]
    assert "Changes from the previous State" in user
    assert "sprite 6 moved (+1,+0) to x=2..2 y=1..1" in user
    assert "Previous State" not in user
