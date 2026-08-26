"""THE CANDIDATE. This is the only file the optimizer may change.

An ARC-AGI-3 policy. `bench/run.py` constructs one per episode and calls `act` once per action
until the game is won or the action budget runs out.

The baseline below is a uniform random walk. It is not a strawman -- on the five training games it
scores 0.267, because these games hand out early levels cheaply. It is, however, blind: it never
looks at the frame it is given.

You may rewrite this file however you like -- add modules under `src/`, keep state on the instance,
build a world model -- as long as `Policy` keeps this constructor and this `act` signature.
"""

import random


class Policy:
    """A policy sees frames and returns actions. That is the whole interface.

    Args:
        action_space: the `GameAction` members legal in this game, in engine order. For games with
            a click action, `action.is_complex()` is True and `act` must return `(x, y)` data with
            it.
        rng: a seeded `random.Random`. Use it for anything stochastic -- `random` module-level
            calls, wall-clock time and `os.urandom` all break reproducibility, and a score that is
            not reproducible cannot be committed.

    What `act` is given: a frame carrying

        frame             a list of numpy (64, 64) int8 arrays of colour indices -- usually one.
                          They are numpy arrays, so `a == b` gives an ARRAY, not a bool; use
                          `np.array_equal(a, b)` to ask whether two frames differ.
        state             the GameState enum member
        levels_completed  how many levels are behind you
        win_levels        how many there are in total
        available_actions the action ids legal right now, as plain ints

    What it is not given: the game's identity. These are games you have not seen before -- that is
    the benchmark.
    """

    def __init__(self, action_space, rng):
        self.action_space = action_space
        self.rng = rng

    def act(self, frame):
        action = self.rng.choice(self.action_space)
        if action.is_complex():
            return action, {"x": self.rng.randrange(64), "y": self.rng.randrange(64)}
        return action, {}
