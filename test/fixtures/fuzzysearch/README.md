# fuzzysearch ladder fixtures

Five hand-written candidates for `bench/fuzzysearch`, each one step further along a known
optimization path. They are the **headroom proof**: `test/e2e-bench.sh` replays them through
`avo score` and `avo commit` and asserts that five real improvements commit under the target's own
`f`, with a monotonically non-decreasing best score. That is S9's verify criterion, exercised
without spending an agent.

They live here, in avocode, and NOT under `bench/fuzzysearch/` -- `bench/init.sh` materializes
every file in the template directory, so a ladder stored there would hand the optimizer the answer
it is supposed to find.

| File | Step | Measured on the reference machine |
| --- | --- | --- |
| `v1.js` | two-row rolling DP over `Int32Array` | ~2.0x |
| `v2.js` | + skip pairs whose lengths differ by more than `k` | ~2.1x |
| `v3.js` | + trim the common prefix and suffix first | ~1.05x |
| `v4.js` | + Ukkonen band with a row-minimum early exit | ~2.6x |
| `v5.js` | + index the corpus by length once, not per query | ~1.2x |

`v3` is deliberately kept: at ~5% it sits just above `floor: 0.03`, which is the honest borderline
case the commit rule exists to adjudicate.
