"""Step history: tickers, player, moves."""

from __future__ import annotations

from collections import Counter

from avocode.perception.changes import Change
from avocode.perception.scene import Scene

MIN_STEPS = 3
TICK_SHARE = 0.8  # share of steps an object changes


class Layout:
    """History of object changes in one level."""

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        """Forget all; call on a new level."""
        self.steps = 0
        self.first_seen: dict[int, int] = {}
        self.changed: Counter[int] = Counter()
        self.actions: dict[int, set[str]] = {}
        self.size_delta: Counter[int] = Counter()
        self.moved: Counter[int] = Counter()
        self.moves: dict[int, dict[str, Counter[tuple[int, int]]]] = {}

    def observe(self, old: Scene, new: Scene, changes: list[Change], action: str) -> None:
        """Record one step."""
        self.steps += 1
        for o in old.objects:
            self.first_seen.setdefault(o.id, self.steps)
        for o in new.objects:
            self.first_seen.setdefault(o.id, self.steps)
        hit = {c.id: c for c in changes}
        for c in changes:
            self.changed[c.id] += 1
            self.actions.setdefault(c.id, set()).add(action)
            if c.old is not None:
                self.size_delta[c.id] += c.obj.size - c.old.size
            if c.kind == "moved":
                self.moved[c.id] += 1
        for oid in self.moved:
            hit_c = hit.get(oid)
            delta = (hit_c.dx, hit_c.dy) if hit_c and hit_c.kind == "moved" else (0, 0)
            self.moves.setdefault(oid, {}).setdefault(action, Counter())[delta] += 1

    def tickers(self) -> set[int]:
        """Objects that change on almost every step."""
        out = set()
        for oid, n in self.changed.items():
            if self.moved[oid]:
                continue
            seen = self.steps - self.first_seen.get(oid, 1) + 1
            if n >= MIN_STEPS and n >= TICK_SHARE * seen and len(self.actions[oid]) >= 2:
                out.add(oid)
        return out

    def player_guess(self) -> int | None:
        """The sprite that moved most often."""
        ticks = self.tickers()
        moved = [(n, oid) for oid, n in self.moved.items() if oid not in ticks and n >= 2]
        return max(moved)[1] if moved else None

    def action_moves(self, obj_id: int) -> dict[str, Counter[tuple[int, int]]]:
        return self.moves.get(obj_id, {})

    def step_size(self, obj_id: int) -> int | None:
        """Most common move length."""
        lengths: Counter[int] = Counter()
        for counts in self.action_moves(obj_id).values():
            for (dx, dy), n in counts.items():
                if (dx, dy) != (0, 0):
                    lengths[max(abs(dx), abs(dy))] += n
        return lengths.most_common(1)[0][0] if lengths else None

    def describe(self, scene: Scene) -> str:
        """Tickers, player guess, and action moves."""
        lines = [f"history: {self.steps} steps in this level"]
        for oid in sorted(self.tickers()):
            o = scene.get(oid)
            if o is None:
                continue
            rate = self.size_delta[oid] / self.changed[oid]
            lines.append(
                f"ticker: {o.label} at {o.where}, size {o.size}, {rate:+.1f} cells per change"
            )
        pid = self.player_guess()
        if pid is None:
            lines.append("player guess: none yet")
            return "\n".join(lines)
        lines.append(f"player guess: obj#{pid} (moved in {self.moved[pid]} of {self.steps} steps)")
        parts = []
        for action, counts in sorted(self.action_moves(pid).items()):
            parts.append(f"{action} " + ", ".join(
                f"{_move(d)} x{n}" for d, n in counts.most_common()
            ))
        if parts:
            lines.append(f"moves of obj#{pid}: " + "; ".join(parts))
        return "\n".join(lines)


def _move(d: tuple[int, int]) -> str:
    return "no move" if d == (0, 0) else f"({d[0]:+d},{d[1]:+d})"
