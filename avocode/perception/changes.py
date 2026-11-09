"""Object events between two scenes."""

from __future__ import annotations

from dataclasses import dataclass

from avocode.perception.scene import Scene, SceneObject


@dataclass(frozen=True)
class Change:
    kind: str  # moved, changed, appeared, vanished
    obj: SceneObject  # new object; old one if vanished
    old: SceneObject | None = None
    dx: int = 0
    dy: int = 0

    @property
    def id(self) -> int:
        return self.obj.id

    def text(self) -> str:
        o = self.obj
        if self.kind == "moved":
            return f"{o.label} moved ({self.dx:+d},{self.dy:+d}) to {o.where}"
        if self.kind == "changed":
            old = self.old
            assert old is not None
            moved = f", box {old.where} -> {o.where}" if old.bbox != o.bbox else ""
            return f"{o.label} changed size {old.size} -> {o.size}{moved}"
        return f"{o.label} {self.kind}, size {o.size} at {o.where}"


def scene_changes(old: Scene, new: Scene) -> list[Change]:
    """Events from old to new, by ID."""
    before = {o.id: o for o in old.objects}
    after = {o.id: o for o in new.objects}
    out: list[Change] = []
    for oid, n in after.items():
        o = before.get(oid)
        if o is None:
            out.append(Change("appeared", n))
        elif o.cells == n.cells:
            continue
        elif o.pattern == n.pattern:
            out.append(Change("moved", n, o, n.bbox[0] - o.bbox[0], n.bbox[1] - o.bbox[1]))
        else:
            out.append(Change("changed", n, o))
    out += [Change("vanished", o) for oid, o in before.items() if oid not in after]
    return _drop_shadows(out)


def describe_changes(changes: list[Change], tickers: set[int] | None = None) -> str:
    """One line per event; tickers on one line."""
    if not changes:
        return "no objects changed"
    tickers = tickers or set()
    main = [c for c in changes if c.id not in tickers]
    tick = [c for c in changes if c.id in tickers]
    lines = [c.text() for c in main]
    if tick:
        lines.append("tickers (change on every step): " + "; ".join(c.text() for c in tick))
    return "\n".join(lines)


def _drop_shadows(changes: list[Change]) -> list[Change]:
    """Drop edits caused by sprite moves."""
    moved = [c for c in changes if c.kind == "moved"]
    covered: set[tuple[int, int]] = set()
    for c in moved:
        for o in (c.obj, c.old):
            if o is not None:
                x0, y0, x1, y1 = o.bbox
                covered |= {(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)}
    out = []
    for c in changes:
        if c.kind == "changed" and c.old is not None:
            diff = {(x, y) for x, y, _ in c.old.cells ^ c.obj.cells}
            if diff <= covered:
                continue
        out.append(c)
    return out
