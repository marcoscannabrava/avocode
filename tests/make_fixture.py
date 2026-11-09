"""Write the toy fixture run.

Run: uv run python -m tests.make_fixture
"""

from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path
from typing import Any

from avocode.config import Settings
from avocode.engine.toy import SOLUTIONS, ToyEngine
from avocode.llm.fake import FakeLLM
from avocode.ports import LLMClient, LLMRequest, Role
from bench.runner import Runner, RunSummary

FIXTURE_RUNS = Path(__file__).parent / "fixtures" / "runs"

# Round 1 hits the wall. Round 2 wins.
PLAYER_MOVES = ["A4", "A1", *SOLUTIONS[0], "A2", "A1", *SOLUTIONS[1]]


def player_script() -> list[dict[str, Any]]:
    out = []
    for move in PLAYER_MOVES:
        if move.startswith("A6@"):
            x, y = move[3:].split(",")
            out.append({"action": "ACTION6", "x": int(x), "y": int(y),
                        "reason": "Click the button to open the door."})
        else:
            out.append({"action": "ACTION" + move[1], "reason": f"Test {move}."})
    return out


def scorer_reply(req: LLMRequest) -> dict[str, Any]:
    failed = "This round FAILED" in req.user
    reply: dict[str, Any] = {
        "element_breakdown": {"6": "player", "5": "wall", "4": "goal", "3": "button",
                              "2": "door"},
        "allowable_actions": {"ACTION1": "up", "ACTION2": "down", "ACTION3": "left",
                              "ACTION4": "right", "ACTION6": "click; button opens doors"},
        "prompt": "Move the player (6) to the goal (4). Do not touch walls (5).",
        "level_notes": [],
        "failed_rounds": [],
        "open_questions": [],
        "summary": "updated beliefs",
    }
    if failed or not re.search(r"^Round 1,", req.user, re.MULTILINE):
        reply["failed_rounds"] = [{"round": 1, "actions": ["A4", "A1"], "last_state": "dead",
                                   "hypothesis": "Moving into a wall (5) ends the game."}]
    if failed:
        reply["summary"] = "walls kill"
    if re.search(r"Levels [12]/2", req.user):
        reply["level_notes"] = ["Level 1: go down, right, then up to the goal."]
    return reply


def build(runs_dir: Path, run_id: str = "toy") -> RunSummary:
    settings = Settings.load(env={}, llm="fake", runs_dir=str(runs_dir), max_actions=60,
                             max_rounds=5, tags=["fixture"])
    player = FakeLLM(player_script())
    scorer = FakeLLM(default=scorer_reply)

    def make_llm(role: Role) -> LLMClient:
        return player if role == "player" else scorer

    runner = Runner(settings, lambda game: ToyEngine(game), make_llm, run_id=run_id,
                    argv=["--games", "toy"], git={"commit": "fixture", "dirty": False})
    return runner.run(["toy"])


def main() -> None:
    target = FIXTURE_RUNS / "toy"
    if target.exists():
        shutil.rmtree(target)
    FIXTURE_RUNS.mkdir(parents=True, exist_ok=True)
    summary = build(FIXTURE_RUNS)
    latest = FIXTURE_RUNS / "latest"
    if latest.is_symlink():
        latest.unlink()
    result = summary.results[0]
    print(f"wrote {summary.run_dir}: {result.outcome.value}, {result.steps} steps")
    sys.exit(0 if result.outcome.value == "won" else 1)


if __name__ == "__main__":
    main()
