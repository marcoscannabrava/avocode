from avocode.core import Action, FailedRound, GameModel
from avocode.llm.fake import FakeLLM
from avocode.player import prompts
from avocode.player.player import Player, fallback_action
from tests.helpers import state


def test_player_picks_action() -> None:
    llm = FakeLLM([{"action": "ACTION2", "reason": "go down"}])
    choice = Player(llm).choose(GameModel(), state())
    assert choice.action == Action("ACTION2", reason="go down")
    assert not choice.warnings and not choice.flags
    assert llm.requests[0].prompt_hash == prompts.PROMPT_HASH


def test_player_click() -> None:
    llm = FakeLLM([{"action": "ACTION6", "x": 1, "y": 2, "reason": "click"}])
    assert Player(llm).choose(GameModel(), state()).action.short == "A6@1,2"
    llm = FakeLLM([{"action": "A6@0,1"}])
    assert Player(llm).choose(GameModel(), state()).action.short == "A6@0,1"


def test_player_not_available_falls_back() -> None:
    llm = FakeLLM([{"action": "ACTION5"}])
    choice = Player(llm).choose(GameModel(), state())
    assert choice.action.name == "ACTION1"
    assert "fallback_action" in choice.flags
    assert choice.warnings[0][0] == "bad_action"


def test_player_click_without_point_falls_back() -> None:
    llm = FakeLLM([{"action": "ACTION6"}])
    choice = Player(llm).choose(GameModel(), state())
    assert choice.warnings[0][0] == "bad_action"


def test_player_bad_json_twice_falls_back() -> None:
    llm = FakeLLM(["?", "??"])
    choice = Player(llm).choose(GameModel(), state())
    assert "json_retry" in choice.flags and "fallback_action" in choice.flags


def test_prompt_shows_failed_rounds_and_questions() -> None:
    model = GameModel(
        failed_rounds=[FailedRound(round=1, actions=["A1", "A1"], hypothesis="wall above")],
        open_questions=["does A6 open the door?"],
    )
    llm = FakeLLM([{"action": "ACTION1"}])
    Player(llm).choose(model, state(), [Action("ACTION2")], round_=2, notes=["repeat state"])
    user = llm.users[0]
    assert "round 1: actions A1 A1; why: wall above" in user
    assert "does A6 open the door?" in user
    assert "Note: repeat state" in user
    assert "Do not repeat an action sequence" in llm.requests[0].system


def test_fallback_click_only() -> None:
    s = state("000\n060\n000", actions=("ACTION6",))
    assert fallback_action(s, 0) == Action("ACTION6", 1, 1, reason="fallback")
