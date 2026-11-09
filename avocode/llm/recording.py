"""LLM wrapper that records each call."""

from __future__ import annotations

import time

from avocode.core.events import LLMEnd, LLMRecord, LLMStart
from avocode.llm.pricing import cost_usd
from avocode.ports import LLMClient, LLMReply, LLMRequest, RunObserver, StepContext


class RecordingLLM:
    """Emit llm_start, llm_end, and the llm.jsonl line."""

    def __init__(self, inner: LLMClient, observer: RunObserver, ctx: StepContext) -> None:
        self.inner = inner
        self.observer = observer
        self.ctx = ctx

    def complete(self, req: LLMRequest) -> LLMReply:
        ctx = self.ctx
        call_id = self._call_id(req.role)
        ctx.call_ids.append(call_id)
        self.observer.emit(LLMStart(call_id=call_id, role=req.role, round=ctx.round,
                                    step=ctx.step))
        start = time.monotonic()
        try:
            reply = self.inner.complete(req)
        except Exception as exc:
            reply = LLMReply(text="", parsed=None, ok=False, error=f"{type(exc).__name__}: {exc}")
            self._record(req, call_id, reply, start)
            raise
        self._record(req, call_id, reply, start)
        return reply

    def _call_id(self, role: str) -> str:
        base = f"{role[0]}-{self.ctx.step}"
        call_id, n = base, 1
        while call_id in self.ctx.call_ids:
            n += 1
            call_id = f"{base}.{n}"
        return call_id

    def _record(self, req: LLMRequest, call_id: str, reply: LLMReply, start: float) -> None:
        latency = int((time.monotonic() - start) * 1000)
        model = reply.model or req.model
        cost = cost_usd(model, reply.in_tokens, reply.out_tokens, reply.cache_tokens,
                        reply.cache_write_tokens)
        self.ctx.add_usage(reply.in_tokens + reply.cache_tokens + reply.cache_write_tokens,
                           reply.out_tokens, cost)
        self.observer.llm_call(LLMRecord(
            call_id=call_id, role=req.role, step=self.ctx.step, round=self.ctx.round,
            provider=reply.provider, model=model, prompt_hash=req.prompt_hash,
            system=req.system, user=req.user, reply=reply.text, parsed=reply.parsed,
            ok=reply.ok, retries=reply.retries, error=reply.error,
            in_tokens=reply.in_tokens, out_tokens=reply.out_tokens,
            cache_tokens=reply.cache_tokens, latency_ms=latency, cost_usd=cost,
        ))
        self.observer.emit(LLMEnd(
            call_id=call_id, role=req.role, ok=reply.ok, retries=reply.retries,
            in_tokens=reply.in_tokens, out_tokens=reply.out_tokens,
            cache_tokens=reply.cache_tokens, latency_ms=latency, cost_usd=cost,
            error=reply.error,
        ))
