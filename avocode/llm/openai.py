"""OpenAI client."""

from __future__ import annotations

from typing import Any

import openai

from avocode.llm.base import JsonClient, RawReply
from avocode.ports import LLMRequest


class OpenAIClient(JsonClient):
    provider = "openai"

    def __init__(self, client: Any = None, effort: str = "") -> None:
        self.client = client or openai.OpenAI()
        self.effort = effort

    def call(self, req: LLMRequest, user: str) -> RawReply:
        response = self.client.chat.completions.create(
            model=req.model,
            messages=[{"role": "system", "content": req.system},
                      {"role": "user", "content": user}],
            response_format={"type": "json_object"},
            **self._effort_params(),
        )
        text = response.choices[0].message.content or ""
        usage = response.usage
        cached = 0
        details = getattr(usage, "prompt_tokens_details", None)
        if details is not None:
            cached = getattr(details, "cached_tokens", 0) or 0
        prompt = usage.prompt_tokens if usage else 0
        return RawReply(text=text, in_tokens=prompt - cached,
                        out_tokens=usage.completion_tokens if usage else 0,
                        cache_tokens=cached, cost_usd=self._cost(usage))

    def _effort_params(self) -> dict[str, Any]:
        return {"reasoning_effort": self.effort} if self.effort else {}

    def _cost(self, usage: Any) -> float | None:
        return None
