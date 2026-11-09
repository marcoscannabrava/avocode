"""Action and round limits."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Budget:
    max_actions: int = 400
    max_rounds: int = 20

    def actions_left(self, steps: int) -> bool:
        return steps < self.max_actions

    def rounds_left(self, rounds: int) -> bool:
        return rounds < self.max_rounds
