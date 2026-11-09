"""Anthropic client."""

from __future__ import annotations

from typing import Any

import anthropic

from avocode.llm.base import JsonClient, RawReply
from avocode.ports import LLMRequest

FALLBACK_MODELS = ("claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1")


class AnthropicClient(JsonClient):
    provider = "anthropic"

    def __init__(self, client: Any = None, max_tokens: int = 16000,
                 effort: str | None = None) -> None:
        self.client = client or anthropic.Anthropic()
        self.max_tokens = max_tokens
        self.effort = effort

    def call(self, req: LLMRequest, user: str) -> RawReply:
        params: dict[str, Any] = {
            "model": req.model,
            "max_tokens": self.max_tokens,
            "system": [{"type": "text", "text": req.system,
                        "cache_control": {"type": "ephemeral"}}],
            "messages": [{"role": "user", "content": user}],
        }
        if self.effort:
            params["output_config"] = {"effort": self.effort}
        if req.model in FALLBACK_MODELS:
            response = self.client.beta.messages.create(
                betas=["server-side-fallback-2026-07-01"], fallbacks="default", **params)
        else:
            response = self.client.messages.create(**params)
        text = "".join(b.text for b in response.content if b.type == "text")
        usage = response.usage
        return RawReply(
            text=text,
            in_tokens=usage.input_tokens or 0,
            out_tokens=usage.output_tokens or 0,
            cache_tokens=getattr(usage, "cache_read_input_tokens", 0) or 0,
            cache_write_tokens=getattr(usage, "cache_creation_input_tokens", 0) or 0,
        )
