"""GameModel and FailedRound."""

from __future__ import annotations

from pydantic import BaseModel, Field

MAX_FAILED_ROUNDS = 10


class FailedRound(BaseModel):
    round: int
    actions: list[str] = Field(default_factory=list)  # short form
    last_state: str = ""
    hypothesis: str = ""


class GameModel(BaseModel):
    version: int = 0
    element_breakdown: dict[str, str] = Field(default_factory=dict)
    allowable_actions: dict[str, str] = Field(default_factory=dict)
    prompt: str = ""
    level_notes: list[str] = Field(default_factory=list)
    failed_rounds: list[FailedRound] = Field(default_factory=list)
    open_questions: list[str] = Field(default_factory=list)

    def content(self) -> dict[str, object]:
        """All fields but version."""
        return self.model_dump(exclude={"version"})

    def changes_from(self, old: GameModel) -> list[str]:
        """Changed field paths, sorted."""
        return _diff_paths(old.content(), self.content(), "")


def _diff_paths(old: object, new: object, prefix: str) -> list[str]:
    if isinstance(old, dict) and isinstance(new, dict):
        out: list[str] = []
        for key in sorted(set(old) | set(new), key=str):
            path = f"{prefix}.{key}" if prefix else str(key)
            if key not in old or key not in new:
                out.append(path)
            else:
                out.extend(_diff_paths(old[key], new[key], path))
        return out
    return [] if old == new else [prefix]
