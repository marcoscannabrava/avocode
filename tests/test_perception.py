from avocode.core import Grid, State
from avocode.perception import (
    Layout,
    background_color,
    build_scene,
    describe_around,
    describe_changes,
    describe_diff,
    describe_scene,
    encode_grid,
    find_blobs,
    grid_diff,
    scene_changes,
    summarize_state,
)

# The grid in ARCHITECTURE.md: X=3, G=4, Y=5, A=6.
ARCH = Grid.from_text(
    """
    003004
    003000
    003050
    660050
    """
)


def test_find_blobs_arch_grid() -> None:
    blobs = find_blobs(ARCH, background=0)
    by_color = {b.color: b for b in blobs}
    assert by_color[3].size == 3 and by_color[3].bbox == (2, 0, 2, 2)
    assert by_color[5].size == 2 and by_color[5].bbox == (4, 2, 4, 3)
    assert by_color[6].bbox == (0, 3, 1, 3)
    assert by_color[4].size == 1
    assert [b.id for b in blobs] == [0, 1, 2, 3]
    assert blobs[0].size >= blobs[-1].size


def test_find_blobs_diagonal() -> None:
    grid = Grid.from_text("10\n01")
    assert len(find_blobs(grid, background=0)) == 2
    assert len(find_blobs(grid, background=0, diagonal=True)) == 1


def test_grid_diff() -> None:
    after = Grid.from_text("003004\n003000\n003050\n066050")
    diff = grid_diff(ARCH, after)
    assert diff.changed == ((0, 3, 6, 0), (2, 3, 0, 6))
    assert diff.bbox == (0, 3, 2, 3)
    assert not diff.noop
    assert grid_diff(ARCH, ARCH).noop
    assert grid_diff(None, ARCH).changed[0] == (0, 0, -1, 0)
    assert diff.summary() == {"cells": 2, "noop": False, "bbox": [0, 3, 2, 3]}
    assert "2 cells changed" in describe_diff(diff)


def test_encode_grid_crop() -> None:
    grid = Grid.from_text("0000\n0120\n0000")
    assert background_color(grid) == 0
    text = encode_grid(grid, crop=True, labels=False)
    assert text.splitlines() == ["grid 4x3, cropped to x=1..2 y=1..1, outside is 0", "12"]
    full = encode_grid(grid, labels=True).splitlines()
    assert full[1:3] == ["  0000", "  0123"]
    assert full[4] == "1 0120"


def test_encode_empty_grid() -> None:
    assert "all cells color 0" in encode_grid(Grid.from_text("00\n00"), crop=True)


def test_summary() -> None:
    state = State((ARCH,), "NOT_FINISHED", 0, 2, ("ACTION1", "ACTION6"))
    text = summarize_state(state)
    assert "levels=0/2" in text
    assert "color 3 size 3 at x=2..2 y=0..2" in text


# Floor 3, wall 4, player 9/c (2x2), timer b.
ROOM = """
4444444444444
4333333333334
4333333333334
4333c33333334
43339333333a4
4333333333334
4444444444444
bbbbbbbbbbbbb
"""


def _room(px: int, py: int, timer: int) -> Grid:
    rows = [list(r) for r in ROOM.split()]
    rows[3][4], rows[4][4] = "3", "3"
    rows[py][px], rows[py + 1][px] = "c", "9"
    rows[7] = list("3" * timer + "b" * (13 - timer))
    rows += [list("4" * 13)] * 5  # wall is the background
    return Grid.from_text("\n".join("".join(r) for r in rows))


def test_scene_sprites_and_regions() -> None:
    scene = build_scene(_room(4, 3, 0))
    kinds = {(o.kind, o.colors) for o in scene.objects}
    assert ("sprite", (9, 12)) in kinds
    assert ("region", (3,)) in kinds
    player = next(o for o in scene.objects if o.colors == (9, 12))
    assert player.pattern == ("c", "9")
    text = describe_scene(scene)
    assert "sprite 9,c size 2 at x=4..4 y=3..4" in text
    assert "rects: x=1..11 y=1..5" in text  # sprites count as floor


def test_scene_tracks_ids_and_moves() -> None:
    a = build_scene(_room(4, 3, 0))
    b = build_scene(_room(5, 3, 1), a)
    pid = next(o.id for o in a.objects if o.colors == (9, 12))
    assert b.get(pid) is not None and b.get(pid).bbox == (5, 3, 5, 4)  # type: ignore[union-attr]
    changes = scene_changes(a, b)
    moved = [c for c in changes if c.kind == "moved"]
    assert [(c.id, c.dx, c.dy) for c in moved] == [(pid, 1, 0)]
    assert not any(c.obj.colors == (3,) and c.obj.kind == "region" and c.kind == "changed"
                   and c.obj.bbox[1] < 6 for c in changes)  # floor shadow dropped
    assert f"obj#{pid} sprite 9,c moved (+1,+0)" in describe_changes(changes)


def test_carve_keeps_id_when_sprites_touch() -> None:
    a = build_scene(_room(9, 3, 0))
    b = build_scene(_room(10, 3, 0), a)  # touches the 'a' sprite at (11,4)
    pid = next(o.id for o in a.objects if o.colors == (9, 12))
    assert b.get(pid) is not None and b.get(pid).colors == (9, 12)  # type: ignore[union-attr]


def test_layout_tickers_player_and_moves() -> None:
    layout = Layout()
    plan = [("ACTION4", 5), ("ACTION4", 6), ("ACTION3", 5), ("ACTION1", 5), ("ACTION4", 6)]
    scene = build_scene(_room(4, 3, 0))
    for t, (action, x) in enumerate(plan, start=1):
        new = build_scene(_room(x, 3, t), scene)
        layout.observe(scene, new, scene_changes(scene, new), action)
        scene = new
    pid = layout.player_guess()
    assert pid is not None and scene.get(pid).colors == (9, 12)  # type: ignore[union-attr]
    assert pid not in layout.tickers()
    assert layout.tickers()  # the timer
    assert layout.step_size(pid) == 1
    text = layout.describe(scene)
    assert "ACTION4 (+1,+0) x3" in text and "ACTION1 no move x1" in text
    assert "ticker:" in text
    layout.reset()
    assert layout.steps == 0 and layout.player_guess() is None


def test_describe_around() -> None:
    grid = _room(4, 3, 0)
    scene = build_scene(grid)
    pid = next(o.id for o in scene.objects if o.colors == (9, 12))
    text = describe_around(grid, scene, pid, step=1)
    assert "up: 3 for 2 lines (2 steps), then 4 to the edge" in text
    assert "left: 3 for 3 lines (3 steps), then 4 to the edge" in text
    assert "down: 3 for 1 line (1 step), then 4 for 1 line (1 step), then b for 1 line" in text
    assert describe_around(grid, scene, 999) == "obj#999 not found"
