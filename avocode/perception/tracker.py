"""Scene, changes, and history per game."""

from __future__ import annotations

from avocode.core.state import Grid
from avocode.perception.around import describe_around
from avocode.perception.changes import Change, describe_changes, scene_changes
from avocode.perception.layout import Layout
from avocode.perception.scene import Scene, build_scene, describe_scene


class Tracker:
    """Keep the scene and history across steps."""

    def __init__(self) -> None:
        self.grid: Grid | None = None
        self.scene: Scene | None = None
        self.changes: list[Change] = []
        self.layout = Layout()

    def update(self, grid: Grid, action: str | None = None, new_level: bool = False) -> None:
        """Take a new grid. No action: no history."""
        old = self.scene
        new = build_scene(grid, old)
        self.changes = scene_changes(old, new) if old is not None else []
        if new_level:
            self.layout.reset()
        elif old is not None and action is not None:
            self.layout.observe(old, new, self.changes, action)
        self.grid, self.scene = grid, new

    def objects_text(self) -> str:
        """Objects, history, and player surroundings."""
        if self.scene is None or self.grid is None:
            return "no grid yet"
        parts = [describe_scene(self.scene), self.layout.describe(self.scene)]
        pid = self.layout.player_guess()
        if pid is not None and self.scene.get(pid) is not None:
            step = self.layout.step_size(pid)
            parts.append(describe_around(self.grid, self.scene, pid, step))
        return "\n".join(parts)

    def changes_text(self) -> str:
        """Object events of the last update."""
        return describe_changes(self.changes, self.layout.tickers())


def scene_text(grid: Grid) -> str:
    """Objects of one grid, no history."""
    tracker = Tracker()
    tracker.update(grid)
    return tracker.objects_text()
