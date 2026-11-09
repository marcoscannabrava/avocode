"""Pick games by id prefix."""

from __future__ import annotations


def filter_games(games: list[str], spec: str | None) -> list[str]:
    """Keep games that start with a prefix."""
    if not spec or spec == "all":
        return list(games)
    prefixes = [p.strip() for p in spec.split(",") if p.strip()]
    return [g for g in games if any(g.startswith(p) for p in prefixes)]
