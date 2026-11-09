"""Sprites that share a shape."""

from __future__ import annotations

from collections.abc import Callable

from avocode.perception.scene import Scene, SceneObject

MIN_CELLS = 3
MAX_SCALE = 4
MAX_LINES = 6

Mask = frozenset[tuple[int, int]]

# Order sets the preferred name.
TURNS: list[tuple[str, Callable[[int, int, int, int], tuple[int, int]]]] = [
    ("", lambda x, y, w, h: (x, y)),
    ("mirrored left-right", lambda x, y, w, h: (w - 1 - x, y)),
    ("mirrored up-down", lambda x, y, w, h: (x, h - 1 - y)),
    ("turned 180", lambda x, y, w, h: (w - 1 - x, h - 1 - y)),
    ("turned 90", lambda x, y, w, h: (h - 1 - y, x)),
    ("turned 270", lambda x, y, w, h: (y, w - 1 - x)),
    ("mirrored on diagonal", lambda x, y, w, h: (y, x)),
    ("mirrored on other diagonal", lambda x, y, w, h: (h - 1 - y, w - 1 - x)),
]


def shape_text(scene: Scene) -> str:
    """Lines for sprites with equal shapes."""
    groups: dict[tuple[tuple[int, int], ...], list[tuple[SceneObject, int, Mask, int]]] = {}
    for o in scene.objects:
        if o.kind != "sprite":
            continue
        for color, mask in color_masks(o).items():
            if len(mask) < MIN_CELLS or _is_rect(mask):
                continue
            small, scale = reduce_mask(mask)
            key = min(tuple(sorted(_turn(small, f))) for _, f in TURNS)
            groups.setdefault(key, []).append((o, color, small, scale))
    lines = []
    for members in groups.values():
        if len({o.id for o, *_ in members}) < 2:
            continue
        lines.append("same shape: " + ", ".join(_describe(m, members) for m in members))
    return "\n".join(lines[:MAX_LINES])


def color_masks(o: SceneObject) -> dict[int, Mask]:
    """Cells of each color, moved to 0,0."""
    out: dict[int, set[tuple[int, int]]] = {}
    for x, y, c in o.cells:
        out.setdefault(c, set()).add((x, y))
    return {c: _normalize(cells) for c, cells in out.items()}


def reduce_mask(mask: Mask) -> tuple[Mask, int]:
    """Shrink k-by-k blocks to one cell."""
    w, h = _size(mask)
    for k in range(MAX_SCALE, 1, -1):
        if w % k or h % k:
            continue
        small = frozenset((x // k, y // k) for x, y in mask)
        if len(small) * k * k == len(mask):
            return small, k
    return mask, 1


def _describe(m: tuple[SceneObject, int, Mask, int],
              members: list[tuple[SceneObject, int, Mask, int]]) -> str:
    o, color, small, scale = m
    _, _, first, _ = members[0]
    turn = next(name for name, f in TURNS if _turn(first, f) == small)
    low = min(s for *_, s in members)
    notes = [n for n in (f"{scale // low}x larger" if scale > low else "", turn) if n]
    return f"obj#{o.id} color {color:x}" + (f" ({', '.join(notes)})" if notes else "")


def _turn(mask: Mask, f: Callable[[int, int, int, int], tuple[int, int]]) -> Mask:
    w, h = _size(mask)
    return _normalize({f(x, y, w, h) for x, y in mask})


def _normalize(cells: set[tuple[int, int]] | Mask) -> Mask:
    x0 = min(x for x, _ in cells)
    y0 = min(y for _, y in cells)
    return frozenset((x - x0, y - y0) for x, y in cells)


def _size(mask: Mask) -> tuple[int, int]:
    return max(x for x, _ in mask) + 1, max(y for _, y in mask) + 1


def _is_rect(mask: Mask) -> bool:
    w, h = _size(mask)
    return len(mask) == w * h
