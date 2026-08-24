# Authoring `f` — the `.avo/score` contract

`f` is the only thing that tells the agent whether a variation was an improvement. Everything else
in `avocode` is bookkeeping around it. The contract below is **frozen**: `avo score`, `avo commit`,
`avo fan` and the supervisor all depend on it.

## Scaffold one

```sh
avo score --init hyperfine   # wall-clock time, lower is better
avo score --init pytest      # pass-rate from pytest, higher is better
avo score --init vitest      # pass-rate from vitest's JSON reporter, higher is better
avo score                    # run it
avo score --json | jq .      # the normalized attempt
```

`--init` is idempotent: an identical `.avo/score` is left untouched, and one that *differs* from the
template is never clobbered without `--force`.

## The interface

`.avo/score` is any executable, invoked from the repo root:

| Invocation | Must print | Purpose |
| --- | --- | --- |
| `.avo/score` | one JSON line | score everything |
| `.avo/score --configs` | config names, one per line | optional; enables `avo score --parallel` |
| `.avo/score --config <name>` | one JSON line | score a single config |

Config names must match `[A-Za-z0-9][A-Za-z0-9._-]*`. If `--configs` prints anything else (or
fails), `avo score --parallel` warns once and falls back to a single serial run — it never crashes.

**Always exit 0.** A build error, a failed test, a missing benchmark tool: all of these are
*results*, and the agent can only act on them if it receives them as data. Report them in the JSON.
(`avo score` tolerates a non-zero exit anyway and turns it into a failing attempt, but the JSON is
where the diagnosis has to live.)

## The JSON line

```json
{"ok":true,"correct":true,"primary":1668.2,"unit":"TFLOPS","higher_is_better":true,
 "scores":{"b1_s4096":1668.2,"b8_s1024":1421.7},"log":"...","duration_s":42.1}
```

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `ok` | boolean | yes | the *scorer itself* worked. `false` = the harness broke (no compiler, benchmark tool missing, build failed) — not a verdict on the candidate. |
| `correct` | boolean | yes | **the gate.** `false` can never become a commit (invariant 2). |
| `primary` | number \| null | yes | the metric. May be `null` when failing — nobody has to invent a number for a broken candidate. |
| `unit` | non-empty string | yes | `"s"`, `"TFLOPS"`, `"pass-rate"`, `"bytes"`, … humans read this. |
| `higher_is_better` | boolean | yes | direction of `primary`. |
| `scores` | object of numbers | no | the vector form of `f`, one entry per config. **This is what `avo commit` compares.** |
| `log` | string | no | diagnosis for the agent: the failing test name, the compiler error, the timing table. |
| `duration_s` | number ≥ 0 | no | how long scoring took. |

Extra fields are allowed and ignored, but reported as warnings — so a misspelled `higherIsBetter`
shows up as both "required field missing" *and* "unknown field", right next to each other.

## `correct` vs `primary` — get this split right

`correct` is a **gate**; `primary` is what you **optimize**. They are not the same axis, and
conflating them is the most common way to author a useless `f`.

- Optimizing a kernel: `correct` = numerics match the reference within tolerance; `primary` =
  throughput. A faster wrong kernel must never commit.
- Optimizing an eval pass-rate: the pass rate *is* the metric, so `correct` = "the suite is
  runnable at all" and `primary` = the fraction passing. If instead you want a green suite to be the
  gate, set `REQUIRE_ALL_PASS=true` in the pytest/vitest templates.
- Optimizing bundle size: `correct` = the app still builds and its tests pass; `primary` = bytes,
  `higher_is_better: false`.

If everything you care about is a hard gate, `primary` can be a constant — but then evolution has
no gradient to follow, and the supervisor will report a stall almost immediately.

## What `avo score` does with it

The scorer's line is validated, then normalized into an **attempt** (appended to
`.avo/attempts.jsonl`; attempts are not commits):

- `pass` = `ok && correct`. The single gate `avo commit` reads.
- `primary` becomes `null` — the **failing sentinel** — whenever `pass` is false. `null` rather than
  the paper's "zero score" because zero is the *best* possible value for a lower-is-better metric,
  so it cannot also mean failure.
- `normalized` = `primary` flipped so higher is always better; `null` compares worse than any
  number. Direction handling lives here, once, instead of in every consumer.
- With several configs, `primary` is their arithmetic mean — informative, but *not* the commit
  criterion; that is the `scores` vector.

Exit codes: `0` pass, `1` ran but failed, `2` harness error (no scorer, malformed output, timeout).
So `avo score >/dev/null || echo "no improvement"` behaves the way a shell reader expects, and
`avo score --json` is parseable in all three cases.

## Cost and honesty

Scoring runs on every variation, so it is the loop's dominant cost. Two rules:

1. **Make it fast enough to run constantly** — a scorer that takes 20 minutes turns a 200-attempt
   run into a week. Sample fewer configs by default and keep the expensive sweep behind a config
   name you only pass explicitly.
2. **Never let it be gameable.** The agent's job is to maximize `primary`; if it can do that by
   editing the benchmark, deleting a test, or special-casing an input, it eventually will. Keep the
   correctness check independent of the code under optimization, and treat any suspiciously large
   jump as a bug in `f` until proven otherwise.
