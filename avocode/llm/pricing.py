"""Cost per million tokens, per model."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Price:
    input: float
    output: float
    cache_read: float
    cache_write: float


def _price(inp: float, out: float, cache_read: float | None = None) -> Price:
    return Price(inp, out, cache_read if cache_read is not None else inp / 10, inp * 1.25)


PRICES: dict[str, Price] = {
    "claude-fable-5-1": _price(10.0, 50.0, 0.25),
    "claude-opus-5-5": _price(4.0, 20.0, 0.20),
    "claude-opus-5": _price(5.0, 25.0),
    "claude-sonnet-5-5": _price(2.0, 10.0, 0.20),
    "claude-sonnet-5": _price(2.0, 10.0),
    "claude-haiku-5-5": _price(0.10, 0.50),
    "fake": Price(0.0, 0.0, 0.0, 0.0),
}


def cost_usd(model: str, in_tokens: int, out_tokens: int, cache_tokens: int = 0,
             cache_write: int = 0) -> float | None:
    """Cost of one call. None if unknown.

    in_tokens counts uncached input only.
    """
    price = PRICES.get(model)
    if price is None:
        return None
    total = (in_tokens * price.input + out_tokens * price.output
             + cache_tokens * price.cache_read + cache_write * price.cache_write)
    return round(total / 1_000_000, 6)
