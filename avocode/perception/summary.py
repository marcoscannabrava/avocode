"""Short text form of a State."""

from __future__ import annotations

from collections import Counter

from avocode.core.state import State
from avocode.perception.encode import background_color
from avocode.perception.objects import find_blobs


def state_header(state: State) -> str:
    """Status line and actions."""
    grid = state.grid
    return (
        f"game_state={state.game_state} levels={state.levels_completed}/{state.win_levels} "
        f"size={grid.width}x{grid.height} frames={len(state.frames)}\n"
        "actions: " + ", ".join(state.available_actions)
    )


def summarize_state(state: State, max_blobs: int = 12) -> str:
    """Status line, colors, and largest blobs."""
    grid = state.grid
    bg = background_color(grid)
    lines = [state_header(state)]
    counts = Counter(grid.cells)
    lines.append(
        "colors: " + ", ".join(f"{c:x}={n}" for c, n in sorted(counts.items()))
        + f" (background {bg:x})"
    )
    blobs = find_blobs(grid, background=bg)
    if blobs:
        lines.append(f"objects ({len(blobs)} total, largest first):")
        for b in blobs[:max_blobs]:
            x0, y0, x1, y1 = b.bbox
            lines.append(f"  color {b.color:x} size {b.size} at x={x0}..{x1} y={y0}..{y1}")
    return "\n".join(lines)
