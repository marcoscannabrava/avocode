# Perception: Objects, Changes, HUD, and Surroundings

This document tells how `avocode/perception/` turns a grid into short text for the Player and the Scorer.

## 1. Problem

The prompts now contain the full grid as hex rows. A 64x64 grid is 4096 characters. The Scorer gets two grids for each call.

The LLM cannot read this text well:

- The tokenizer joins runs of digits, such as `4444`, into one token. The LLM cannot count columns, so it cannot find the color at x=21.
- The crop does not help when a HUD or a frame touches the grid edge.
- The LLM must find objects and changes itself. It often makes mistakes. In `ls20`, it named the wrong sprite as the player.

## 2. Solution

Code finds the objects, tracks them, and writes the result as text. The LLM reads objects and changes, not cells.

There are six parts:

| Part | Module | Output |
|---|---|---|
| Objects | `scene.py` | Objects with IDs that stay the same from frame to frame |
| Changes | `changes.py` | Object events, such as `obj#7 moved (+0,-5)` |
| HUD | `layout.py` | History of steps. Objects that change on all steps, and moves for each action |
| Surroundings | `around.py` | What is next to an object in each of the four directions |
| Shapes | `shapes.py` | Sprites that have the same shape at another scale, rotation, or color |
| Tracker | `tracker.py` | Keeps the scene and the history for one game. Writes the prompt text. |

All parts use only `core`. Section 7 tells how the prompts use them.

## 3. Objects (`scene.py`)

### 3.1 Find the objects

1. Find the background. It is the most common color.
2. Find the blobs of each color with `find_blobs()`.
3. Sort the blobs into two groups:
   - A **region** is a large blob. Its box is more than 10 cells wide or high. Floors, walls, and bars are regions.
   - A **sprite** is a small blob.
4. Join sprites that touch each other into one sprite, if both conditions are true:
   - The joined box is 10x10 or smaller.
   - The larger sprite is at most 4 times the size of the smaller one.

   A sprite can have more than one color. For example, the `c/9` player in `ls20` is one sprite (10 and 15 cells). A small floor and the player on it stay two objects (18 and 1 cells).

### 3.2 Write the objects as text

- A sprite shows its cells as a small pattern. A dot (`.`) is a cell that is not part of the sprite.

  ```
  obj#7 sprite colors c,9 size 25 at x=34..38 y=45..49
    ccccc
    ccccc
    99999
    99999
    99999
  ```

- A region shows its cells as a list of rectangles, largest first. The rectangles can overlap. A cell below a sprite counts as part of the region, so a sprite does not cut a hole in the floor. The list stops at 8 rectangles.

  ```
  obj#0 region color 3 size 892 at x=14..53 y=8..49
    rects: x=14..53 y=25..29, x=14..28 y=30..39, ...
  ```

### 3.3 Track the objects

`build_scene(grid, prev)` gives each object an ID. If `prev` is a scene, the function tries to use the old IDs:

1. Find each old sprite in the new grid, at most 10 cells from its old position. The nearest fit wins. A fit must have the same cells, and the sprite colors must not continue past its edge. The sprite keeps its ID, and no other object can use its cells.
2. Find the other objects. A found sprite connects the parts of a region on each side of it. Thus a player in a corridor does not cut the floor in two.
3. Match the other sprites with the same colors and the same pattern. The nearest one wins.
4. Match the other objects with the same colors and the most overlap of boxes. An object can change from sprite to region, for example a bar that grows.
5. Give a new ID to each object that has no match.

Step 1 keeps the ID of a player that touches another sprite. Without it, the two sprites join into one new object.

## 4. Changes (`changes.py`)

`scene_changes(old, new)` compares two scenes and gives a list of events:

| Event | When |
|---|---|
| `moved` | Same ID, same pattern, different position. Gives `dx, dy`. |
| `changed` | Same ID, different pattern or size. Gives the old size and the new size. |
| `appeared` | The ID is only in the new scene. |
| `vanished` | The ID is only in the old scene. |

A sprite that moves also changes the object below it, such as the floor. This is not a real change, so the function does not report it. It reports a `changed` event only if some changed cells are outside the old and new boxes of the moved sprites.

`describe_changes(changes, tickers)` writes one line for each event. It puts the events of ticker objects (section 5) on one last line, so they do not hide the important events:

```
obj#6 sprite 9,c moved (+0,-5) to x=34..38 y=40..44
tickers (change on every step): obj#4 region b changed size 84 -> 82, ...
```

## 5. HUD (`layout.py`)

A `Layout` keeps a history of the steps in one level. Call `observe(old, new, changes, action)` after each step.

It records:

- The number of steps.
- For each object ID: the steps in which it changed, and the actions in those steps.
- For each action and object: the moves `(dx, dy)` that the action caused.

From this history, it finds:

- **Tickers.** An object that changed in at least 80% of the steps since it appeared (at least 3 steps), for at least 2 different actions, and never moved. A timer or a move counter is a ticker.
- **The player.** The sprite that moved most often.
- **Action moves.** For each action, the most common move of the player. For example, `ACTION1 -> (+0,-5)`.

`describe(scene)` writes this as text:

```
history: 20 steps in this level
ticker: obj#4 region b at x=30..54 y=61..62, size 50, -2.0 cells per change
player guess: obj#6 (moved in 17 of 20 steps)
moves of obj#6: ACTION1 (+0,-5) x8, no move x2; ACTION2 (+0,+5) x4; ACTION3 (-5,+0) x4, no move x1
```

`tickers()` gives the IDs for `describe_changes()`. `step_size(obj_id)` gives the most common move length for `describe_around()`.

Call `reset()` when a level starts. The objects on the grid are then different. Keep the history when a round restarts on the same level, as the actions do the same things.

## 6. Surroundings (`around.py`)

`describe_around(grid, scene, obj_id, step)` looks out from each side of the object. It looks at a strip that has the same width (or height) as the object.

For each direction, it reads the strip row by row (or column by column) and joins rows that are the same:

```
around obj#6 at x=19..23 y=25..29 (step 5):
  up: 4 to the edge
  down: 3 for 1 line (0.2 steps), then mixed (obj#0, obj#12) for 3 lines (0.6 steps), ...
  left: 3 for 5 lines (1 step), then 4 for 10 lines (2 steps), then 5 to the edge
  right: 3 for 30 lines (6 steps), then 4 to the edge
```

- A line of only one color shows that color.
- A line with more than one color shows `mixed` and the IDs of the objects in it.
- The text stops after 4 runs.
- `step` is the size of one move, from the Layout. If it is known, the text also gives the distance in steps.

This helps the Player in games where a sprite moves on a floor.

## 6a. Shapes (`shapes.py`)

Many games show a pattern in the HUD that a board object must match. In `ls20`, the HUD shows a key. The door opens only when the key has the same shape as the door. The key is two times larger than the door.

`shape_text(scene)` finds these pairs:

1. For each sprite, it makes one mask for each color.
2. It skips masks with fewer than 3 cells, and masks that are full rectangles. Full rectangles match too often.
3. It shrinks each mask: each k-by-k block becomes one cell, if all blocks are full or empty (k is 2 to 4).
4. It puts masks in one group if one mask is the same as the other after a turn or a mirror.
5. It writes one line for each group with two or more objects.

```
same shape: obj#3 color 9 (2x larger), obj#7 color 9 (mirrored left-right)
```

The names of the turns and mirrors compare each object with the first object of the group. When the two shapes are equal, the line has no turn name:

```
same shape: obj#3 color 9 (2x larger), obj#8 color 9
```

On `ls20`, the first line shows at level start. The second line shows after the player touches the `0,1` sprite, one step before the level is complete.

## 7. Prompts (`tracker.py`)

`GameSession` keeps one `Tracker` for each game:

| Session event | Tracker call |
|---|---|
| First State | `update(grid)` |
| State after an action | `update(grid, action.name, new_level)`. `new_level` is true if `levels_completed` went up. |
| State after a RESET of a failed round | `update(grid)`. This keeps the history and does not record the jump back. |

The Tracker gives two texts:

- `objects_text()`: the objects, the shape groups, the history, and the surroundings of the player guess.
- `changes_text()`: the events of the last step, with tickers on one line.

The prompts use them as follows:

| Prompt | Before | Now |
|---|---|---|
| Player | blobs and the hex grid | `state_header()` and `objects_text()` |
| Scorer | blobs and the hex grid for the previous State and the current State, and a cell diff | `state_header()`, `objects_text()`, and `changes_text()` |

The system prompts tell how to read the objects. There is no hex grid in the prompts now.

If the caller gives no Tracker text, the Player and the Scorer make it from the State. Then there is no history. The tests use this.

On step 9 of `ls20`, the Player State text drops from 5172 to 2045 characters. The Scorer text drops from about 10300 to 2300 characters.

## 8. Tests

`tests/test_perception.py` tests each part on small hand-made grids.

The examples in this document come from a replay of 20 steps of `ls20`. On that replay, the player keeps one ID for all steps. One step takes about 3 ms.
