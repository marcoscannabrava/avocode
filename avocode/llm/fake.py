"""Scripted LLM for tests."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from avocode.llm.base import JsonClient, RawReply
from avocode.ports import LLMRequest

Script = str | dict[str, Any] | Callable[[LLMRequest], "str | dict[str, Any]"]


class FakeLLM(JsonClient):
    """Returns scripted replies in order."""

    provider = "fake"

    def __init__(self, replies: list[Script] | None = None,
                 default: Script | None = None) -> None:
        self.replies = list(replies or [])
        self.default = default
        self.requests: list[LLMRequest] = []
        self.users: list[str] = []

    def call(self, req: LLMRequest, user: str) -> RawReply:
        self.requests.append(req)
        self.users.append(user)
        if self.replies:
            script = self.replies.pop(0)
        elif self.default is not None:
            script = self.default
        else:
            raise RuntimeError("FakeLLM has no more replies")
        if callable(script):
            script = script(req)
        text = script if isinstance(script, str) else json.dumps(script)
        return RawReply(text, in_tokens=len(req.system + user) // 4, out_tokens=len(text) // 4)
