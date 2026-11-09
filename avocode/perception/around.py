"""What is next to an object."""

from __future__ import annotations

from avocode.core.state import Grid
from avocode.perception.scene import Scene

DIRS = {"up": (0, -1), "down": (0, 1), "left": (-1, 0), "right": (1, 0)}
MAX_RUNS = 4


def describe_around(grid: Grid, scene: Scene, obj_id: int, step: int | None = None) -> str:
    """Runs of rows on each side of an object."""
    o = scene.get(obj_id)
    if o is None:
        return f"obj#{obj_id} not found"
    owner = scene.owner_map()
    unit = f" (step {step})" if step else ""
    lines = [f"around obj#{obj_id} at {o.where}{unit}:"]
    for name, (dx, dy) in DIRS.items():
        lines.append(f"  {name}: {_scan(grid, owner, o.bbox, dx, dy, step)}")
    return "\n".join(lines)


def _scan(
    grid: Grid, owner: dict[tuple[int, int], int], box: tuple[int, int, int, int],
    dx: int, dy: int, step: int | None,
) -> str:
    """Join equal lines in one direction."""
    x0, y0, x1, y1 = box
    runs: list[tuple[str, int]] = []
    k = 1
    while True:
        if dx:
            x = x1 + k if dx > 0 else x0 - k
            if not 0 <= x < grid.width:
                break
            line = [(x, y) for y in range(y0, y1 + 1)]
        else:
            y = y1 + k if dy > 0 else y0 - k
            if not 0 <= y < grid.height:
                break
            line = [(x, y) for x in range(x0, x1 + 1)]
        key = _line_key(grid, owner, line)
        if runs and runs[-1][0] == key:
            runs[-1] = (key, runs[-1][1] + 1)
        else:
            runs.append((key, 1))
        k += 1
    if not runs:
        return "edge"
    parts = []
    for i, (key, n) in enumerate(runs[:MAX_RUNS]):
        if i == len(runs) - 1:
            parts.append(f"{key} to the edge")
        else:
            moves = n / step if step else 0
            steps = f" ({moves:g} {'step' if moves == 1 else 'steps'})" if step else ""
            parts.append(f"{key} for {n} {'line' if n == 1 else 'lines'}{steps}")
    if len(runs) > MAX_RUNS:
        parts.append("...")
    return ", then ".join(parts)


def _line_key(
    grid: Grid, owner: dict[tuple[int, int], int], line: list[tuple[int, int]],
) -> str:
    colors = {grid.at(x, y) for x, y in line}
    if len(colors) == 1:
        return format(colors.pop(), "x")
    ids = sorted({owner[p] for p in line if p in owner})
    return "mixed (" + ", ".join(f"obj#{i}" for i in ids) + ")"
