"""Action and its short form."""

from __future__ import annotations

import re
from dataclasses import dataclass

NAMES = ("RESET", "ACTION1", "ACTION2", "ACTION3", "ACTION4", "ACTION5", "ACTION6", "ACTION7")
_SHORT = re.compile(r"^(?:A([1-7])(?:@(\d+),(\d+))?|RESET)$")


@dataclass(frozen=True)
class Action:
    name: str  # RESET, ACTION1..ACTION7
    x: int | None = None  # ACTION6 only
    y: int | None = None
    reason: str = ""

    def __post_init__(self) -> None:
        if self.name not in NAMES:
            raise ValueError(f"unknown action: {self.name}")
        has_point = self.x is not None and self.y is not None
        if self.name == "ACTION6" and not has_point:
            raise ValueError("ACTION6 needs x and y")
        if self.name != "ACTION6" and (self.x is not None or self.y is not None):
            raise ValueError("only ACTION6 takes x and y")
        if has_point and not (0 <= self.x <= 63 and 0 <= self.y <= 63):  # type: ignore[operator]
            raise ValueError("x and y must be 0 to 63")

    @property
    def short(self) -> str:
        """Short form: A1, A6@12,40, RESET."""
        if self.name == "RESET":
            return "RESET"
        text = "A" + self.name[-1]
        if self.x is not None:
            text += f"@{self.x},{self.y}"
        return text

    @classmethod
    def parse(cls, text: str, reason: str = "") -> Action:
        """Read the short or long form."""
        text = text.strip().upper()
        match = _SHORT.match(text)
        if match:
            if text == "RESET":
                return cls("RESET", reason=reason)
            num, x, y = match.groups()
            if x is not None:
                return cls(f"ACTION{num}", int(x), int(y), reason=reason)
            return cls(f"ACTION{num}", reason=reason)
        return cls(text, reason=reason)

    def to_dict(self) -> dict[str, object]:
        out: dict[str, object] = {"name": self.name}
        if self.x is not None:
            out["x"] = self.x
            out["y"] = self.y
        return out

    def __str__(self) -> str:
        return self.short
