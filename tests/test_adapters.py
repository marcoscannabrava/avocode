import json
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
from arcengine import FrameDataRaw, GameAction, GameState
from pydantic import BaseModel

from avocode.config import Settings
from avocode.core import Action
from avocode.engine.arc import ArcEngine, to_game_action, to_state
from avocode.engine.toy import ToyEngine
from avocode.llm.anthropic import AnthropicClient
from avocode.llm.fake import FakeLLM
from avocode.llm.openai import OpenAIClient
from avocode.llm.openrouter import OpenRouterClient
from avocode.ports import LLMRequest
from avocode.record.jsonl import read_jsonl
from bench.arcagi3 import prompt_hashes, steps_per_level, summary_table
from bench.games import filter_games
from bench.runner import Runner
from tests.make_fixture import scorer_reply


def raw(state: GameState = GameState.NOT_FINISHED, frames: int = 1) -> FrameDataRaw:
    data = FrameDataRaw(game_id="ls20-x", state=state, levels_completed=1, win_levels=3,
                        available_actions=[1, 2, 6], full_reset=True)
    data.frame = [np.array([[0, 1], [2, 15]]) for _ in range(frames)]
    return data


def test_to_state() -> None:
    state = to_state(raw(frames=2))
    assert state.game_state == "NOT_FINISHED" and state.levels_completed == 1
    assert state.available_actions == ("ACTION1", "ACTION2", "ACTION6")
    assert len(state.frames) == 2 and state.grid.at(1, 1) == 15 and state.full_reset


def test_to_game_action() -> None:
    action, data = to_game_action(Action("ACTION6", 3, 4))
    assert action is GameAction.ACTION6 and data == {"x": 3, "y": 4}
    assert to_game_action(Action("RESET")) == (GameAction.RESET, {})


class FakeEnv:
    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []

    def reset(self) -> FrameDataRaw:
        return raw()

    def step(self, action: GameAction, data: dict[str, Any], reasoning: dict[str, Any]) -> Any:
        self.calls.append((action, data, reasoning))
        out = raw(GameState.GAME_OVER)
        out.frame = []  # some steps have no frames
        return out


def test_arc_engine_keeps_last_grid() -> None:
    env = FakeEnv()
    engine = ArcEngine("ls20-x", env)
    first = engine.reset()
    after = engine.step(Action("ACTION6", 1, 1, reason="click"))
    assert after.game_state == "GAME_OVER" and after.grid == first.grid
    assert env.calls[0] == (GameAction.ACTION6, {"x": 1, "y": 1}, {"reason": "click"})


class Pick(BaseModel):
    action: str


def request(model: str) -> LLMRequest:
    return LLMRequest(role="player", system="sys", user="usr", schema=Pick, model=model)


class FakeMessages:
    def __init__(self) -> None:
        self.params: dict[str, Any] = {}

    def create(self, **params: Any) -> Any:
        self.params = params
        usage = SimpleNamespace(input_tokens=10, output_tokens=5, cache_read_input_tokens=100,
                                cache_creation_input_tokens=0)
        content = [SimpleNamespace(type="thinking", thinking=""),
                   SimpleNamespace(type="text", text='{"action": "A1"}')]
        return SimpleNamespace(content=content, usage=usage)


def test_anthropic_client() -> None:
    messages, beta = FakeMessages(), FakeMessages()
    sdk = SimpleNamespace(messages=messages, beta=SimpleNamespace(messages=beta))
    client = AnthropicClient(sdk)
    reply = client.complete(request("claude-opus-5-5"))
    assert reply.parsed == {"action": "A1"} and reply.cache_tokens == 100
    assert beta.params["fallbacks"] == "default"
    assert beta.params["system"][0]["cache_control"] == {"type": "ephemeral"}
    client.complete(request("claude-haiku-5-5"))
    assert messages.params["model"] == "claude-haiku-5-5" and "fallbacks" not in messages.params


def test_openai_client() -> None:
    sent: dict[str, Any] = {}

    def create(**params: Any) -> Any:
        sent.clear()
        sent.update(params)
        usage = SimpleNamespace(prompt_tokens=50, completion_tokens=7,
                                prompt_tokens_details=SimpleNamespace(cached_tokens=20))
        msg = SimpleNamespace(content='{"action": "A2"}')
        return SimpleNamespace(choices=[SimpleNamespace(message=msg)], usage=usage)

    sdk = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    reply = OpenAIClient(sdk).complete(request("gpt-x"))
    assert reply.parsed == {"action": "A2"} and reply.in_tokens == 30 and reply.cache_tokens == 20
    assert "reasoning_effort" not in sent
    OpenAIClient(sdk, effort="low").complete(request("gpt-x"))
    assert sent["reasoning_effort"] == "low"



def test_openrouter_client() -> None:
    sent: dict[str, Any] = {}
    replies = iter(["not json", '{"action": "A2"}'])

    def create(**params: Any) -> Any:
        sent.clear()
        sent.update(params)
        usage = SimpleNamespace(prompt_tokens=50, completion_tokens=7, cost=0.0015,
                                prompt_tokens_details=SimpleNamespace(cached_tokens=20))
        msg = SimpleNamespace(content=next(replies))
        return SimpleNamespace(choices=[SimpleNamespace(message=msg)], usage=usage)

    sdk = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    reply = OpenRouterClient(sdk, effort="low").complete(request("anthropic/x"))
    assert reply.parsed == {"action": "A2"} and reply.provider == "openrouter"
    assert reply.retries == 1 and reply.cost_usd == 0.003
    assert sent["extra_body"] == {"reasoning": {"effort": "low"}}
    assert "reasoning_effort" not in sent

def test_settings_env_then_cli() -> None:
    env = {"AVOCODE_MAX_ACTIONS": "50", "AVOCODE_SKIP_NOOP_SCORER": "false",
           "AVOCODE_LLM": "anthropic"}
    s = Settings.load(env=env, max_rounds=3, workers=None)
    assert (s.max_actions, s.max_rounds, s.workers, s.skip_noop_scorer) == (50, 3, 1, False)
    assert s.player_model == "claude-sonnet-5-5" and s.scorer_model == "claude-opus-5-5"
    assert Settings.load(env=env, max_actions=7).max_actions == 7


def test_settings_openai_defaults() -> None:
    s = Settings.load(env={"AVOCODE_LLM": "openai", "AVOCODE_SCORER_EFFORT": "high"})
    assert (s.player_model, s.scorer_model) == ("gpt-6-luna", "gpt-6.1-sol")
    assert (s.player_effort, s.scorer_effort) == ("low", "high")
    assert Settings.load(env={}).player_effort == ""


def test_filter_games() -> None:
    games = ["ls20-016295f7601e", "ft09-1", "vc33-2"]
    assert filter_games(games, "ls20,ft") == ["ls20-016295f7601e", "ft09-1"]
    assert filter_games(games, None) == games


def test_runner_abort_and_summary(tmp_path: Path) -> None:
    stop = threading.Event()
    settings = Settings.load(env={}, llm="fake", runs_dir=str(tmp_path), workers=2)
    calls = {"n": 0}

    def player(req: LLMRequest) -> dict[str, Any]:
        calls["n"] += 1
        if calls["n"] == 3:
            stop.set()  # like Ctrl+C
        return {"action": "ACTION2"}

    runner = Runner(settings, ToyEngine, lambda role: FakeLLM(
        default=player if role == "player" else scorer_reply), run_id="r1", stop=stop, git={})
    summary = runner.run(["a", "b"])
    assert summary.outcome == "aborted"
    assert {r.outcome.value for r in summary.results} == {"aborted"}
    run = list(read_jsonl(tmp_path / "r1" / "run.jsonl"))
    assert run[-1]["type"] == "run_end" and run[-1]["outcome"] == "aborted"
    for game in ("a", "b"):
        events = list(read_jsonl(tmp_path / "r1" / "games" / game / "events.jsonl"))
        assert events[-1]["type"] == "game_end"
    table = summary_table(summary)
    assert "total" in table and "aborted" in table


def test_list_columns(tmp_path: Path) -> None:
    game = tmp_path / "games" / "g1"
    game.mkdir(parents=True)
    lines = [{"type": "level_complete", "steps_in_level": n} for n in (20, 40)]
    (game / "events.jsonl").write_text("".join(json.dumps(x) + "\n" for x in lines))
    assert steps_per_level(tmp_path) == "30"
    assert steps_per_level(tmp_path / "none") == "-"
    assert prompt_hashes({"prompts": {"player": "abcdef123", "scorer": "987654"}}) == \
        "abcdef/987654"
