---
name: avo-score
description: The `f` contract in avocode — run `avo score` to measure a candidate, read its JSON, and author or repair a `.avo/score` scorer. Use when a repo needs a fitness function, when `avo score` reports a harness error or a malformed scorer, when choosing what to measure, or when adding parallel scoring configs.
---

# avo score — the `f` contract

`f` is a single executable, `.avo/score`, run from the repo root. It is the only thing that decides
whether a candidate is better, so it is frozen: change its *meaning* and every earlier version in the
lineage becomes incomparable.

## Run it

```bash
avo score                    # human-readable
avo score --json             # one normalized JSON line — this is what avo commit reads
avo score --parallel         # fan the configs out concurrently (needs `--configs` support)
avo score --timeout 600      # kill a runaway scorer after 600s
```

Exit codes: `0` pass, `1` ran but failed (a real measurement — a failing candidate), `2` harness error
(no scorer, malformed output, timeout — fix the harness, not the candidate).

Every run appends one attempt to `.avo/attempts.jsonl`. **Attempts are not commits**; the log is
gitignored trajectory, not lineage.

## The contract

`.avo/score` prints **one line of JSON to stdout** and should **always exit 0** — a failure belongs
*in* the JSON, so you receive a diagnosable payload instead of a crash.

```json
{"ok":true,"correct":true,"primary":1668.2,"unit":"TFLOPS","higher_is_better":true,
 "scores":{"b1_s4096":1668.2,"b8_s1024":1421.7},"log":"...","duration_s":42.1}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `ok` | yes | the scorer itself worked (it built, it ran) |
| `correct` | yes | **the gate** — the candidate is actually right |
| `primary` | yes | `number \| null`; the headline scalar, for humans |
| `unit` | yes | non-empty string, e.g. `TFLOPS`, `s`, `%` |
| `higher_is_better` | yes | direction of `primary` and of every entry in `scores` |
| `scores` | no | per-config vector — **this is what the commit rule compares** |
| `log` | no | build/test output, for diagnosis |
| `duration_s` | no | wall-clock of the scoring run |

Unknown fields are allowed but warned about, so a misspelled `higherIsBetter` reads as both "required
field missing" and "unknown field".

**`ok:false` or `correct:false` ⇒ `primary` becomes `null`**, whatever was measured. `null`, not zero,
because zero is the *best* value for a lower-is-better metric and so cannot also mean failure.
`avo score` adds a `normalized` field — `primary` flipped so higher is always better — so nothing
downstream branches on direction.

## Scaffold one

```bash
avo score --init hyperfine     # wall-clock benchmark
avo score --init pytest        # python test pass rate
avo score --init vitest        # js/ts test pass rate
avo init --scorer hyperfine    # same thing, during setup
```

`--init` writes a commented, working scorer — the authoring guide in executable form, so read the file
it produces. Start from a template rather than hand-rolling: the failure sentinel (`primary: null`,
not `0`) and the "always exit 0" rule are what hand-rolled scorers get wrong. `avo score --init <t>
--force` replaces an existing one. The full prose guide is at `templates/score/README.md` in the
avocode checkout.

## Parallel configs (optional)

Implement two extra invocations and `avo score --parallel` works:

```bash
.avo/score --configs           # one config name per line: [A-Za-z0-9][A-Za-z0-9._-]*
.avo/score --config b1_s4096   # score just that one; same JSON shape
```

Anything else on `--configs` stdout means "unsupported" and degrades to one serial run with a warning.
Declaring `configs` in `.avo/config.json` skips the probe entirely, saving a scoring run.

## Authoring rules

- **Measure the thing you actually want.** The lineage is monotone in `f` and nothing else. If `f` is
  wall-clock on one input size, that is exactly what gets optimized, correctness gate aside.
- **Make `correct` strict and cheap.** It runs on every attempt and it is the only thing standing
  between the loop and a fast wrong answer.
- **Be deterministic, or set a `floor`.** Noise commits noise. `.avo/config.json`'s `floor` is a
  symmetric relative band: a change inside it counts as neither better nor worse.
- **Never print anything but the JSON line to stdout.** Put diagnostics in `log`, or on stderr.
- **Keep it fast enough to run every iteration.** A scorer that takes an hour caps the loop at 24
  variations a day.
