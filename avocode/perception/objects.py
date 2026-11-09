"""Connected cells of one color."""

from __future__ import annotations

from dataclasses import dataclass, field

from avocode.core.state import Grid


@dataclass(frozen=True)
class Blob:
    id: int
    color: int
    size: int
    bbox: tuple[int, int, int, int]  # x0, y0, x1, y1
    cells: frozenset[tuple[int, int]] = field(default=frozenset(), compare=False, repr=False)


def find_blobs(grid: Grid, background: int | None = None, diagonal: bool = False) -> list[Blob]:
    """Find blobs, largest first."""
    w, h = grid.width, grid.height
    seen = bytearray(w * h)
    steps = [(1, 0), (-1, 0), (0, 1), (0, -1)]
    if diagonal:
        steps += [(1, 1), (1, -1), (-1, 1), (-1, -1)]
    found: list[tuple[int, int, int, int, int, int, frozenset[tuple[int, int]]]] = []
    for start in range(w * h):
        color = grid.cells[start]
        if seen[start] or color == background:
            continue
        seen[start] = 1
        stack = [start]
        size = 0
        pos: list[tuple[int, int]] = []
        x0, y0, x1, y1 = w, h, -1, -1
        while stack:
            i = stack.pop()
            x, y = i % w, i // w
            size += 1
            pos.append((x, y))
            x0, y0, x1, y1 = min(x0, x), min(y0, y), max(x1, x), max(y1, y)
            for dx, dy in steps:
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h:
                    j = ny * w + nx
                    if not seen[j] and grid.cells[j] == color:
                        seen[j] = 1
                        stack.append(j)
        found.append((color, size, x0, y0, x1, y1, frozenset(pos)))
    found.sort(key=lambda b: (-b[1], b[3], b[2]))
    return [Blob(i, c, s, (a, b, d, e), p) for i, (c, s, a, b, d, e, p) in enumerate(found)]
