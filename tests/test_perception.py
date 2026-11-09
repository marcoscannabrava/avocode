from avocode.core import Grid, State
from avocode.perception import (
    background_color,
    describe_diff,
    encode_grid,
    find_blobs,
    grid_diff,
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
