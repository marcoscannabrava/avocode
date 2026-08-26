# Task

Improve `src/policy.py` so that `.avo/score` reports a higher `primary`.

`primary` is the mean fraction of ARC-AGI-3 levels completed across ten games. The baseline is a
uniform random walk scoring 0.277; it never looks at the frame it is handed.

**Read `README.md` first.** It carries the measured facts that decide whether a change can commit at
all — in particular that `avo commit` compares the score *vector* with `floor: 0.1`, and that a change
leaving other configs' `rng` consumption untouched is scored exactly rather than partly on luck. The
two shipped examples (one committed, one refused, both real measurements) are the fastest way to see
what that means.

Then run the loop the `avo-vary` skill describes:

1. `avo know query "..."` / `avo lineage` — what has already been tried here, and why it was refused.
2. Change `src/`. Only `src/`; everything else is `f` and hashed.
3. `avo score --json | jq .` — read `.log`, which names the failing gate when `correct` is false.
4. `avo commit --why "..."` — it decides, not you. A refusal with its reason is information; record it
   with `avo mem add` so the next turn does not earn it again.

Useful things to know before guessing:

- The frames are numpy `(64, 64)` `int8` arrays, so `a == b` is an array, not a bool. Use
  `np.array_equal`.
- You are not told which game you are playing. You may work it out from the frames.
- Reading the game sources under `bench/games/`, or touching the network, fails the run outright.
- `.avo/score --config <game>` scores one game — much faster than the full vector while you iterate on
  a single mechanic.
