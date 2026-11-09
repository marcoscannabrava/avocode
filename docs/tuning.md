# Tuning Log

This document records the tuning runs. Each run has a `--tag`. Use `./bench/arcagi3.py list` to see the same numbers for all runs.

## 1. Rules

- Tune the prompts and the perception output. Do not change the loop for one game.
- Give each run the tag `m8` and one tag for the change.
- Record the score, the steps per level, and the cost for each prompt hash.
- The prompt hash covers only the prompt text. A perception change does not change the hash. So also record the git commit.

## 2. Setup

| Item | Value |
|---|---|
| Game | `ls20` (7 levels, keyboard, 4 actions) |
| Budget | 100 actions, 1 round |
| LLM | OpenAI: Player `gpt-6-luna` (effort low), Scorer `gpt-6.1-sol` (effort medium) |
| Human baseline | 22 actions for level 1, 123 actions for level 2 (from `metadata.json`) |

## 3. Runs on `ls20`

| Run | Tag | Git | Prompts (Player/Scorer) | Levels | Steps for level 1 | Cost | Scorer share of cost |
|---|---|---|---|---|---|---|---|
| `20261109-215211-a3e81a3` | none, 60 actions | `a3e81a3` | `9b1b97`/`cce6f7` | 1/7 | 27 | not known | not known |
| `20261109-230247-9b16e07` | `baseline` | `9b16e07` | `9b1b97`/`cce6f7` | 1/7 | 70 | $1.23 | 97% |
| `20261109-230613-0928398` | `hud-shapes` | `0928398` | `0a37f4`/`f39321` | 1/7 | 27 | $1.58 | 97% |
| `20261109-232501-630903c` | `turns-norepeat` | `630903c` | `0ad44d`/`f39321` | 1/7 | 26 | $1.57 | 98% |

## 4. Changes and Results

### 4.1 `hud-shapes`

Changes:

- Prompt hints for both LLMs: a bar that shrinks is often a step limit, a row of small equal sprites often counts lives, and a HUD pattern often shows what a board object must match.
- The Scorer names a moving element by its colors and shape, not by its position.
- The Player must not send `RESET` directly after a `RESET` (see `docs/data-model.md`, section 1).
- Perception writes `same shape` lines (see `docs/perception.md`, section 6a).

Result:

- Level 1 took 27 steps. The baseline took 70 steps. But the older run with the old prompts also took 27 steps. So this gain can be noise.
- The Model found the rule of level 2 by itself: "Transform the HUD pattern using board modifiers, then enter the framed goal."
- The agent did not complete level 2. The shape line said "mirrored left-right". The real change was a turn of 90 degrees, and the board modifier turns the HUD key. So the agent touched the modifier too many times.
- At steps 54 to 56, the Player sent the same blocked move three times.

### 4.2 `turns-norepeat`

Changes:

- The shape line names a turn first. It names a mirror only when no turn fits.
- The Player prompt says "Last 30 of N actions", not "so far".
- The Player prompt says: after a Note about a State seen before, do not send the same action again from the same place.

Result:

- Level 1 took 26 steps.
- After step 11, there was no `repeat_state` warning. The other two runs had 4 and 7 of them. The rule against repeats works.
- The Model knew the rule of level 2: "Match the bottom-left HUD pattern to the framed target, then enter the target before the resource bar expires."
- The agent did not find a route to the turn modifier in time. It lost all lives at step 92. The loop sent `RESET`, and level 2 started again with `levels_completed` 1. This agrees with `docs/data-model.md`, section 1.

## 5. Findings

- The Scorer is 97% of the cost. It uses `gpt-6.1-sol`. The Player uses `gpt-6-luna`. A cheaper Scorer model is the largest cost change. Test it before the next prompt change.
- Route finding is now the main problem on `ls20`, not the rules. The agent knows the goal but uses too many steps to reach a target. The next perception change: give the shortest path, in actions, from the player guess to each sprite. Use the moves of each action from the Layout and the cells the player can enter.
- One run per change is not enough. The baseline prompts gave 27 steps and 70 steps for level 1 in two runs. Use two or more runs for each change before you keep it.
