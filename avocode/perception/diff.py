"""Changed cells between two grids."""

from __future__ import annotations

from dataclasses import dataclass

from avocode.core.state import Grid


@dataclass(frozen=True)
class GridDiff:
    changed: tuple[tuple[int, int, int, int], ...]  # x, y, old, new

    @property
    def noop(self) -> bool:
        return not self.changed

    @property
    def bbox(self) -> tuple[int, int, int, int] | None:
        """Box of changed cells: x0, y0, x1, y1."""
        if not self.changed:
            return None
        xs = [c[0] for c in self.changed]
        ys = [c[1] for c in self.changed]
        return min(xs), min(ys), max(xs), max(ys)

    def summary(self) -> dict[str, object]:
        """Short form for step events."""
        box = self.bbox
        return {"cells": len(self.changed), "noop": self.noop, "bbox": list(box) if box else None}


def grid_diff(old: Grid | None, new: Grid) -> GridDiff:
    """Changed cells. No old grid means all cells."""
    if old is None or (old.width, old.height) != (new.width, new.height):
        return GridDiff(
            tuple((i % new.width, i // new.width, -1, c) for i, c in enumerate(new.cells))
        )
    w = new.width
    return GridDiff(
        tuple(
            (i % w, i // w, a, b)
            for i, (a, b) in enumerate(zip(old.cells, new.cells, strict=True))
            if a != b
        )
    )


def describe_diff(diff: GridDiff, limit: int = 40) -> str:
    """Text form of a diff for prompts."""
    if diff.noop:
        return "no cells changed"
    box = diff.bbox
    head = f"{len(diff.changed)} cells changed in box x={box[0]}..{box[2]} y={box[1]}..{box[3]}"  # type: ignore[index]
    moves: dict[tuple[int, int], int] = {}
    for _, _, old, new in diff.changed:
        moves[(old, new)] = moves.get((old, new), 0) + 1
    parts = [
        f"{_hex(o)}->{_hex(n)} x{count}"
        for (o, n), count in sorted(moves.items(), key=lambda kv: -kv[1])
    ]
    lines = [head, "color changes: " + ", ".join(parts[:12])]
    if len(diff.changed) <= limit:
        cells = " ".join(f"({x},{y}):{_hex(o)}->{_hex(n)}" for x, y, o, n in diff.changed)
        lines.append("cells: " + cells)
    return "\n".join(lines)


def _hex(color: int) -> str:
    return "?" if color < 0 else format(color, "x")
