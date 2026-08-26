"""Click the cells that exist, not the box that contains them.

The bounding box is a crude proxy: a sparse board leaves most of its box empty, so a uniform draw
inside the box still misses. Drawing from the actual non-background cells puts every click on
something. Still nothing but the click path changes, so movement games stay bit-identical.
"""

import numpy as np


class Policy:
    def __init__(self, action_space, rng):
        self.action_space = action_space
        self.rng = rng

    def _cells(self, frame):
        grid = frame.frame[-1] if getattr(frame, "frame", None) is not None and len(frame.frame) else None
        if grid is None:
            return None
        flat = grid.reshape(-1).astype(np.int64)  # int8 + 128 overflows; cast, do not offset
        bg = int(np.bincount(flat).argmax())
        ys, xs = np.nonzero(grid != bg)
        return None if len(xs) == 0 else (xs, ys)

    def act(self, frame):
        action = self.rng.choice(self.action_space)
        if not action.is_complex():
            return action, {}
        cells = self._cells(frame)
        if cells is None:
            return action, {"x": self.rng.randrange(64), "y": self.rng.randrange(64)}
        xs, ys = cells
        i = self.rng.randrange(len(xs))
        return action, {"x": int(xs[i]), "y": int(ys[i])}
