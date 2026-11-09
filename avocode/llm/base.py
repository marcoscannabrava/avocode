"""JSON parse and one retry for all providers."""

from __future__ import annotations

import json
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError

from avocode.ports import LLMReply, LLMRequest

RETRY_NOTE = (
    "\n\nYour last reply was not valid JSON for the schema. "
    "Error: {error}\nReply with one JSON object only."
)


@dataclass
class RawReply:
    text: str
    in_tokens: int = 0
    out_tokens: int = 0
    cache_tokens: int = 0
    cache_write_tokens: int = 0
    cost_usd: float | None = None  # cost the provider reports


class JsonClient(ABC):
    """Base for provider clients."""

    provider = "base"
    max_retries = 1

    @abstractmethod
    def call(self, req: LLMRequest, user: str) -> RawReply:
        """Send one request. Return the raw text."""

    def complete(self, req: LLMRequest) -> LLMReply:
        user = req.user
        totals = [0, 0, 0, 0]
        cost: float | None = 0.0
        error: str | None = None
        text = ""
        for attempt in range(self.max_retries + 1):
            raw = self.call(req, user)
            text = raw.text
            usage = (raw.in_tokens, raw.out_tokens, raw.cache_tokens, raw.cache_write_tokens)
            totals = [a + b for a, b in zip(totals, usage, strict=True)]
            cost = None if cost is None or raw.cost_usd is None else cost + raw.cost_usd
            try:
                parsed = parse_json(text, req)
            except ValueError as exc:
                error = str(exc)
                user = req.user + RETRY_NOTE.format(error=error[:500])
                continue
            return self._reply(req, text, parsed, attempt, None, totals, cost)
        return self._reply(req, text, None, self.max_retries, error, totals, cost)

    def _reply(
        self, req: LLMRequest, text: str, parsed: dict[str, Any] | None, retries: int,
        error: str | None, totals: list[int], cost: float | None,
    ) -> LLMReply:
        return LLMReply(
            text=text, parsed=parsed, ok=parsed is not None, retries=retries, error=error,
            in_tokens=totals[0], out_tokens=totals[1], cache_tokens=totals[2],
            cache_write_tokens=totals[3], cost_usd=cost,
            provider=self.provider, model=req.model,
        )


def parse_json(text: str, req: LLMRequest) -> dict[str, Any]:
    """Find a JSON object and check it."""
    data = _first_object(text)
    try:
        model = req.schema.model_validate(data)
    except ValidationError as exc:
        raise ValueError(str(exc)) from exc
    return model.model_dump(mode="json")


def _first_object(text: str) -> Any:
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if fence:
        text = fence.group(1)
    start = text.find("{")
    if start < 0:
        raise ValueError("no JSON object in reply")
    try:
        data, _ = json.JSONDecoder().raw_decode(text[start:])
    except json.JSONDecodeError as exc:
        raise ValueError(f"bad JSON: {exc}") from exc
    return data
