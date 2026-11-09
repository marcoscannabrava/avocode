"""OpenRouter client, OpenAI-compatible API."""

from __future__ import annotations

import os
from typing import Any

import openai

from avocode.llm.openai import OpenAIClient

BASE_URL = "https://openrouter.ai/api/v1"


class OpenRouterClient(OpenAIClient):
    provider = "openrouter"

    def __init__(self, client: Any = None, effort: str = "") -> None:
        client = client or openai.OpenAI(
            base_url=BASE_URL, api_key=os.environ.get("OPENROUTER_API_KEY"))
        super().__init__(client, effort)

    def _effort_params(self) -> dict[str, Any]:
        if not self.effort:
            return {}
        return {"extra_body": {"reasoning": {"effort": self.effort}}}

    def _cost(self, usage: Any) -> float | None:
        cost = getattr(usage, "cost", None)
        return float(cost) if cost is not None else None
