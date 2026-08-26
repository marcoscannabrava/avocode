# arcagi3 — an `avocode` optimization target

Play ten [ARC-AGI-3](https://arcprize.org/arc-agi/3) games you have never seen, from the pixels up.

```python
# src/policy.py
class Policy:
    def __init__(self, action_space, rng): ...
    def act(self, frame): return action, data   # once per action, until the budget runs out
```

`src/policy.py` is a uniform random walk that never looks at the frame it is handed. It scores
**0.277**. **Make it better.**

## The objective

`f` is `.avo/score`: **the mean fraction of levels completed, per game, higher is better.**

```sh
.avo/score | jq .          # all ten configs, about 20 seconds
avo score --json | jq .    # the same thing, normalized into an attempt
avo score --parallel       # one process per game
```

There is no per-step reward to climb. The engine's `FrameDataRaw` carries `levels_completed` and
`win_levels` and nothing finer — no `score` field, whatever the toolkit docs say — so a config's
score is `max levels_completed reached / win_levels`, averaged over `ROLLOUTS` rollouts.

**Ten configs, because `avo commit` compares the score *vector*.** A policy that learns one game at
the expense of another cannot commit, and dropping a game to look good is refused outright. The
baseline, per config:

| ez02 | tt01 | va01 | ul01 | fs01 | tp01 | nw01 | mm01 | ff01 | ff03 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| .450 | .264 | .258 | .183 | .108 | .333 | .300 | .274 | .300 | .300 |

Nothing here is saturated, nothing sits at zero, and nothing is timed — all three on purpose, and
each one cost a game. A config at zero swings ±100% when it moves by one level on one rollout, and
since `avo commit` compares *relative* deltas, one such config would veto every commit whatever
`floor` said (that was `sq01`). And a real-time game is not reproducible: Whack-a-Mole scored 0.483,
0.533, 0.483 on three consecutive runs of identical code, which would let the loop commit pure noise
(that was `wm01`). Every game left is frame-counted and exact.

## The one thing worth knowing before you start

`.avo/config.json` sets `reduce: "dominate"` and `floor: 0.1`: a commit needs at least one config to
improve by more than 10% and **none** to regress by more than 10%.

That floor is measured, not guessed. Two policies with *identical behaviour* that merely consume
`rng` in a different order disagree by a median of 6% per config (18% at 8 rollouts, which is why
`ROLLOUTS` is 24). Any change to how you draw from `rng` reshuffles every trajectory, so a change
that touches the shared path is scored partly on luck.

The practical consequence, and the most useful thing on this page:

> **A change that leaves other configs' `rng` consumption untouched is scored exactly, not
> approximately.**

The shipped ladder is built that way. Aiming *only* the click coordinates — same number of draws,
same order, different values — makes the seven movement games come back **bit-identical** (`rel: 0`)
while the click games move on their own merits:

```
ff01  0.300 -> 0.492   +64%
ff03  0.300 -> 0.492   +64%
mm01  0.274 -> 0.321   +17%
the seven movement games   rel: 0
=> committed, primary 0.277 -> 0.320
```

Whereas drawing clicks from the non-background cells *themselves* rather than their bounding box is
refused, because `mm01` hides its tiles in the background colour and loses everything:

```
mm01  0.321 -> 0.000  -100%   => refused: a win on one config cannot pay for a loss on another
```

If you genuinely need a change that touches every trajectory, it has to beat 10% across the board.
Prefer additive changes until you run out of them.

## Rules

**You may change `src/`.** Add modules, keep state on the `Policy` instance, build a world model —
as long as `Policy` keeps its constructor (`action_space`, `rng`, both by keyword) and its `act`.

**What the policy is given:** the action space, a seeded `random.Random`, and per step a frame with
`frame` (a list of numpy `(64, 64)` `int8` grids), `state`, `levels_completed`, `win_levels`,
`available_actions`.

**What it is not given: the game's identity.** ARC-AGI-3 is a benchmark about games you have not
seen. A policy keyed on the game id is a lookup table, so `bench/run.py` does not pass one. You may
of course *recognise* a game from its frames — that is perception, and it is the job.

**Three things will fail you outright**, all enforced while `act` runs:

| | |
| --- | --- |
| reading a game's source under `bench/games/` | you are meant to perceive the game, not read it |
| any network access | there is nothing out there you are allowed to ask |
| an illegal action, or a click with no `x`/`y` | the contract |

The sandbox raises a `BaseException`, not an `Exception`, and also records a flag the harness checks
after `act` returns — an earlier version raised a plain `Exception` and a policy wrapping its body
in `except Exception: pass` swallowed the violation and scored a clean 0.26.

**Everything else is `f` and is off limits:**

| Path | What it is |
| --- | --- |
| `bench/run.py` | the episode harness, the metric, and the sandbox |
| `bench/games/` | the ten pinned games (hash-locked, not templated) |
| `bench/games.lock` | what those games must hash to |
| `bench/setup.sh` | the venv and the corpus fetch |
| `test/test_policy.py` | the policy contract suite |
| `requirements.txt` | the pinned toolkit — its version decides what the games do |
| `.avo/score` | `f` itself |
| `.avo/protected.txt` | the list above, which is why it is on it |

Their hashes are in `.avo/gate.sha256`; touch one and every score comes back `correct: false` with
the path named, which can never commit. `bench/init.sh --verify` re-checks it from outside the repo,
where an agent that also edited the gate cannot reach.

## Setup

```sh
bench/setup.sh          # .venv + the pinned corpus; safe to re-run
bench/setup.sh --check  # what is missing?
.avo/score | jq .
```

Needs Python ≥ 3.12 (`arc-agi` requires it) and `git`. The games are fetched from
[`theredbluepill/arc-interactive`](https://github.com/theredbluepill/arc-interactive) (MIT) at a
pinned commit and verified against `bench/games.lock` — both by `setup.sh` and again by `.avo/score`
on every run.

Neither `.venv/` nor `bench/games/` is committed, so neither is ever part of a candidate's diff.

## What `correct` means here

In order, all in `.avo/score`:

1. the protected files hash to what `bench/init.sh` recorded;
2. the toolkit and corpus are installed — a missing venv is `ok: false`, not a bad score;
3. `bench/games/` hashes to `bench/games.lock`;
4. `test/test_policy.py` passes — constructible, legal actions, clicks carry coordinates,
   reproducible for a fixed seed, tolerates numpy frames, survives a one-action game;
5. every episode ran without the policy breaking the contract or reaching outside its frames.

Point 4 is not ceremony. The suite's fake frame hands over real numpy arrays because an earlier
version used nested lists, and a policy that compared two frames with `==` passed the suite and then
died on the real thing with *"truth value of an array is ambiguous"*. A fake easier to satisfy than
the real interface is worse than no fake.

## Beyond `f`

`f` measures ten games that live in this repo, so it cannot tell a policy that learned to play from
one that memorised ten games. Two checks exist outside it, in the avocode checkout:

```sh
test/fixtures/arcagi3/score-holdout.sh <this-repo>   # eight games this repo has never seen
test/fixtures/arcagi3/score-api.sh <this-repo>       # the official games, needs ARC_API_KEY
```

The holdout runs *this repo's own* `bench/run.py` against a different corpus, so the two numbers are
comparable. For the shipped ladder it says the improvement is real rather than remembered:

```
                    train    holdout
baseline            0.277    0.217
aimed clicks        0.320    0.227     cs01 +38%, mm02 +19%, movement games bit-identical
```

`bench/verify-run.sh --target arcagi3` runs both after a loop finishes.
