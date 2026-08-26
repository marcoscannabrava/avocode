# `bench/` — a real target to point the loop at

Everything the CLI does is bookkeeping around `f`. `bench/` holds an actual optimization problem
with an actual `f`, so the loop can be judged on a **curve** rather than on unit tests.

---

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

