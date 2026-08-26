# `bench/` — a real target to point the loop at

Everything the CLI does is bookkeeping around `f`. `bench/` holds actual optimization problems with
actual `f`s, so the loop can be judged on a **curve** rather than on unit tests.

| Target | `f` | Direction | Candidate |
| --- | --- | --- | --- |
| [`fuzzysearch`](#fuzzysearch) | median ms per search, 2 configs | lower is better | `src/search.js` |
| [`arcagi3`](#arcagi3) | ARC-AGI-3 levels completed, 10 configs | higher is better | `src/policy.py` |

They are deliberately unalike. `fuzzysearch` is a speed problem whose answer is known and whose
ladder is hand-written, which makes it a good test of the *harness*. `arcagi3` is a capability
problem nobody has solved, where the candidate is a policy rather than a pure function — which makes
it a test of the *loop*. Each target declares its own `f` and its own protected set in
`avo/protected.txt`; `bench/init.sh --target <name>` picks one.

---

# How to run one

**Prerequisites.** `git`, `jq`, Node ≥ 22, and — for `arcagi3` only — Python ≥ 3.12. Plus a coding
agent (`claude`, `pi` or `codex`) for step 4. `avo doctor` tells you what is missing.

**`avo` must resolve as `avo`, not `./bin/avo`** — every wired skill calls it by bare name (#41).
From an uninstalled checkout, export it once per shell:

```sh
cd /path/to/avocode
export PATH="$PWD/bin:$PATH"      # or run ./install.sh once, which links it into ~/.local/bin
```

## fuzzysearch — the fast one (no setup at all, seconds per score)

```sh
# 1. materialize the target into ITS OWN git repo, outside this checkout
./bench/init.sh ~/work/fuzzysearch

# 2. see f work before spending an agent on it. No install step: the target has no dependencies,
#    only node and jq.
cd ~/work/fuzzysearch && .avo/score | jq .
#    -> {"ok":true,"correct":true,"primary":...,"unit":"ms","higher_is_better":false,...}

# 3. scaffold K, memory and the trajectory ignore (config + scorer already came with the target)
avo init    --cwd ~/work/fuzzysearch
avo install --cwd ~/work/fuzzysearch --agent claude     # wire the skills for your agent

# 4. the loop
avo run --cwd ~/work/fuzzysearch --agent claude \
  --prompt "make src/search.js faster without changing its results" \
  --max-iters 12 --timeout 900

# 5. read the curve, and check f was still f
./bench/verify-run.sh ~/work/fuzzysearch          # -> evidence/s9b-run.txt
./bench/init.sh --verify ~/work/fuzzysearch
```

## arcagi3 — the hard one (one setup step, ~20s per score)

```sh
# 1. materialize
./bench/init.sh ~/work/arcagi3 --target arcagi3

# 2. ONE EXTRA STEP the other target does not need: a .venv with the ARC-AGI-3 toolkit, and the
#    pinned game corpus. Needs the network once. Safe to re-run; `--check` reports what is missing.
cd ~/work/arcagi3 && ./bench/setup.sh

# 3. see f work
.avo/score | jq .
#    -> {"ok":true,"correct":true,"primary":0.277,"unit":"levels","higher_is_better":true,...}

# 4. scaffold, then loop. task.md ships with the target and carries the rules.
avo init    --cwd ~/work/arcagi3
avo install --cwd ~/work/arcagi3 --agent claude
avo run     --cwd ~/work/arcagi3 --agent claude \
  --prompt-file ~/work/arcagi3/task.md --max-iters 12 --timeout 900

# 5. the curve, then the two checks f cannot make about itself
./bench/verify-run.sh ~/work/arcagi3 --target arcagi3    # -> evidence/arcagi3-run.txt
./bench/init.sh --verify ~/work/arcagi3 --target arcagi3
```

Step 5 for `arcagi3` also scores the best committed version on **eight games it has never seen** and,
if `ARC_API_KEY` is set, against the **official** ARC-AGI-3 games. Both are `SKIP`ped rather than
faked when unavailable.

## While it runs

```sh
avo score   --cwd <target> --json | jq .     # what f says right now
avo best    --cwd <target>                   # what every candidate is ranked against
avo lineage --cwd <target>                   # P_t, the versions that survived
touch <target>/.avo/STOP                     # stop the loop cleanly after this turn
```

There is no `--max-cost` yet (#28). The cost knobs are `--max-iters`, `--timeout`, and `.avo/STOP`.

## When it does not work

| What you see | What it means |
| --- | --- |
| `is inside avocode (...)` | you pointed `bench/init.sh` into this checkout. Targets need their own repo — see below |
| `no such target 'x' (have: ...)` | typo in `--target`; the message lists what exists |
| `ok:false`, `... not installed in .venv` | `arcagi3` only: you skipped step 2. Run `bench/setup.sh` |
| `ok:false`, `jq not found` | install `jq`; the scorers pipe through it |
| `correct:false`, `a protected file changed` | something edited `f`. `git checkout -- <the named path>` |
| `correct:false`, `the game corpus does not match` | `bench/setup.sh --games-only` restores it |
| `avo: command not found` inside an agent turn | the `PATH` export above, or `./install.sh` |
| `avo run` exits having done nothing | no agent on `PATH`, or one that asks for permission — `avo doctor` |
| the curve is flat | that is the agent, not `f`: both targets ship a measured ladder proving headroom |

**Never materialize a target inside this checkout.** `avo commit` writes `Avo-Version` commits into
the repo it is pointed at, so a target living here would put the loop's entire lineage into avocode's
history and score a tree the loop is also editing. `bench/init.sh` refuses it outright.

---

## `fuzzysearch`

```sh
./bench/init.sh ~/work/fuzzysearch     # materialize the target into its OWN git repo
avo init --cwd ~/work/fuzzysearch      # K, memory, .avo/.gitignore (config + scorer come with it)
cd ~/work/fuzzysearch && .avo/score | jq .
```

```json
{"ok":true,"correct":true,"primary":356.0,"unit":"ms","higher_is_better":false,
 "scores":{"small":155.7,"large":556.4}}
```

**`fuzzysearch`** is thresholded edit-distance retrieval: every `(query, word)` pair in a seeded
pseudo-lexicon within Levenshtein distance `k`. `src/search.js` is the candidate — correct, and a
full DP matrix built out of nested arrays. Everything else is `f`. Two configs, not one, so the
commit rule compares a score *vector* and a change that only helps the small corpus has to prove it
does not hurt the large one.

**Its own repo, never this one.** `avo commit` writes `Avo-Version` commits into the repo it is
pointed at, so a target living inside this checkout would put the loop's entire lineage into
avocode's history and score a tree the loop is also editing. `bench/init.sh` refuses a destination
inside avocode outright.

### `correct` is three gates

| Gate | Catches |
| --- | --- |
| `.avo/gate.sha256` | the scorer, the reference, the corpus and the suite are byte-identical to the template |
| `node --test test/` | edge cases: empty inputs, `k=0`, exact distances, unicode, duplicates |
| `bench/run.js` | the candidate still matches an independent reference **on the input it is timed on**, and did not mutate its arguments |

The third is the expensive one — it runs the naive reference on every score — and it is the one that
earns its keep. `test/e2e-bench.sh` ships a candidate that passes the *entire* unit suite and
returns `[]` for any corpus over 1000 words; only gate 3 sees it. A unit suite runs on small
fixtures, so without a full-scale check, special-casing those fixtures buys a real score.

The hash gate is deliberately not oversold: it covers `.avo/score` itself, but an agent that edits
the scorer *and* the hash file defeats it from inside. `./bench/init.sh --verify <dest>` is the
external audit that does not, and it is the last thing to run after any loop:

```sh
./bench/init.sh --verify ~/work/fuzzysearch    # exit 1 if f was edited — the curve means nothing
```

### Headroom

A target with no room to improve proves nothing about the harness. `test/fixtures/fuzzysearch/`
holds six hand-written candidates along a known path — rolling `Int32Array` DP, a length prefilter,
prefix/suffix trimming, Ukkonen's band with a row-minimum early exit, a length-bucketed index, a
letter-set bitmask filter — and `test/e2e-bench.sh` replays them through `avo score` and
`avo commit`:

```
v1 -> v001  primary 144.3ms         v4 -> v004  primary 16.6ms
v2 -> v002  primary 70.4ms          v5 -> v005  primary 13.7ms
v3 -> v003  primary 69.2ms          v6 -> v006  primary 0.92ms

6 committed, 0 refused, of 6 steps       headroom walked: 356.0ms -> 0.92ms = 385.5x
```

Six committed versions, best score monotonically non-decreasing, and every recorded score
reproduces from its own commit within 3.2%. So when an agent's curve on this target comes out flat,
the target is not what is wrong.

### An agent on it

`bench/verify-run.sh <target-repo> [run-id]` turns a finished `avo run` into evidence: the curve
from `avo lineage`, the manifest's interventions and wall-clock, every recorded score re-measured
from its own commit, and `bench/init.sh --verify` last, because if `f` was edited the curve means
nothing.

```sh
avo run --cwd ~/work/fuzzysearch --agent claude \
  --prompt-file task.md --max-iters 12 --timeout 900
./bench/verify-run.sh ~/work/fuzzysearch      # -> evidence/s9b-run.txt
```

**`avo` must be resolvable as `avo`, not as `./bin/avo`** — the wired skills all begin with
`avo ...`, and nothing else supplies it ([#41](https://github.com/marcoscannabrava/avocode/issues/41)).
`./install.sh` is what makes that true; from an uninstalled checkout, prefix the command with
`PATH="$PWD/bin:$PATH"`.

`evidence/s9b-run.txt` is one such run: 6 iterations, 34m43s, four committed versions,
1810.4ms -> 0.345ms = **5255x**, zero supervisor interventions, `f` intact. Its third version is the
interesting one — a pigeonhole partition index that is *not* one of the six hand-written steps
above, reached by citing K's note that bucketing generalizes to any discrete filter key.

Those six live in `test/fixtures/`, not in `bench/fuzzysearch/` — `bench/init.sh` materializes every file
in the template directory, and a ladder stored there would hand the optimizer the answer.

Matmul was the first candidate and lost on measurement: flat `Float64Array`, i-k-j order, a
transposed operand, 64x64 tiling and a 2x-unrolled micro-kernel come to **1.7x** total, with most
steps inside the noise, because V8's JIT already does that work. A curve on that target would have
shown only that the commit rule refuses things.

---

## `arcagi3`

```sh
./bench/init.sh ~/work/arcagi3 --target arcagi3
cd ~/work/arcagi3 && ./bench/setup.sh   # a .venv with the ARC-AGI-3 toolkit + the pinned games
.avo/score | jq .                       # ~20s
avo init --cwd ~/work/arcagi3
```

```json
{"ok":true,"correct":true,"primary":0.277,"unit":"levels","higher_is_better":true,
 "scores":{"ez02":0.45,"tt01":0.264,"va01":0.258,"ul01":0.183,"fs01":0.108,
           "tp01":0.333,"nw01":0.3,"mm01":0.274,"ff01":0.3,"ff03":0.3}}
```

Play ten [ARC-AGI-3](https://arcprize.org/arc-agi/3) games from the pixels up. `src/policy.py` is the
candidate: a `Policy` class with an `act(frame)` called once per action. The shipped baseline is a
uniform random walk that never looks at the frame, scoring 0.277.

**Offline, deterministic, free.** The games run locally through `arc_agi.Arcade` in
`OperationMode.OFFLINE` — no API key, no network, ~40ms an episode — from a corpus pinned by commit
and hash to [`theredbluepill/arc-interactive`](https://github.com/theredbluepill/arc-interactive)
(MIT). That is what makes it usable as an `f` at all: `avo run` scores every iteration, so an `f`
that cost money or wandered would be unaffordable in both senses.

The metric is `max levels_completed / win_levels`, averaged over 24 rollouts. There is nothing finer
available — `FrameDataRaw` exposes `levels_completed` and `win_levels` and no per-step reward, and the
`score` field the toolkit docs describe does not exist on it.

### What the corpus selection cost

Three properties were required of every config, and each one disqualified a game worth naming:

| Requirement | Casualty | Why |
| --- | --- | --- |
| a non-zero baseline | `sq01` (0.025) | `avo commit` compares *relative* deltas, so a near-zero config swings ±100% on one level and vetoes every commit whatever `floor` says |
| exact reproducibility | `wm01` | Whack-a-Mole is real-time: 0.483, 0.533, 0.483 on three runs of identical code. A config that moves on its own lets the loop commit noise |
| not saturated | `ic02` (1.000) | no headroom is no gradient |

### Anti-gaming, in three layers

A policy has cheaper routes to a high score than playing well, so:

1. **the hash gate**, as fuzzysearch has, over `bench/run.py`, the contract suite, `bench/games.lock`
   and `.avo/protected.txt` itself;
2. **a sandbox** armed only while `act` runs, which refuses a policy that reads a game's source out of
   `bench/games/` or touches the network. It raises a `BaseException` *and* sets a flag the harness
   checks afterwards — an earlier version raised a plain `Exception`, and a policy wrapping its body
   in `except Exception: pass` swallowed the violation and scored a clean 0.26;
3. **the game's identity is withheld.** ARC-AGI-3 is about games you have not seen, so `bench/run.py`
   never tells the policy which game it is playing. Recognising one from its frames is fair; keying
   on an id is a lookup table.

Memorisation is the one thing `f` cannot catch from inside, because the training games live in the
target repo. Hence:

```sh
test/fixtures/arcagi3/score-holdout.sh ~/work/arcagi3   # 8 games the target has never seen
test/fixtures/arcagi3/score-api.sh ~/work/arcagi3       # the official games; needs ARC_API_KEY
./bench/verify-run.sh ~/work/arcagi3 --target arcagi3   # the curve, then both of the above
```

The holdout runs the target's *own* `bench/run.py` against a different corpus, so the numbers are
comparable. Four of its eight games pair with a training game (`ez04`/`ez02` are the same tutorial in
different directions, `fs03`/`fs01` the same mechanic with a different rule), and two are click games
because a holdout made only of movement games scored the baseline and an improved policy
*identically* — a holdout blind to the change under test measures nothing.

`score-api.sh` is the only thing here that touches the network, and it is never part of `f`: it is
slow, rate-limited, and its games can change under you. It refuses to run on an anonymous key rather
than quietly measuring something else, and it never prints the key.

### Headroom, demonstrated

The shipped ladder in `test/fixtures/arcagi3/` is two measured rungs, one of which must be refused:

```
aimed clicks      ff01 +64%, ff03 +64%, mm01 +17%, movement games rel: 0   -> committed  0.277 -> 0.320
cell-targeted     mm01 -100% (it hides its tiles in the background colour) -> refused
```

The first rung is the useful lesson about this target. `avo commit` uses `floor: 0.1`, and two
policies with *identical behaviour* that merely consume `rng` in a different order disagree by a
median of 6% per config — so a change touching the shared path is scored partly on luck. Aiming only
the click coordinates keeps the draw count and order identical, which makes the seven movement games
come back bit-identical and the click games move on their own merits. **Additive changes are scored
exactly; changes to the shared path have to beat the noise everywhere.**

Its holdout number says the win is real rather than remembered: 0.217 → 0.227, with `cs01` +38% and
`mm02` +19% on games the policy never saw.
