"""Settings from env vars and CLI options."""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass, field, fields
from typing import Any

DEFAULT_MODELS = {
    "anthropic": ("claude-sonnet-5-5", "claude-opus-5-5"),
    "openai": ("gpt-6-luna", "gpt-6.1-sol"),
    "fake": ("fake", "fake"),
}

# Reasoning effort: (player, scorer)
DEFAULT_EFFORTS = {
    "openai": ("low", "medium"),
}

ENV = {
    "llm": "AVOCODE_LLM",
    "player_model": "AVOCODE_PLAYER_MODEL",
    "scorer_model": "AVOCODE_SCORER_MODEL",
    "player_effort": "AVOCODE_PLAYER_EFFORT",
    "scorer_effort": "AVOCODE_SCORER_EFFORT",
    "max_actions": "AVOCODE_MAX_ACTIONS",
    "max_rounds": "AVOCODE_MAX_ROUNDS",
    "workers": "AVOCODE_WORKERS",
    "runs_dir": "AVOCODE_RUNS_DIR",
    "skip_noop_scorer": "AVOCODE_SKIP_NOOP_SCORER",
}


@dataclass
class Settings:
    llm: str = "anthropic"
    player_model: str = ""
    scorer_model: str = ""
    player_effort: str = ""
    scorer_effort: str = ""
    max_actions: int = 400
    max_rounds: int = 20
    workers: int = 1
    runs_dir: str = "runs"
    skip_noop_scorer: bool = True
    tags: list[str] = field(default_factory=list)

    @classmethod
    def load(cls, env: dict[str, str] | None = None, **overrides: Any) -> Settings:
        """Env vars first, then CLI options."""
        env = dict(os.environ) if env is None else env
        values: dict[str, Any] = {}
        for f in fields(cls):
            raw = env.get(ENV.get(f.name, ""), "")
            if raw:
                values[f.name] = _convert(raw, f.type)
        values.update({k: v for k, v in overrides.items() if v is not None})
        settings = cls(**values)
        player, scorer = DEFAULT_MODELS.get(settings.llm, ("", ""))
        settings.player_model = settings.player_model or player
        settings.scorer_model = settings.scorer_model or scorer
        player, scorer = DEFAULT_EFFORTS.get(settings.llm, ("", ""))
        settings.player_effort = settings.player_effort or player
        settings.scorer_effort = settings.scorer_effort or scorer
        return settings

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _convert(raw: str, kind: object) -> Any:
    if kind in (int, "int"):
        return int(raw)
    if kind in (bool, "bool"):
        return raw.strip().lower() in ("1", "true", "yes", "on")
    return raw
