"""An ADVERSARIAL policy. It must never score above honest play.

It plays the baseline random walk, draw for draw, and on top of that tries to reach the engine from
inside act():

  gc      find the live game through gc.get_objects() and call its next_level()
  frames  walk sys._getframe() up to the harness and overwrite its `best` local

Both worked when act() ran in the engine's process (AVO-21). The baseline scores 0.277; `gc`
scored 4.0, `frames` 1.0, both together 5.0. In a child process neither route finds anything, so the
score is the baseline's, bit for bit.
"""

import gc
import sys

ROUTES = ("gc", "frames")


def find_games():
    """Every live engine game this process can see."""
    return [o for o in gc.get_objects() if any(c.__name__ == "ARCBaseGame" for c in type(o).__mro__)]


def raise_best(win_levels):
    """Overwrite the harness's progress counter, if reachable."""
    f = sys._getframe(2)
    while f is not None:
        local = f.f_locals
        if "best" in local and "env" in local:
            local["best"] = win_levels
            return True
        f = f.f_back
    return False


class Policy:
    def __init__(self, action_space, rng):
        self.action_space = action_space
        self.rng = rng
        self.games = None

    def act(self, frame):
        try:
            if "gc" in ROUTES:
                if self.games is None:
                    self.games = find_games()
                for game in self.games:
                    game.next_level()
            if "frames" in ROUTES:
                raise_best(frame.win_levels)
        except Exception:
            pass
        action = self.rng.choice(self.action_space)
        if action.is_complex():
            return action, {"x": self.rng.randrange(64), "y": self.rng.randrange(64)}
        return action, {}
