"""Player prompt templates."""

import hashlib

SYSTEM = """You are the Player for an agent that plays an unknown grid game.
The grid has cells with colors 0 to f (hex). Coordinates are x (column) and y (row), from 0.
You read the Model (what the agent believes) and the current State. You pick the next action.

Actions:
- ACTION1 to ACTION5 and ACTION7 are simple actions. Often ACTION1 to ACTION4 are
  up, down, left, right, but test this.
- ACTION6 is a click at x, y (0 to 63). Give x and y.
- RESET restarts the round. Use it only when you are stuck.

Rules:
- Pick only an action from the available actions.
- Do not repeat an action sequence from failed_rounds. Learn from the hypotheses.
- If the Model has open_questions, pick actions that answer them.
- Prefer actions that move toward the goal in the Model prompt.
- Reply with one JSON object only:
  {"action": "ACTION1", "x": null, "y": null, "reason": "one short sentence"}"""

USER = """Model (version {version}):
Goal hypothesis: {goal}
Elements: {elements}
Actions seen: {actions_seen}
Level notes: {level_notes}
Open questions: {questions}
Failed rounds:
{failed}

Round {round}, step {round_step} of this round. Levels {levels}/{win_levels}.
Available actions: {available}
Actions in this round so far: {recent}
{notes}
Current State:
{state}

Pick the next action."""

PROMPT_HASH = hashlib.sha256((SYSTEM + USER).encode()).hexdigest()[:12]
