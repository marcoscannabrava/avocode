#!/usr/bin/env python3
"""Replay saved prompts on OpenRouter; time each part."""

from __future__ import annotations

import argparse
import json
import os
import time
import urllib.request
from pathlib import Path

URL = "https://openrouter.ai/api/v1/chat/completions"

# Reasoning settings to compare, per role
CONFIGS = {
    "player": {
        "unset": None,
        "effort=low": {"effort": "low"},
        "disabled": {"enabled": False},
    },
    "scorer": {
        "unset": None,
        "effort=medium": {"effort": "medium"},
        "effort=low": {"effort": "low"},
    },
}


def load_env(path: Path) -> None:
    """Read KEY=VALUE lines into os.environ."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"'))


def pick_records(llm_jsonl: Path, role: str, ids: list[str]) -> list[dict]:
    rows = [json.loads(line) for line in llm_jsonl.open()]
    return [r for r in rows if r["role"] == role and r["call_id"] in ids]


def stream_call(model: str, system: str, user: str, reasoning: dict | None) -> dict:
    """Send one call. Return timing and usage."""
    body: dict = {
        "model": model,
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": user}],
        "response_format": {"type": "json_object"},
        "stream": True,
        "usage": {"include": True},
    }
    if reasoning is not None:
        body["reasoning"] = reasoning
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={
        "Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}",
        "Content-Type": "application/json",
    })
    t0 = time.monotonic()
    first_any = first_content = None
    provider, usage, gen_id, text = "", {}, "", []
    with urllib.request.urlopen(req, timeout=900) as resp:
        for raw in resp:
            line = raw.decode().strip()
            if not line.startswith("data: ") or line == "data: [DONE]":
                continue
            chunk = json.loads(line[6:])
            gen_id = chunk.get("id", gen_id)
            provider = chunk.get("provider", provider)
            usage = chunk.get("usage") or usage
            for choice in chunk.get("choices", []):
                delta = choice.get("delta", {})
                now = time.monotonic() - t0
                if (delta.get("reasoning") or delta.get("content")) and first_any is None:
                    first_any = now
                if delta.get("content"):
                    first_content = first_content or now
                    text.append(delta["content"])
    total = time.monotonic() - t0
    details = usage.get("completion_tokens_details") or {}
    return {
        "gen_id": gen_id, "provider": provider, "total_s": round(total, 2),
        "ttft_s": round(first_any or total, 2),
        "first_content_s": round(first_content or total, 2),
        "out_tokens": usage.get("completion_tokens", 0),
        "reasoning_tokens": details.get("reasoning_tokens", 0),
        "in_tokens": usage.get("prompt_tokens", 0),
        "cost_usd": usage.get("cost"), "reply_chars": len("".join(text)),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("llm_jsonl", type=Path)
    ap.add_argument("--player", default="p-10,p-60,p-120")
    ap.add_argument("--scorer", default="s-10,s-60")
    ap.add_argument("--out", type=Path, default=Path("scratch/latency/probe.jsonl"))
    ap.add_argument("--append", action="store_true")
    args = ap.parse_args()
    load_env(Path(".env"))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("a" if args.append else "w") as out:
        for role, ids in (("player", args.player), ("scorer", args.scorer)):
            if not ids:
                continue
            for rec in pick_records(args.llm_jsonl, role, ids.split(",")):
                for name, reasoning in CONFIGS[role].items():
                    try:
                        res = stream_call(rec["model"], rec["system"], rec["user"], reasoning)
                    except Exception as exc:  # noqa: BLE001 - keep probing
                        res = {"error": f"{type(exc).__name__}: {exc}"}
                    row = {"role": role, "call_id": rec["call_id"], "model": rec["model"],
                           "config": name, **res}
                    print(json.dumps(row), flush=True)
                    out.write(json.dumps(row) + "\n")


if __name__ == "__main__":
    main()
