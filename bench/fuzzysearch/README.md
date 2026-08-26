# fuzzysearch — an `avocode` optimization target

Find every `(query, word)` pair in a word list whose **Levenshtein distance** is at most `k`.

```js
import { search } from "./src/search.js";

search(["cat", "dog"], ["cat", "cot", "dig"], 1);
// [ {query:"cat", match:"cat", distance:0},
//   {query:"cat", match:"cot", distance:1},
//   {query:"dog", match:"dig", distance:1} ]
```

`src/search.js` is correct and slow. **Make it faster.** Result order is yours to choose; the gate
compares result *sets*.

## The objective

`f` is `.avo/score`: **median milliseconds per search, lower is better**, over two configs.

```sh
.avo/score | jq .          # both configs
avo score --json | jq .    # the same thing, normalized into an attempt
```

Two configs (`small`, `large`) rather than one, because `avo commit` compares the score *vector*: a
change that only helps one size has to prove it does not hurt the other. `.avo/config.json` sets
`floor: 0.03`, so a move under 3% counts as neither better nor worse — that is measurement noise on
this workload, and noise must neither commit nor block.

## Rules

**You may change `src/`.** Add files, split the module, rewrite it from scratch — as long as
`src/search.js` still exports `search(queries, corpus, k)`.

**Everything else is `f` and is off limits:**

| Path | What it is |
| --- | --- |
| `bench/reference.js` | an independent implementation, used only to check yours |
| `bench/corpus.js` | the workload (deterministic, seeded) |
| `bench/run.js` | the timing harness and the full-scale correctness check |
| `test/search.test.js` | the correctness suite |
| `.avo/score` | `f` itself |

Their hashes are recorded in `.avo/gate.sha256`. Touch one and every score comes back
`correct: false` with the path named — which can never commit (avocode invariant 2). This is not a
trust exercise: `f` measures the candidate, and a candidate that can edit `f` is measuring itself.
`bench/init.sh --verify` re-checks all of it from outside the repo.

## What `correct` means here

Three gates, in order, all in `.avo/score`:

1. the protected files hash to what `bench/init.sh` recorded;
2. `node --test test/` passes — edge cases, unicode, empty inputs, exact distances;
3. `bench/run.js` confirms the candidate still agrees with `bench/reference.js` **on the exact input it
   is about to be timed on**, and did not mutate its arguments.

Gate 3 matters most. The unit suite runs on small fixtures, so without a full-scale check,
special-casing those fixtures would buy a real score. Being fast and wrong scores nothing.

## Run it

```sh
npm test                            # the correctness suite
node bench/run.js --config large    # one config, JSON
.avo/score | jq .                   # f
avo score && avo commit --why "..." # let the commit rule decide whether it was progress
```

No dependencies beyond `node` (≥18, for `node --test`) and `jq`.
