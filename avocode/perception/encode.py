"""Grid to text for prompts."""

from __future__ import annotations

from collections import Counter

from avocode.core.state import Grid


def background_color(grid: Grid) -> int:
    """The most common color."""
    if not grid.cells:
        return 0
    return Counter(grid.cells).most_common(1)[0][0]


def content_box(grid: Grid, background: int) -> tuple[int, int, int, int] | None:
    """Box of non-background cells: x0, y0, x1, y1."""
    xs = [i % grid.width for i, c in enumerate(grid.cells) if c != background]
    ys = [i // grid.width for i, c in enumerate(grid.cells) if c != background]
    if not xs:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def encode_grid(grid: Grid, crop: bool = False, labels: bool = True) -> str:
    """Hex rows, with optional crop and labels."""
    x0, y0, x1, y1 = 0, 0, grid.width - 1, grid.height - 1
    head = f"grid {grid.width}x{grid.height}"
    if crop:
        bg = background_color(grid)
        box = content_box(grid, bg)
        if box is None:
            return f"{head}, all cells color {bg:x}"
        x0, y0, x1, y1 = box
        if (x0, y0, x1, y1) != (0, 0, grid.width - 1, grid.height - 1):
            head += f", cropped to x={x0}..{x1} y={y0}..{y1}, outside is {bg:x}"
    lines = [head]
    rows = grid.rows()
    pad = len(str(y1))
    if labels:
        tens = "".join(str((x // 10) % 10) for x in range(x0, x1 + 1))
        ones = "".join(str(x % 10) for x in range(x0, x1 + 1))
        lines.append(" " * (pad + 1) + tens)
        lines.append(" " * (pad + 1) + ones)
    for y in range(y0, y1 + 1):
        row = "".join(format(c, "x") for c in rows[y][x0 : x1 + 1])
        lines.append(f"{y:>{pad}} {row}" if labels else row)
    return "\n".join(lines)
