import pytest

from avocode.core import Action, FailedRound, GameModel, Grid, State


def test_grid_from_text_and_hex() -> None:
    grid = Grid.from_text("012\n3ab")
    assert (grid.width, grid.height) == (3, 2)
    assert grid.at(2, 1) == 11
    assert Grid.from_hex(grid.to_hex(), 3, 2) == grid


def test_grid_size_check() -> None:
    with pytest.raises(ValueError):
        Grid(2, 2, (0, 0, 0))


def test_state_is_hashable() -> None:
    grid = Grid.from_text("01\n10")
    a = State((grid,), "NOT_FINISHED", 0, 2, ("ACTION1",))
    b = State((grid,), "NOT_FINISHED", 0, 2, ("ACTION1",))
    assert len({a, b}) == 1
    assert a.grid is grid


@pytest.mark.parametrize(
    ("text", "name", "x", "y"),
    [("A1", "ACTION1", None, None), ("A6@12,40", "ACTION6", 12, 40), ("RESET", "RESET", None, None),
     ("ACTION3", "ACTION3", None, None), (" a7 ", "ACTION7", None, None)],
)
def test_action_parse(text: str, name: str, x: int | None, y: int | None) -> None:
    action = Action.parse(text)
    assert (action.name, action.x, action.y) == (name, x, y)


def test_action_short_round_trip() -> None:
    for text in ["A1", "A6@0,63", "RESET", "A5"]:
        assert Action.parse(text).short == text


@pytest.mark.parametrize("text", ["A8", "A6", "A1@1,2", "A6@64,0", "JUMP"])
def test_action_parse_rejects(text: str) -> None:
    with pytest.raises(ValueError):
        Action.parse(text)


def test_model_changes() -> None:
    old = GameModel(element_breakdown={"1": "wall"})
    new = old.model_copy(deep=True)
    new.element_breakdown["2"] = "player"
    new.failed_rounds.append(FailedRound(round=1, hypothesis="hit wall"))
    new.version = 5
    assert new.changes_from(old) == ["element_breakdown.2", "failed_rounds"]
    assert old.changes_from(old.model_copy(update={"version": 9})) == []
