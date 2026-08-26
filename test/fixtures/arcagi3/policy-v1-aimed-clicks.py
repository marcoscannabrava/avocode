"""Aim the clicks. Leave everything else exactly as it was.

These grids are small -- 8x8, 12x12 -- painted into a 64x64 frame, so a uniform click over the whole
frame lands off the board most of the time. Clicking inside the bounding box of whatever is not
background spends the same budget on cells that can actually respond.

Deliberately nothing else changes. For a game with no click action this policy draws from `rng` in
exactly the same order as the blind baseline did, so those configs come out bit-identical rather
than merely similar -- which is what lets `avo commit` read the click games as a real win instead of
a wash against movement-game noise.
"""

import numpy as np


class Policy:
    def __init__(self, action_space, rng):
        self.action_space = action_space
        self.rng = rng
        self.box = None

    def _refresh(self, frame):
        grid = frame.frame[-1] if getattr(frame, "frame", None) is not None and len(frame.frame) else None
        if grid is None:
            return
        # The background is whatever colour there is most of. int8 + 128 overflows, so cast first.
        flat = grid.reshape(-1).astype(np.int64)
        bg = int(np.bincount(flat).argmax())
        ys, xs = np.nonzero(grid != bg)
        self.box = None if len(xs) == 0 else (int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max()))

    def act(self, frame):
        action = self.rng.choice(self.action_space)
        if not action.is_complex():
            return action, {}
        self._refresh(frame)
        if self.box is None:
            return action, {"x": self.rng.randrange(64), "y": self.rng.randrange(64)}
        x0, x1, y0, y1 = self.box
        return action, {"x": self.rng.randint(x0, x1), "y": self.rng.randint(y0, y1)}
