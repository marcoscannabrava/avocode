"""Status from the game state."""

from avocode.core.state import State, Status


def status_from_state(state: State) -> Status:
    """WIN is success, GAME_OVER is failed."""
    if state.game_state == "WIN":
        return Status.SUCCESS
    if state.game_state == "GAME_OVER":
        return Status.FAILED
    return Status.ONGOING
