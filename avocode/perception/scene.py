"""Objects with stable IDs."""

from __future__ import annotations

from dataclasses import dataclass

from avocode.core.state import Grid
from avocode.perception.encode import background_color
from avocode.perception.objects import Blob

SPRITE_SPAN = 10  # wider blobs are regions
SEARCH = 10  # max sprite move to search
JOIN_RATIO = 4  # max size ratio to join
MAX_RECTS = 8

Cell = tuple[int, int, int]  # x, y, color


@dataclass(frozen=True)
class SceneObject:
    id: int
    kind: str  # "sprite" or "region"
    colors: tuple[int, ...]
    cells: frozenset[Cell]
    bbox: tuple[int, int, int, int]  # x0, y0, x1, y1

    @property
    def size(self) -> int:
        return len(self.cells)

    @property
    def pattern(self) -> tuple[str, ...]:
        """Rows relative to the box; '.' is empty."""
        x0, y0, x1, y1 = self.bbox
        at = {(x, y): c for x, y, c in self.cells}
        return tuple(
            "".join(format(at[(x, y)], "x") if (x, y) in at else "." for x in range(x0, x1 + 1))
            for y in range(y0, y1 + 1)
        )

    @property
    def label(self) -> str:
        return f"obj#{self.id} {self.kind} {','.join(format(c, 'x') for c in self.colors)}"

    @property
    def where(self) -> str:
        x0, y0, x1, y1 = self.bbox
        return f"x={x0}..{x1} y={y0}..{y1}"


@dataclass(frozen=True)
class Scene:
    width: int
    height: int
    background: int
    objects: tuple[SceneObject, ...]
    next_id: int

    def get(self, obj_id: int) -> SceneObject | None:
        return next((o for o in self.objects if o.id == obj_id), None)

    def owner_map(self) -> dict[tuple[int, int], int]:
        """Cell position to object ID."""
        return {(x, y): o.id for o in self.objects for x, y, _ in o.cells}


def build_scene(grid: Grid, prev: Scene | None = None) -> Scene:
    """Find objects; reuse IDs from prev."""
    bg = background_color(grid)
    if prev is None or (prev.width, prev.height) != (grid.width, grid.height):
        raw = _group(grid, bg, set())
        objs = [_with_id(o, i) for i, o in enumerate(raw)]
        return Scene(grid.width, grid.height, bg, tuple(objs), len(objs))
    kept = _carve(grid, prev)
    claimed = {(x, y) for o in kept for x, y, _ in o.cells}
    raw = _group(grid, bg, claimed)
    kept_ids = {o.id for o in kept}
    ids = _match(tuple(o for o in prev.objects if o.id not in kept_ids), raw)
    next_id = prev.next_id
    objs = list(kept)
    for i, o in enumerate(raw):
        if i in ids:
            objs.append(_with_id(o, ids[i]))
        else:
            objs.append(_with_id(o, next_id))
            next_id += 1
    objs.sort(key=_order)
    return Scene(grid.width, grid.height, bg, tuple(objs), next_id)


def describe_scene(scene: Scene, max_objects: int = 20) -> str:
    """Objects as text, largest first."""
    lines = [f"background {scene.background:x}, {len(scene.objects)} objects"]
    under = {(x, y) for o in scene.objects if o.kind == "sprite" for x, y, _ in o.cells}
    for o in scene.objects[:max_objects]:
        lines.append(describe_object(o, under))
    if len(scene.objects) > max_objects:
        lines.append(f"... {len(scene.objects) - max_objects} more small objects")
    return "\n".join(lines)


def describe_object(o: SceneObject, under: set[tuple[int, int]] | None = None) -> str:
    """One object as text. Under: sprite cells."""
    head = f"{o.label} size {o.size} at {o.where}"
    if o.kind == "sprite":
        return "\n".join([head, *("  " + row for row in o.pattern)])
    rects = rectangles(o, under or set())
    parts = [f"x={a}..{c} y={b}..{d}" for a, b, c, d in rects[:MAX_RECTS]]
    more = f", +{len(rects) - MAX_RECTS} more" if len(rects) > MAX_RECTS else ""
    return f"{head}\n  rects: {', '.join(parts)}{more}"


def rectangles(
    o: SceneObject, under: set[tuple[int, int]] | None = None,
) -> list[tuple[int, int, int, int]]:
    """Cover cells with rectangles, largest first.

    Cells in under (sprites on top) count as filled.
    """
    own = {(x, y) for x, y, _ in o.cells}
    x0, y0, x1, y1 = o.bbox
    filled = own | {p for p in (under or set()) if x0 <= p[0] <= x1 and y0 <= p[1] <= y1}
    left = set(own)
    out = []
    while left:
        rect = _largest_rect(filled, left, o.bbox)
        if rect is None:
            break
        a, b, c, d = rect
        left -= {(x, y) for y in range(b, d + 1) for x in range(a, c + 1)}
        out.append(rect)
    return out


def _largest_rect(
    filled: set[tuple[int, int]], left: set[tuple[int, int]], box: tuple[int, int, int, int],
) -> tuple[int, int, int, int] | None:
    """Largest filled rectangle with new cells."""
    x0, y0, x1, y1 = box
    heights = [0] * (x1 - x0 + 1)
    best, best_rect = 0, None
    for y in range(y0, y1 + 1):
        for i in range(len(heights)):
            heights[i] = heights[i] + 1 if (x0 + i, y) in filled else 0
        stack: list[int] = []
        for i in range(len(heights) + 1):
            h = heights[i] if i < len(heights) else 0
            while stack and heights[stack[-1]] >= h:
                top = stack.pop()
                start = stack[-1] + 1 if stack else 0
                area = heights[top] * (i - start)
                if area > best:
                    rect = (x0 + start, y - heights[top] + 1, x0 + i - 1, y)
                    gain = _new_cells(rect, left)
                    if gain:
                        best, best_rect = area, rect
            stack.append(i)
    if best_rect is None and left:
        x, y = min(left, key=lambda p: (p[1], p[0]))
        return (x, y, x, y)
    return best_rect


def _new_cells(rect: tuple[int, int, int, int], left: set[tuple[int, int]]) -> bool:
    a, b, c, d = rect
    return any((x, y) in left for y in range(b, d + 1) for x in range(a, c + 1))


def _group(grid: Grid, bg: int, claimed: set[tuple[int, int]]) -> list[SceneObject]:
    """Blobs to regions and joined sprites."""
    blobs = _components(grid, bg, claimed)
    regions = [b for b in blobs if _is_region(b)]
    small = [b for b in blobs if not _is_region(b)]
    owner = {pos: b.id for b in small for pos in b.cells}
    by_id = {b.id: b for b in small}
    groups: list[list[Blob]] = []
    done: set[int] = set()
    for b in small:
        if b.id in done:
            continue
        group, box = [b], b.bbox
        done.add(b.id)
        stack = [b]
        while stack:
            cur = stack.pop()
            for nb_id in _touching(set(cur.cells), owner):
                if nb_id in done:
                    continue
                nb = by_id[nb_id]
                joined = _union(box, nb.bbox)
                if _span(joined) > SPRITE_SPAN or not _alike(cur, nb):
                    continue
                box = joined
                done.add(nb_id)
                group.append(nb)
                stack.append(nb)
        groups.append(group)
    objs = [_make("region", [b], grid) for b in regions]
    objs += [_make("sprite", g, grid) for g in groups]
    objs.sort(key=_order)
    return objs


def _components(grid: Grid, bg: int, claimed: set[tuple[int, int]]) -> list[Blob]:
    """One-color blobs. Claimed cells join parts."""
    w, h = grid.width, grid.height
    seen: set[tuple[int, int]] = set()
    out: list[Blob] = []
    for y in range(h):
        for x in range(w):
            color = grid.at(x, y)
            if (x, y) in seen or (x, y) in claimed or color == bg:
                continue
            cells = {(x, y)}
            bridge: set[tuple[int, int]] = set()
            stack = [(x, y)]
            while stack:
                cx, cy = stack.pop()
                for p in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if not (0 <= p[0] < w and 0 <= p[1] < h) or p in cells or p in bridge:
                        continue
                    if p in claimed:
                        bridge.add(p)
                        stack.append(p)
                    elif grid.at(*p) == color:
                        cells.add(p)
                        stack.append(p)
            seen |= cells
            xs = [c[0] for c in cells]
            ys = [c[1] for c in cells]
            box = (min(xs), min(ys), max(xs), max(ys))
            out.append(Blob(len(out), color, len(cells), box, frozenset(cells)))
    return out


def _carve(grid: Grid, prev: Scene) -> list[SceneObject]:
    """Find old sprites near their old place."""
    out: list[SceneObject] = []
    taken: set[tuple[int, int]] = set()
    sprites = sorted((o for o in prev.objects if o.kind == "sprite"), key=lambda o: -o.size)
    offsets = sorted(
        ((dx, dy) for dx in range(-SEARCH, SEARCH + 1) for dy in range(-SEARCH, SEARCH + 1)),
        key=lambda d: abs(d[0]) + abs(d[1]),
    )
    for o in sprites:
        for dx, dy in offsets:
            moved = [(x + dx, y + dy, c) for x, y, c in o.cells]
            if _fits(grid, moved, taken):
                taken |= {(x, y) for x, y, _ in moved}
                x0, y0, x1, y1 = o.bbox
                box = (x0 + dx, y0 + dy, x1 + dx, y1 + dy)
                out.append(SceneObject(o.id, "sprite", o.colors, frozenset(moved), box))
                break
    return out


def _fits(grid: Grid, cells: list[Cell], taken: set[tuple[int, int]]) -> bool:
    """Cells match, and same colors do not spill out."""
    w, h = grid.width, grid.height
    pos = {(x, y) for x, y, _ in cells}
    for x, y, c in cells:
        if not (0 <= x < w and 0 <= y < h) or (x, y) in taken or grid.at(x, y) != c:
            return False
    for x, y, c in cells:
        for p in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if p not in pos and 0 <= p[0] < w and 0 <= p[1] < h and grid.at(*p) == c:
                return False
    return True


def _order(o: SceneObject) -> tuple[int, int, int]:
    return -o.size, o.bbox[1], o.bbox[0]


def _touching(cells: set[tuple[int, int]], owner: dict[tuple[int, int], int]) -> set[int]:
    out = set()
    for x, y in cells:
        for p in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if p in owner and p not in cells:
                out.add(owner[p])
    return out


def _alike(a: Blob, b: Blob) -> bool:
    """Sizes close enough to join."""
    return max(a.size, b.size) <= JOIN_RATIO * min(a.size, b.size)


def _is_region(b: Blob) -> bool:
    return _span(b.bbox) > SPRITE_SPAN


def _span(box: tuple[int, int, int, int]) -> int:
    return max(box[2] - box[0] + 1, box[3] - box[1] + 1)


def _union(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    return min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])


def _make(kind: str, group: list[Blob], grid: Grid) -> SceneObject:
    pos = set().union(*(b.cells for b in group))
    box = group[0].bbox
    for b in group[1:]:
        box = _union(box, b.bbox)
    colors = tuple(sorted({b.color for b in group}))
    return SceneObject(-1, kind, colors, frozenset((x, y, grid.at(x, y)) for x, y in pos), box)


def _with_id(o: SceneObject, obj_id: int) -> SceneObject:
    return SceneObject(obj_id, o.kind, o.colors, o.cells, o.bbox)


def _match(old: tuple[SceneObject, ...], new: list[SceneObject]) -> dict[int, int]:
    """New index to old ID."""
    out: dict[int, int] = {}
    used: set[int] = set()
    # same pattern, nearest first
    pairs = [
        (_dist(o, n), i, o.id)
        for i, n in enumerate(new) for o in old
        if o.kind == n.kind and o.colors == n.colors and o.pattern == n.pattern
    ]
    for _, i, oid in sorted(pairs):
        if i not in out and oid not in used:
            out[i] = oid
            used.add(oid)
    # same colors, most overlap
    pairs2 = [
        (-_overlap(o.bbox, n.bbox), _dist(o, n), i, o.id)
        for i, n in enumerate(new) if i not in out
        for o in old if o.id not in used and o.colors == n.colors
        and _overlap(o.bbox, n.bbox) > 0
    ]
    for _, _, i, oid in sorted(pairs2):
        if i not in out and oid not in used:
            out[i] = oid
            used.add(oid)
    return out


def _dist(a: SceneObject, b: SceneObject) -> int:
    return abs(a.bbox[0] - b.bbox[0]) + abs(a.bbox[1] - b.bbox[1])


def _overlap(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> int:
    w = min(a[2], b[2]) - max(a[0], b[0]) + 1
    h = min(a[3], b[3]) - max(a[1], b[1]) + 1
    return max(w, 0) * max(h, 0)
