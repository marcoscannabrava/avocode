#!/usr/bin/env python3
# PROTECTED -- this file is part of `f`. Editing it makes `bench/init.sh --verify` fail.
#
# The policy CONTRACT suite. It does not test whether the policy is any good -- that is what the
# score is for. It tests that the policy is a policy: constructible, legal, reproducible, and blind
# to everything except the frames it is handed.
#
#   .venv/bin/python -m unittest discover -s test -q

import random
import sys
import unittest
from enum import IntEnum
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.policy import Policy  # noqa: E402


class FakeAction(IntEnum):
    """Stands in for arcengine's GameAction, so the contract is checked without the engine."""

    ACTION1 = 1
    ACTION2 = 2
    ACTION3 = 3
    ACTION4 = 4
    ACTION6 = 6

    def is_complex(self):
        return self is FakeAction.ACTION6


class FakeFrame:
    def __init__(self, rng, actions, levels=0):
        # Exactly what the engine hands over, and the types matter: `frame` is a LIST of numpy
        # (64, 64) int8 arrays, not nested Python lists. An earlier version of this fake used
        # nested lists, and a policy that compared two frames with `==` passed the suite and then
        # died on the real thing with "truth value of an array is ambiguous". A fake that is easier
        # to satisfy than the real interface is worse than no fake.
        self.frame = [np.array(
            [[rng.randrange(16) for _ in range(64)] for _ in range(64)], dtype=np.int8
        )]
        self.state = "NOT_FINISHED"
        self.levels_completed = levels
        self.win_levels = 5
        self.available_actions = [int(a) for a in actions]
        self.game_id = "hidden"


SIMPLE = [FakeAction.ACTION1, FakeAction.ACTION2, FakeAction.ACTION3, FakeAction.ACTION4]
WITH_CLICK = SIMPLE + [FakeAction.ACTION6]


def unpack(choice):
    if isinstance(choice, tuple):
        return choice
    return choice, {}


class PolicyContract(unittest.TestCase):
    def _play(self, action_space, steps=200, seed=7):
        rng = random.Random(seed)
        policy = Policy(action_space=list(action_space), rng=random.Random(seed))
        out = []
        for i in range(steps):
            action, data = unpack(policy.act(FakeFrame(rng, action_space, levels=i // 50)))
            out.append((action, tuple(sorted(data.items()))))
        return out

    def test_constructs_with_keyword_arguments(self):
        """bench/run.py passes action_space and rng by keyword; the signature is part of the contract."""
        Policy(action_space=list(SIMPLE), rng=random.Random(0))

    def test_returns_only_legal_actions(self):
        for space in (SIMPLE, WITH_CLICK):
            for action, _ in self._play(space):
                self.assertIn(action, space, f"{action!r} is not in {space!r}")

    def test_complex_actions_carry_coordinates(self):
        for action, data in self._play(WITH_CLICK):
            if action.is_complex():
                keys = dict(data)
                self.assertIn("x", keys)
                self.assertIn("y", keys)
                self.assertTrue(0 <= keys["x"] < 64, f"x out of range: {keys['x']}")
                self.assertTrue(0 <= keys["y"] < 64, f"y out of range: {keys['y']}")

    def test_simple_actions_carry_no_coordinates(self):
        for action, data in self._play(SIMPLE):
            self.assertFalse(action.is_complex())
            self.assertEqual(dict(data).get("x"), None, "a simple action was given click coordinates")

    def test_is_reproducible_for_a_fixed_seed(self):
        """The score is a mean over fixed seeds. A policy that is not reproducible cannot commit."""
        self.assertEqual(self._play(WITH_CLICK, seed=3), self._play(WITH_CLICK, seed=3))

    def test_does_not_import_the_engine(self):
        """A policy that can reach arcengine can read game state instead of perceiving it."""
        import src.policy as mod

        for banned in ("arcengine", "arc_agi", "socket", "urllib", "requests"):
            self.assertIsNone(
                getattr(mod, banned, None),
                f"src/policy.py has {banned} in scope; a policy sees frames, nothing else",
            )

    def test_tolerates_numpy_frames(self):
        """The grid is a numpy array. `a == b` on one is an array, not a bool -- comparing frames
        with a bare `==` raises, so a policy that does it must not reach the score."""
        rng = random.Random(11)
        policy = Policy(action_space=list(SIMPLE), rng=random.Random(11))
        frame = FakeFrame(rng, SIMPLE)
        self.assertIsInstance(frame.frame[0], np.ndarray)
        for _ in range(5):
            unpack(policy.act(frame))  # same array object twice: the "did it change" path

    def test_survives_a_single_action_space(self):
        """Some games expose one action. Indexing action_space[1] unconditionally is a crash."""
        for action, _ in self._play([FakeAction.ACTION6], steps=20):
            self.assertEqual(action, FakeAction.ACTION6)


if __name__ == "__main__":
    unittest.main()
