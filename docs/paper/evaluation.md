# Evaluation and project history: notes for the paper

These notes cover the empirical side of avocode and how the repo was built. Every number here
comes from a file in the repo. The source path follows each claim. Section 7 lists the places
where the sources disagree. Read it before you copy a number into the paper.

Short names used below:

- **S9b-1**: the first agent run on `fuzzysearch` (`evidence/s9b-run.txt`).
- **S9b-2a**: the second run, which resumed the same lineage (`evidence/s9b-run-2.txt`).
- **Ladder**: the hand-written candidates in `test/fixtures/<target>/`. They prove that the target
  has room to improve. They are never copied into a target.

---

## 1. Benchmarks

The repo has two targets in `bench/`. Each one is a template. `bench/init.sh <dest> --target <name>`
copies it into a new git repo outside the avocode checkout. The script refuses a destination inside
avocode, because `avo commit` would write the loop's lineage into avocode's own history
(`bench/init.sh` header; `docs/bench.md` "Never materialize a target inside this checkout").

| Target | Task | `f` (primary) | Direction | Configs | `floor` | Candidate |
| --- | --- | --- | --- | --- | --- | --- |
| `fuzzysearch` | thresholded Levenshtein retrieval | mean of per-config median ms per search | lower | 2 (`small`, `large`) | 0.03 | `src/search.js` |
| `arcagi3` | play ARC-AGI-3 games from pixels | mean fraction of levels completed | higher | 10 games | 0.1 | `src/policy.py` |

Both use `"reduce": "dominate"` (`bench/*/avo/config.json`). A candidate commits only if it ties or
beats the best on every config and wins on at least one. `floor` is a symmetric relative band: a
change inside it counts as a tie (`PLAN.md` §6 Q1).

The two targets were chosen to be unlike each other. `fuzzysearch` is a speed problem with a known
answer, so it tests the harness. `arcagi3` is an open capability problem, so it tests the loop
(`docs/bench.md`, intro).

### 1.1 `fuzzysearch`

**Task.** Return every `(query, word)` pair whose Levenshtein distance is at most `k`. Result order
is free; the gate compares sets (`bench/fuzzysearch/README.md`).

**Workload** (`bench/fuzzysearch/bench/corpus.js`, `CONFIGS`). A seeded pseudo-lexicon built from
consonant/vowel syllables with common prefixes and suffixes. An LCG makes it the same on every
machine.

| Config | Corpus words | Queries | `k` | Corpus seed | Query seed | Reps (min/max) | Budget |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `small` | 2500 | 80 | 2 | 7 | 99 | 3 / 500 | 300 ms |
| `large` | 5000 | 120 | 2 | 11 | 4242 | 3 / 500 | 300 ms |

The rep count adapts to the speed of the candidate. `spread_pct` is an interquartile range, not
max minus min. With max minus min, the fast end showed 51% "spread" from one GC pause. With IQR,
every ladder step had 0 to 2.5% spread, which is the basis for `floor: 0.03` (`PLAN.md` S9a
deviations; `PROGRESS.jsonl` iter 13).

**Baseline.** A full DP matrix built from nested arrays: "correct and slow"
(`evidence/s9a-e2e.txt` §1, baseline commit message). See §7 for the baseline time.

**Scorer.** `bench/fuzzysearch/avo/score` (bash; it lands at `.avo/score`). It always exits 0. It
supports `--configs` and `--config <name>`, so `avo score --parallel` works. `correct` has three
gates, in order:

1. **Hash gate.** `sha256sum -c .avo/gate.sha256` over the protected files. A missing gate file is
   `ok:false` (harness error), not `correct:false`.
2. **Unit suite.** `node --test test/*.test.js`: empty inputs, `k=0`, exact distances, unicode,
   duplicates.
3. **Full-scale check.** `bench/run.js --config <name>` compares the candidate with the independent
   `bench/reference.js` on the exact input it times. It also checks that the candidate did not change
   its arguments. Then it reports `median_ms`, `reps`, `pairs` and `spread_pct`.

`primary` is the mean of the per-config medians.

**Protected files** (`bench/fuzzysearch/avo/protected.txt`): `bench/reference.js`,
`bench/corpus.js`, `bench/run.js`, `test/search.test.js`, `.avo/score`, `.avo/protected.txt`. The
list protects itself. (`evidence/s9b-run*.txt` §5 checks five files; `evidence/s9a-e2e.txt` checks
six. The sixth, `.avo/protected.txt`, came with the ARC-AGI-3 commit `44b89c3`.)

**Why gate 3 matters.** `test/e2e-bench.sh` ships a candidate that passes the whole unit suite but
returns `[]` for any corpus over 1000 words. Only gate 3 catches it: "wrong result on config
'small': 306 pair(s) missing, 1 unexpected" (`evidence/s9a-e2e.txt` §4).

**Known gap.** An agent that edits both the scorer and `.avo/gate.sha256` defeats the in-repo gate.
`bench/init.sh --verify <dest>` audits the protected files from outside the target. Both agent runs
end with it (issue #38; `docs/bench.md`).

**A target that was rejected first.** Matrix multiply: flat `Float64Array`, i-k-j order, transposed
operand, 64x64 tiling and a 2x unrolled micro-kernel gave **1.7x** in total, with most steps inside
the noise, "because V8's JIT already does that work" (`PLAN.md` S9a; `PROGRESS.jsonl` iter 13).

#### 1.1.1 Ladder (headroom proof, no agent)

Six hand-written candidates, `test/fixtures/fuzzysearch/v1.js`..`v6.js`, replayed through
`avo score` and `avo commit` by `test/e2e-bench.sh`.

Table A. The ladder as measured in the committed evidence (`evidence/s9a-e2e.txt` §5, 2026-08-26):

| Step | Technique (`docs/bench.md`, `PLAN.md`) | primary (ms) | Decision |
| --- | --- | --- | --- |
| v0 | full DP, nested arrays | 1719.368 | baseline |
| v1 | two-row rolling DP over `Int32Array` | 145.093 | committed |
| v2 | + length-difference prefilter | 72.603 | committed |
| v3 | + common prefix/suffix trim | 67.434 | committed |
| v4 | + Ukkonen band, row-minimum early exit | 16.693 | committed |
| v5 | + length-bucketed corpus index | 13.7455 | committed |
| v6 | + letter-set bitmask prefilter | 0.931 | committed |

"6 committed, 0 refused, of 6 steps"; "headroom walked: 1719.368ms -> 0.931ms = 1846.8x". Each
version reproduced its recorded score from its own commit within -2.2% to +5.8%
(`evidence/s9a-e2e.txt` §6). On the CI runner, the same suite gave "3189.975ms -> 1.7585ms = 1814x"
and reproduction within 1.2% (`PROGRESS.jsonl` iter 13).

Across regenerations of `evidence/s9a-e2e.txt`, the headroom line was 1803.4x, 1782.5x, 1819.6x,
1796.1x, 1864.2x and 1846.8x (`git log -p -- evidence/s9a-e2e.txt`). This is a direct view of run
to run noise on one machine.

`PLAN.md` S9a also has a per-config ladder table from "one reference machine" that starts at 356ms
(small 155.7, large 556.4) and ends at v6 small 0.66, large 1.31 (385x). No evidence file has that
baseline. See §7.

v3 (~5%) is kept on purpose as the borderline case for `floor: 0.03`. v6 was added so that one
marginal step on a slow machine could not drop the ladder below five versions (`PLAN.md` S9a).

#### 1.1.2 Agent runs

Both runs used `avo run --agent claude` with the agent's default model. The command was
`claude --print --output-format stream-json --verbose --permission-mode bypassPermissions`. The
target repo was `/home/marcos/code/avo-s9b-fuzzysearch` (`evidence/s9b-run*.txt` §1).

**Setup** (`PLAN.md` S9b-1 deviation; `PROGRESS.jsonl` iter 14). K was seeded with four notes
written offline: Ukkonen's banded DP, Myers bit-parallel, BK-trees with Levenshtein automata and
cheap filters, and V8 numeric-loop performance. The notes "deliberately do not contain the ladder".
No web search key and no `qmd` were present, so K used the local-scan fallback. `avo` was put on
`PATH` by hand (issue #41). A watchdog touched `.avo/STOP` after a fixed time (1500s for S9b-1,
1200s for S9b-2a). Both runs stopped on the watchdog, not on convergence.

Table B. Run settings and outcomes.

| | S9b-1 | S9b-2a |
| --- | --- | --- |
| Run id | `20260825T201507Z-f2548e` | `20260825T221255Z-8b1eec` |
| Iterations | 6 of 12 | 3 of 6 |
| Per-turn timeout | 480 s | 900 s |
| Wall-clock | 34m 43s | 30m 41s |
| Stopped on | `.avo/STOP` (watchdog) | `.avo/STOP` (watchdog) |
| Versions committed | 4 (v1 to v4) | 3 (v5 to v7) |
| Refusals | 1 (it 6: `small` -4.74%, floor ±3%) | 0 |
| Supervisor interventions | 0 | 0 |
| Thresholds | stall 5, thrash 3 | stall 5, thrash 3 |
| Tokens (manifest) | in 44, out 25,139 (wrong, bug #43) | in 158, out 119,912, cache read 5,555,257, cache write 241,350 |
| Cost | $1.91 floor for 2 of 6 turns (replayed) | $8.19 ($2.73/turn) |
| `f` intact (`init.sh --verify`) | PASS | PASS |
| verify-run verdict | 1 check FAILED (only 4 versions; criterion is ≥5) | all 10 checks passed |

Sources: `evidence/s9b-run.txt`, `evidence/s9b-run-2.txt`, `evidence/issue-43-replay.txt`,
`PLAN.md` S9b-1 and S9b-2a.

In S9b-1, iterations 5 and 6 were both killed on the 480s timeout. "The later a candidate is, the
more scoring and differential testing a turn does" (`PLAN.md` S9b-1). S9b-2a raised it to 900s.

Before S9b-2a, the refused candidate from S9b-1 iteration 6 (interleaved index entries) was removed
from the working tree and saved as `evidence/s9b-refused-candidate-interleaved-entries.diff`. The
agent reached the same idea again and made it win as v5 (`PLAN.md` S9b-2a).

Table C. The agent lineage (main results table). Primary and per-config values from
`evidence/s9b-run-2.txt` §2. Speedup vs v0 uses v0 = 1810.3695 ms from `evidence/s9b-run.txt` §2.
The v5 to v7 speedups vs v0 are not in any evidence file (bug #51, see §7). They are computed by hand
in `PLAN.md` and here.

| Ver | Run | Technique (from `--why` / `PLAN.md`) | small (ms) | large (ms) | primary (ms) | vs prev | vs v0 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| v0 | — | full DP matrix, nested arrays | — | — | 1810.37 | — | 1x |
| v1 | 1 | rolling `Int32Array` Ukkonen band + length-bucketed corpus + flat code units | 3.447 | 10.261 | 6.854 | 264.13x | 264.1x |
| v2 | 1 | character-set bitmask prefilter ahead of the banded DP (gated to k ≤ 6) | 0.435 | 0.849 | 0.642 | 10.68x | 2819.9x |
| v3 | 1 | partition (pigeonhole) hash index: **not in the ladder** | 0.309 | 0.507 | 0.408 | 1.57x | 4437.2x |
| v4 | 1 | PassJoin position-aware probe window on that index | 0.253 | 0.436 | 0.345 | 1.18x | 5255.1x |
| v5 | 2 | one interleaved `Int32Array` for the partition index (length + mask beside the link) | 0.248 | 0.413 | 0.331 | 1.04x | ~5478x (hand) |
| v6 | 2 | Myers bit-parallel for survivors + layout pass fused into the index build | 0.173 | 0.368 | 0.270 | 1.22x | ~6693x (hand) |
| v7 | 2 | no flat corpus buffer; branchless Myers with early exit | 0.158 | 0.304 | 0.231 | 1.17x | **7837x** (`PLAN.md`) |

Exact recorded primaries: v1 6.853999999999999, v2 0.642, v3 0.40800000000000003,
v4 0.34450000000000003, v5 0.3305, v6 0.27049999999999996, v7 0.23099999999999998
(`evidence/s9b-run-2.txt` §4). The hand ratios for v5 and v6 use these values and v0 = 1810.3695.
`PLAN.md` gives 7837x for v7 ("1810.37ms → 0.231ms").

Commits in the target repo (`evidence/issue-42-replay.txt`): `f651b62` v1, `3be2bec` v2, `3d1e5ce`
v3, `1f56243` v4. S9b-2a started from `1f562435` (`evidence/s9b-run-2.txt` header).

Table D. Reproduction check: each recorded score re-measured from its own commit in a detached
worktree. The pass band is 50% (`bench/verify-run.sh` line ~197).

| Ver | Recorded (ms) | Fresh, S9b-1 file | Drift | Fresh, S9b-2a file | Drift |
| --- | --- | --- | --- | --- | --- |
| v1 | 6.854 | 7.346 | 7.2% | 7.031 | 2.6% |
| v2 | 0.642 | 0.685 | 6.7% | 0.7245 | 12.9% |
| v3 | 0.408 | 0.4445 | 8.9% | 0.4585 | 12.4% |
| v4 | 0.3445 | 0.3705 | 7.5% | 0.379 | 10.0% |
| v5 | 0.3305 | — | — | 0.3435 | 3.9% |
| v6 | 0.2705 | — | — | 0.273 | 0.9% |
| v7 | 0.231 | — | — | 0.2385 | 3.2% |

All drifts are positive (fresh is slower). `PROGRESS.jsonl` iter 14 says "the drift is one direction
because the box was busy".

**Mapping to the ladder** (`PLAN.md` S9b-1; `PROGRESS.jsonl` iter 14):

- v1 fused five of the six ladder steps in one commit (rolling DP, length bucketing, the band).
- v2 matches ladder v6 (letter-set bitmask).
- **v3 is the step not in the ladder.** The agent cut each corpus word into `k+1` disjoint segments
  and hashed them. By pigeonhole, any match within `k` edits keeps one segment verbatim, so the scan
  becomes a few substring probes. Its `--why` cites K's bucketing note: "the same idea applies to any
  filter whose key is discrete". The source comment in the refused diff says this cut window
  candidates from "283k" to "23k probed candidates" on the scored workload
  (`evidence/s9b-refused-candidate-interleaved-entries.diff`, top hunk).
- v4 (PassJoin), v6 (Myers bit-parallel) and v7 also go past the ladder, whose last rung is 0.931 ms.
  `PLAN.md` concludes "the ladder is a floor on this target, not a ceiling".

**Observed agent behaviour in S9b-2a** (`PLAN.md` S9b-2a; `PROGRESS.jsonl` iter 18):

- Each turn started with a measurement. v6's turn timed the phases ("setup 0.147/0.073, chain walk
  0.112/0.047, banded 0.118/0.098") and found the band took 30 to 43% of the call. The v4 and v5
  notes had called it "almost certainly too small to matter now". The agent recorded that the
  earlier note was wrong.
- v7 deleted the 46105-code-unit corpus buffer that v6 had built, because only about 15000 code
  units are ever read.
- Two of three turns bundled changes on purpose. A change worth +2.66% is under the ±3% floor, so it
  shipped with a partner. `PLAN.md` calls this "the commit rule shaping the variation step".
- A dead end found twice: both v6's and v7's turns tried to drop the counting sort and both measured
  a regression. v7 retried it because a change should have removed the first cause. It did not.

### 1.2 `arcagi3`

**Task.** Play ten ARC-AGI-3 games from 64x64 `int8` frames. `src/policy.py` holds a `Policy` class
whose `act(frame)` is called once per action (`docs/bench.md`; `bench/arcagi3/task.md`).

**Engine and corpus.** Games run offline through `arc_agi.Arcade` in `OperationMode.OFFLINE`: no API
key, no network, about 40 ms per episode. The corpus is pinned by commit
`b6cbf21a36f029882b72c702bbbfd45455ce330d` and by per-file SHA-256 in `bench/games.lock`, from
`theredbluepill/arc-interactive` (MIT). `bench/setup.sh` builds a `.venv` and fetches the games. A
full score takes about 20 s (`docs/bench.md`).

**Metric** (`bench/arcagi3/bench/run.py`). Per episode: `max levels_completed / win_levels`, capped
at `BUDGET = 250` actions. The max is used because GAME_OVER resets progress. Per game: the mean over
`ROLLOUTS = 24`. The policy's RNG is seeded from `POLICY_SEED = 1000003` plus the rollout index,
because `arc.make(..., seed=)` is a no-op for this corpus. `primary` is the mean over games. The
toolkit exposes no finer reward (`docs/bench.md`).

**Training games** (`TRAIN` in `run.py`): `ez02 tt01 va01 ul01 fs01 tp01 nw01 mm01 ff01 ff03`.

**Why 24 rollouts and `floor: 0.1`.** Two policies with the same behaviour but a different order of
RNG use disagree by a median of 18% per config at 8 rollouts and 6% at 24. With a single rollout,
two such policies scored 0.234 and 0.262 (`run.py` comments; `bench/arcagi3/README.md`).

**Games removed during selection** (`run.py`; `docs/bench.md`):

| Requirement | Removed | Reason |
| --- | --- | --- |
| non-zero baseline | `sq01` (0.025) | relative deltas swing ±100% on one level, so it vetoes every commit |
| exact reproducibility | `wm01` | real-time game: 0.483, 0.533, 0.483 on three runs of identical code |
| not saturated | `ic02` (1.000) | no headroom |

**Scorer.** `bench/arcagi3/avo/score`. `correct` has four gates:

1. hash gate over the protected files (`.avo/gate.sha256`);
2. the game corpus matches `bench/games.lock`;
3. the policy contract suite (`test/test_*.py`, each run as a script);
4. every episode ran without breaking the contract or reaching outside its frames.

A missing venv or corpus gives `ok:false`, never a score (`evidence/arcagi3-e2e.txt` §4).
`--configs` works without Python, by reading the `TRAIN` line of the protected `run.py` with `sed`.

**Protected files** (`bench/arcagi3/avo/protected.txt`): `bench/run.py`, `bench/setup.sh`,
`bench/games.lock`, `test/test_policy.py`, `requirements.txt`, `.avo/score`, `.avo/protected.txt`.
`bench/games/` is not hashed at copy time; `games.lock` pins it instead, and `games.lock` itself is
protected.

**Anti-gaming, three layers** (`docs/bench.md`; `run.py`):

1. The hash gate.
2. A sandbox through `sys.addaudithook`, armed only while `act` runs. It refuses network events
   (`socket.connect`, `socket.getaddrinfo`, `socket.bind`, `urllib.Request`) and any `open` under
   `bench/games/`. It raises `Cheated(BaseException)` and also sets a flag that the harness checks
   after `act` returns. "An earlier version raised a plain `Exception`, and a policy wrapping its
   body in `except Exception: pass` swallowed the violation and scored a clean 0.26."
3. The game id is withheld from the policy. Seeds are not exposed either, since "a policy handed its
   own seed could index a lookup table by it".

**Holdout and official scoring (outside `f`).** Memorisation is the one thing `f` cannot catch,
because the training games live in the target repo.

- `test/fixtures/arcagi3/score-holdout.sh <target>`: eight unseen games from the same upstream
  commit (`holdout.lock`): `ez04 fs03 tp02 bd01 sv01 pb01 cs01 mm02`. It runs the target's own
  `bench/run.py` with `--games-dir`, so the numbers are comparable. Some games pair with a training
  game (for example `ez04` goes down, `ez02` goes left). `cs01` and `mm02` were added because a
  holdout of movement games only scored the baseline and the aimed-clicks policy "identically"
  (`test/fixtures/arcagi3/README.md`).
- `test/fixtures/arcagi3/score-api.sh <target>`: the official ARC-AGI-3 games over the network
  (default `ls20,ft09`). It needs `ARC_API_KEY`, refuses an anonymous key and never prints the key.
  It is never part of `f`.
- `bench/verify-run.sh --target arcagi3` runs both after a loop. Each is `SKIP`ped, not faked, when
  it cannot run.

Table E. ARC-AGI-3 baseline per game (`docs/bench.md`, `.avo/score` output):

| ez02 | tt01 | va01 | ul01 | fs01 | tp01 | nw01 | mm01 | ff01 | ff03 | primary |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.45 | 0.264 | 0.258 | 0.183 | 0.108 | 0.333 | 0.3 | 0.274 | 0.3 | 0.3 | 0.277 |

Table F. ARC-AGI-3 ladder (scripted, no agent; `test/fixtures/arcagi3/README.md`,
`bench/arcagi3/README.md`):

| Rung | Change | Per-config effect | `avo commit` | Train primary | Holdout primary |
| --- | --- | --- | --- | --- | --- |
| baseline | uniform random walk, ignores frame | — | — | 0.277 | 0.217 |
| v1 aimed clicks | aim only click coordinates; same RNG draws and order | ff01 0.300→0.492 (+64%), ff03 0.300→0.492 (+64%), mm01 0.274→0.321 (+17%); seven movement games bit-identical | committed | 0.320 | 0.227 (cs01 +38%, mm02 +19%) |
| v2 cell clicks | click non-background cells, not their bounding box | mm01 0.321→0.000 (-100%) | **refused** | — | — |

The lesson stated in the docs: "Additive changes are scored exactly; changes to the shared path have
to beat the noise everywhere" (`docs/bench.md`).

**ARC-AGI-3 agent results: none recorded.** The repo has no `evidence/arcagi3-run.txt` and no
manifest of an `avo run` on this target. No official-API scores are recorded. In the committed
`evidence/arcagi3-e2e.txt`, the half that needs the Python toolkit is `SKIP`ped ("no set-up arcagi3
target"), so CI and the evidence show only the gates and the copy step, not game play. The ladder
numbers above appear only in docs. The paper should present `arcagi3` as a built and gated target
with a scripted ladder, not as an agent result.

---

## 2. Tables ready for LaTeX

Table C (agent lineage) and Table B (run settings) above are the main results. Two more compact
forms follow.

Table G. Headline numbers.

| Quantity | Value | Source |
| --- | --- | --- |
| End-to-end speedup, `fuzzysearch` | 1810.37 → 0.231 ms = 7837x | `PLAN.md` S9b-2a |
| Run 1 speedup | 1810.4 → 0.345 ms = 5255x | `evidence/s9b-run.txt` |
| Versions committed by agents | 7 (4 + 3) | `evidence/s9b-run-2.txt` |
| Agent turns | 9 (6 + 3) | both run files |
| Refused candidates | 1 | `evidence/s9b-run.txt` it 6 |
| Regressions committed | 0 | `PLAN.md` S9b |
| Supervisor interventions | 0 in 9 turns | both run files; `PLAN.md` S9b-2b |
| Agent wall-clock | 34m 43s + 30m 41s | both run files |
| Cost per turn (run 2) | $2.73 ($8.19 / 3) | `evidence/s9b-run-2.txt` |
| Scripted ladder headroom | 1846.8x (local), 1814x (CI) | `evidence/s9a-e2e.txt`; `PROGRESS.jsonl` iter 13 |
| Rejected target (matmul) | 1.7x total | `PLAN.md` S9a |
| ARC-AGI-3 scripted ladder | 0.277 → 0.320 train; 0.217 → 0.227 holdout | `bench/arcagi3/README.md` |

Table H. Per-iteration log of the agent runs (`evidence/s9b-run*.txt` §1; S9b-1 attribution from
`evidence/issue-42-replay.txt`, since the manifest then showed "noop" for every turn).

| Run | It | Agent | Outcome |
| --- | --- | --- | --- |
| 1 | 1 | ok | agent committed v1 (6.854 ms) |
| 1 | 2 | ok | agent committed v2 (0.642 ms) |
| 1 | 3 | ok | agent committed v3 (0.408 ms) |
| 1 | 4 | ok | agent committed v4 (0.345 ms) |
| 1 | 5 | failed (timeout) | noop |
| 1 | 6 | failed (timeout) | refused: `small` -4.74% (floor ±3%) |
| 2 | 1 | ok | agent committed v5 (0.3305 ms) |
| 2 | 2 | ok | agent committed v6 (0.2705 ms) |
| 2 | 3 | ok | agent committed v7 (0.231 ms) |

---

## 3. Evidence transcripts

`evidence/` is committed. Each e2e suite writes one file. PASS/FAIL/SKIP counts are counts of lines
in the current files (2026-08-26 regeneration, except the two `-with-` files dated 2026-08-24).

| File | Suite | Checks | What it shows |
| --- | --- | --- | --- |
| `s0-e2e.txt` | `e2e.sh` | 12 | CLI skeleton and `avo doctor`, including under a stripped `PATH`; no key value ever appears in output |
| `s1-e2e.txt` | `e2e-score.sh` | 27 | the `f` contract: validation, normalization, timeouts, `--parallel` (fixture: candidate must print 42, metric is code size) |
| `s2-e2e.txt` | `e2e-lineage.sh` | 23 | `avo commit` commits v1, refuses a regression, writes trailers, notes, `lineage/vNNN.md`; `avo best` |
| `s3-e2e.txt` / `s3-e2e-with-bd.txt` | `e2e-mem.sh` | 26 (+1 skip) / 24 | memory with and without beads gives the same JSON |
| `s4-e2e.txt` / `s4-e2e-with-qmd.txt` | `e2e-know.sh` | 31 (+1 skip) / 34 | K with the local-scan fallback and with qmd 2.8.3; ingest provenance |
| `s5-e2e.txt` | `e2e-install.sh` | 76 | skills wired for pi, claude and codex; second install gives no diff; never clobbers |
| `s6-e2e.txt` | `e2e-fan.sh` | 52 | four probes in parallel worktrees, promote, cleanup, the four guards, resume after a kill |
| `s7-e2e.txt` | `e2e-supervise.sh` | 36 | stall fires at exactly 5; progress resets it; thrash; the directive cites version, lineage file, rationale and an unread K doc |
| `s7b-e2e.txt` | `e2e-run.sh` | 92 | the `avo run` loop, injected directive, stop conditions, crash-safe manifest, and the fixes for #42, #43, #49 |
| `s8-e2e.txt` | `e2e-pi.sh` | 25 | real pi 0.84.3 loads both extensions; a version committed through a pi tool is a version; six worse scores give one directive |
| `s9a-e2e.txt` | `e2e-bench.sh` | 41 | `fuzzysearch` gates catch tampering and fast-wrong candidates; the six-step ladder commits; scores reproduce |
| `arcagi3-e2e.txt` | `e2e-arcagi3.sh` | 23 (+1 skip) | `arcagi3` copy step, protected manifest, `ok:false` without venv, tampering fails `f` and `--verify`; game play skipped |
| `lint-gate-e2e.txt` | `e2e-lint.sh` | 17 | the shellcheck gate turns red on a finding and on a missing shellcheck; version pinned to 0.11.0 |
| `install-sh-e2e.txt` | `e2e-install-sh.sh` | 15 | `./install.sh` link, idempotency, `--force`, `--uninstall`, symlink resolution |
| `s9b-run.txt` | `bench/verify-run.sh` | 6 PASS, 1 FAIL | agent run 1: 4 versions, 5255x, `f` intact; fails the ≥5 versions criterion |
| `s9b-run-2.txt` | `bench/verify-run.sh` | 10 PASS | agent run 2: 7 versions, monotonic, all reproduce, `f` intact |
| `issue-42-replay.txt` | ad hoc | — | the run 1 manifest said `committed=[]`; the fix credits `[1,2,3,4]` from `head_before..head_after` |
| `issue-43-replay.txt` | `bench/replay-tokens.ts` | — | the run 1 manifest recorded 44 of 985,039 input tokens; 4 of 6 logs lost their final event to a 200 KB cap |
| `s9b-refused-candidate-interleaved-entries.diff` | — | — | the refused iteration 6 candidate, kept as a record |

Sum of current e2e PASS lines over the 14 suite files: 496.

### 3.1 Refusals and supervisor interventions

- **Real refusals.** One in an agent run: S9b-1 iteration 6, "'small' regressed (worst: small
  -4.74%) (floor ±3.00%)". One in the ARC-AGI-3 scripted ladder: cell clicks, `mm01` -100%.
- **Real interventions: zero.** In 9 agent turns the supervisor never fired. `since_best` peaked at 2
  in run 1 and stayed 0 in run 2. "A target with 5000x of headroom is improved faster than a stall
  detector can notice one" (`PLAN.md` §6 Q3). Q3 (the stall threshold) is still open.
- **Interventions in tests only.** `s7-e2e.txt` §3 (stall at exactly 5), `s7b-e2e.txt` §4 (both
  signals fire, directive injected and recorded as `avo-intervention-178141d6`), and `s8-e2e.txt` §5
  (pi supervisor: "six worsening scores produce ONE directive, not six", threshold 3 from
  `.avo/config.json`). These are stub agents, not real ones.

### 3.2 Token and cost data

**Inside the target (the optimizing agent).**

- Run 1, replayed by `bench/replay-tokens.ts` (`evidence/issue-43-replay.txt`):

  | It | Log bytes | Replayed tokens | Cost |
  | --- | --- | --- | --- |
  | 1 | 193,243 | in 24, out 15,977, cache read 523,326, write 49,963 | $1.1623 |
  | 2 | 122,467 | in 20, out 9,162, cache read 379,040, write 32,666 | $0.7468 |
  | 3 to 6 | 200,258 to 203,768 | none: result event cut off by the 200 KB cap | unknown |
  | total | | in 44, out 25,139, cache read 902,366, write 82,629 | $1.91 (floor) |

  "Input tokens the run actually sent: 985,039. Input tokens the manifest recorded: 44 (0.0045%)."
  Two bugs caused it (#43): only `input_tokens` was read, not the cache fields; and the output cap
  kept the head of the stream, while claude puts usage and cost in the last event. The fix keeps a
  50 KB rolling tail in the same 200 KB budget.
- Run 2 (`evidence/s9b-run-2.txt`): in 158, out 119,912, cache read 5,555,257, cache write 241,350,
  **$8.19** for 3 turns, **$2.73/turn**. Run 1's floor had implied ~$0.95/turn, so the estimate was
  about 3x low. At this rate the default 12 iterations would cost ~$33, and `avo run` has no cost cap
  (#28) (`PLAN.md` S9b-2a).
- `bench/replay-tokens.ts` re-parses `.avo/runs/<id>/logs/*` with the same `parseAgentOutput` from
  `src/agents.ts` and prints manifest vs replay side by side. It spawns nothing.

**The meta loop that built the repo** (`logs/<run>/run.log`; `total_cost_usd` and usage from the
last `result` event of each `iter-NNN.jsonl`). Models in `modelUsage`: `claude-opus-5[1m]` and
`claude-haiku-4-5-20251001`.

| Ralph run | Iterations ok | Work (matched to commit times) | Wall-clock | Cost |
| --- | --- | --- | --- | --- |
| `20260824T130013Z` | 9 (iteration 10 has no result) | S0 to S7b | 13:00:13 → 16:10:09 UTC | $73.39 |
| `20260825T185952Z` | 9 (iteration 10 interrupted) | ralph interrupt fix, S8b, S9a, S9b-1, #42, #43, #2, S9b-2a, #49 | 18:59:52 → 23:33:38 UTC | $55.94 |
| two short runs | 0 | interrupted at start | — | $0 |

Total recorded meta-loop cost: $129.34 for 18 iterations. Per-iteration cost ranged from $2.27 (S0)
to $13.15 (S4), and 8 to 50 minutes. The S8a commit (`83c6b20`, 19:02 UTC) lands while run
`20260825T185952Z` iteration 1 is working on the ralph interrupt fix. That fits the orphaned-session
incident (#33): a session from the interrupted run `20260825T184613Z` kept editing the checkout
(`docs/meta-loop.md`). This link is an inference from timestamps, not a stated fact. The ARC-AGI-3
commit (`44b89c3`, 07:56 UTC Aug 26) falls outside every logged ralph run. The $8.19 of S9b-2a is
billed by the inner `claude` processes, separate from the $3.25 of the ralph iteration that drove
it.

---

## 4. Test strategy

**Two kinds of test** (`docs/testing.md`):

- **Unit tests**: `test/*.test.ts`, 17 files, `node:test` run through `tsx`. Every `src/` module has
  one. They are hermetic: `src/io.ts` makes commands testable without a terminal, and
  `websearch.ts` takes an injectable `Fetcher`. Current count: **441 tests, 441 pass**, about 4.6 s
  (run during this write-up with `node_modules/.bin/tsx --test test/*.test.ts`).
- **End-to-end suites**: 14 `test/e2e-*.sh` scripts listed in the `justfile` `e2e` recipe. They run
  the real `bin/avo` against temporary git repos and write `evidence/*.txt`.
- **Lint gate**: `oxlint` over `src test pi bench` plus `test/lint-sh.sh` (shellcheck, pinned to
  0.11.0 in `SC_PIN`, falls back to `npm exec --yes -- shellcheck`, and fails if neither runs). It
  used to end in `|| echo "skipped"`, which hid 32 real findings across eight slices (#2).

**Growth of the unit suite** (`PROGRESS.jsonl` `verification` fields):

| Iter | Slice | Unit tests | E2E checks (cumulative) |
| --- | --- | --- | --- |
| 1 | S0 | 19 | 12 |
| 2 | S1 | 57 | 39 |
| 3 | S2 | 110 | 63 |
| 4 | S3 | 141 | 88 |
| 5 | S4 | 193 | 119 |
| 6 | S5 | 239 | 186 |
| 7 | S6 | 301 | 247 |
| 8 | S7a | 335 | 283 |
| 9 | S7b | 376 | 350 |
| 10 | S8a | 406 | 364 |
| 12 | S8b | 424 | 375 |
| 13 | S9a | 424 | 416 |
| 16 | #43 | 434 | — |
| 19 | #49 | 441 | 451 |

The ralph harness had its own 31-test suite (`PROGRESS.jsonl` iter 11 onward), removed in `00c73ae`
when ralph moved out.

**CI** (`.github/workflows/ci.yml`). Runs on push to `main` and on every PR, Node 22,
`ubuntu-latest`. Two jobs:

- `check`: `npm ci`, install the pinned shellcheck, then `just lint`, `just typecheck`, `just test`.
- `e2e`: `just e2e`, then upload `evidence/` as an artifact. No agent CLI is installed on purpose:
  the S0 acceptance case is `avo doctor` behaving well when the tools are missing. The ARC-AGI-3
  game half is skipped unless `ARCAGI3_TARGET` is set, so CI never installs a game engine.

Reported CI durations: check 43 to 45 s, e2e 1m24s to 6m8s (`PROGRESS.jsonl` iters 11, 12, 13). The
CI runner is "~9x slower than this machine" (`PROGRESS.jsonl` iter 13).

**Acceptance criteria for S9** (`PLAN.md` S9a): at least 5 committed versions with a monotonically
non-decreasing best, and every committed version reproduces its recorded score from its own commit.
The scripted ladder met both in S9a; agents met both in S9b-2a.

---

## 5. Project history

### 5.1 How the repo was built

avocode was built by an agent loop, `ralph`. It re-runs a coding agent with `PROMPT.md`. The agent
has no memory between runs. All state lives in `PLAN.md` (slices, invariants, open questions),
`PROGRESS.jsonl` (one line per iteration: `iter, date, task, done[], verification, next`),
`evidence/`, git history and GitHub issues (`docs/meta-loop.md`; `PROMPT.md`). Each cycle: orient,
health check (`just check`), pick one task, do it, verify, commit through a PR, hand off by appending
to `PROGRESS.jsonl`, exit.

This is the same shape as `avo run`: a fresh process per turn, a repo as the only memory, and a hard
gate (here, the health check and CI) on each change. 24 of 43 commits carry
`Co-Authored-By: Claude Opus 5 (1M context)`. All commits have the user as git author.

The commit log has a fixed rhythm: each slice is a PR commit (`S<n>: ... (#PR)`) followed by a
one-line "handoff" commit that appends to `PROGRESS.jsonl`. Most handoff titles name a bug the
iteration found in its own work ("the self-perturbation bug", "the $PWD bug", "two directive-recursion
bugs").

### 5.2 Timeline (git log, 43 commits)

| Date (local) | Commit | Phase | Content |
| --- | --- | --- | --- |
| 2026-08-22 | `17e1e3d`, `45d594a` | Bootstrap | simple ralph, `PROMPT.md`, AVO paper notes; `PLAN.md` |
| 2026-08-24 | `2e71048` | Bootstrap | ralph harness with its own tests |
| 2026-08-24 | `aba1a12` | S0 | skeleton, `avo doctor`, health check, CI |
| 2026-08-24 | `1faa7ca` | S1 | `f`: `avo score`, score templates (#3) |
| 2026-08-24 | `57d439e` | S2 | `P_t`: commit rule, lineage, `avo best` (#5) |
| 2026-08-24 | `45ce244` | S3 | memory: `avo init`, `avo mem`, beads mirror (#9) |
| 2026-08-24 | `54bd5b5` | S4 | K: `avo know`, qmd, web backends (#13) |
| 2026-08-24 | `6905ad6` | S5 | agent-agnostic skills, `avo install` (#17) |
| 2026-08-24 | `c6861a9` | S6 | `avo fan`, worktree probes, four guards (#20) |
| 2026-08-24 | `bed9f06` | S7a | `avo supervise`: stall, thrash, citing directive (#26) |
| 2026-08-24 | `18e2e8c` | S7b | `avo run`: the loop, injected directive (#30) |
| 2026-08-25 | `83c6b20` | S8a | six native pi tools (#31) |
| 2026-08-25 | `fb69ad3` | meta | ralph: an interrupt takes its session with it (#34) |
| 2026-08-25 | `d4e6991` | S8b | pi supervisor extension (#36) |
| 2026-08-25 | `017c921` | S9a | `bench/fuzzysearch`, real `f`, ladder (#37) |
| 2026-08-25 | `03dd250` | S9b-1 | agent run: 5255x, one step not in the ladder (#44) |
| 2026-08-25 | `c73850a` | fix | `avo run` credits agent-made commits (#42) |
| 2026-08-25 | `2e80fa1` | fix | `avo run` records real token use and cost (#43) |
| 2026-08-25 | `153c521` | fix | shellcheck gate that can fail (#2) |
| 2026-08-25 | `21bd753` | S9b-2a | resume to v7, criteria met, $2.73/turn (#52) |
| 2026-08-25 | `44f694b` | fix | unexplained turn records silence, not a protocol event (#49) |
| 2026-08-25 | `00c73ae` | pivot | **ralph moves out** to its own repo |
| 2026-08-25 | `8ecbf40` | docs | README simplified, details into `docs/` |
| 2026-08-26 | `44b89c3` | target | ARC-AGI-3 target, holdout, API scorer (#55) |
| 2026-08-26 | `cde5239` | docs | doc and comment cleanup |
| 2026-10-02 | `d05177c` | docs | blog post and figures |

The core harness (S0 to S7b) was built in one ralph run of about 3 h 10 min on 2026-08-24. S8 to
S9b-2a plus four fixes took a second run of about 4 h 34 min on 2026-08-25 (§3.2).

### 5.3 Design pivots and lessons recorded

- **Ralph moves out** (`00c73ae`). The meta loop "was never part of `avo`". As a file in the tree it
  "could only ever drive this tree". It moved to `github.com/marcoscannabrava/ralph` with its 33-test
  suite. Removed: `ralph.sh`, `ralph-render.jq`, `test/ralph_test.sh`, `test/stream.jsonl`. Kept:
  `PLAN.md`, `PROGRESS.jsonl`, `evidence/`, "because they are what the loop produced rather than the
  loop".
- **S7 and S8 split in two** (detector/driver; tools/extension), and S9 into S9a (target, no agent)
  and S9b (run). Reason: the parts that need no agent and no budget can be proven first
  (`PROGRESS.jsonl` iter 13).
- **Target chosen by measurement.** Matmul lost (1.7x) before any `fuzzysearch` code was written.
  "The only way to decide it is to MEASURE the ladder" (`PROGRESS.jsonl` iter 13).
- **Composition over building** (`PLAN.md` §2): qmd for K, beads for memory, pi as reference
  harness, Agent Skills format. Fan-out is ~150 LOC of its own because existing tools are UI-first
  or "No LLM in the coordination loop". OpenEvolve and ShinkaEvolve were rejected because they
  implement the fixed `Generate(Sample(P_t))` pipeline AVO removes.
- **Vector `f` with dominate-or-tie** instead of a weighted mean, so a big win on one config cannot
  pay for a regression on another (`PLAN.md` §6 Q1, resolved in S1/S2).
- **Self-perturbation guard.** S3, S6 and S8 each hit a bug where the tool edited the tree it was
  measuring. `bench/init.sh` now refuses any target inside the avocode checkout.
- **Bugs found only by real runs** (S9b-1): #42 (manifest showed `noop` for turns where the agent
  committed itself), #43 (44 of 985,039 input tokens recorded), #41 (`avo` not on the target's
  `PATH`; it would give a flat curve that "reads as a fact about the target"), #40 (K doc names
  slugged from full paths), #49 (a raw stream-json event written into permanent lineage), #51
  (`verify-run.sh` takes v0 from the run start).
- **Handoff trap.** "Filed, not fixed: #49" in a commit message closed #49 on GitHub because it
  matches the keyword. Rule: write "filed #49 (not fixed)" (`PLAN.md` header).
- **Orphaned session** (#33): an interrupted ralph left an agent running, and two agents committed to
  one checkout. Fixed in `fb69ad3` (`docs/meta-loop.md`).

---

## 6. Threats to validity and limitations

1. **Two runs, one target, one machine, one agent.** All agent results come from two
   `avo run --agent claude` sessions on `fuzzysearch` on one machine. No repeat runs, no variance
   across seeds, no other agents. The pi comparison (S9b-2b) was not done (`PLAN.md` S9b-2b).
2. **The second run is not independent.** S9b-2a resumed the S9b-1 lineage with the same prompt. The
   7837x figure spans both runs.
3. **Runs stopped on a wall-clock watchdog**, not on convergence. The best is a lower bound on what
   the loop could reach. v7 was "still finding 17% per turn" (`PLAN.md` S9b-2b).
4. **Timing noise.** Fresh re-measurements drift +0.9% to +12.9% from the recorded value, all in one
   direction (Table D). The scripted ladder headroom moved between 1782x and 1864x across
   regenerations. The floor is 3%. A busy box can make a real gain look like a tie or a tie look like
   a loss. The pass band in `verify-run.sh` is a loose 50%.
5. **Baseline sensitivity.** The speedup ratio is dominated by the slow baseline. The baseline
   differs a lot between sources: 356 ms (`PLAN.md`, `docs/bench.md`), 1635 to 1740 ms in
   `s9a-e2e.txt` regenerations, 1810 ms at the start of run 1 (§7). The fast end (~0.92 ms for ladder
   v6) agrees across sources. Ratios against v1 or between versions are more stable than ratios
   against v0.
6. **The supervisor was never tested by a real run.** Zero interventions in 9 turns. The stall
   threshold (5) is a guess from the design notes; Q3 is open. Claims about supervisor value rest on
   stub-agent tests only.
7. **K was seeded by hand** with four offline notes. Web ingestion and qmd search were not used in
   the runs. v3 cites a K note, so K content shaped the result. The notes "deliberately do not contain
   the ladder", but they do name the relevant algorithm families (Ukkonen, Myers, BK-trees,
   Levenshtein automata).
8. **The model was not a small model.** The runs used claude's default model. The design calls for
   cheap probes via `avo fan`, but no small-model key (GROQ, CEREBRAS, OPENROUTER) was available, so
   `avo fan` was not used in any real run and the probe-vs-commit cost split is unmeasured
   (`PROGRESS.jsonl` iters 14, 18).
9. **Cost data is partial.** Run 1 cost is a floor ($1.91 for 2 of 6 turns). Only run 2 has a full
   cost. No cost cap exists (#28).
10. **No ARC-AGI-3 agent result.** Only a scripted two-rung ladder, a holdout result for it, and gate
    tests. The game-play half of the e2e suite is skipped in the committed evidence. No official API
    score exists.
11. **Gate limits.** The in-repo hash gate is defeatable by an agent that edits the gate file too
    (#38). The external `init.sh --verify` covers this only after the run, not during it.
12. **Supervised setup.** A human set up K, the watchdog, the `PATH` workaround, and discarded the
    refused candidate before run 2. The runs are not fully unattended.
13. **fuzzysearch has a known answer.** It tests the harness more than the operator's ability on an
    open problem; this was the stated intent (`docs/bench.md`).

---

## 7. Inconsistencies between sources (check before quoting)

1. **fuzzysearch baseline and ladder headroom.** `docs/bench.md` and `PLAN.md` give baseline 356.0 ms
   (small 155.7, large 556.4) and ladder 356.0 → 0.92 ms = 385.5x. Every committed version of
   `evidence/s9a-e2e.txt` shows a baseline of 1635 to 1740 ms and 1782x to 1864x headroom, with
   matching rungs v1 to v6 (~145 ms down to ~0.93 ms). The corpus configs have not changed since
   `017c921`. `PROGRESS.jsonl` iter 13 says "385x on this machine and 1814x on the CI runner". Only
   the v0 number differs, so the 356 ms figure likely comes from an earlier baseline before the S9a
   commit. Prefer the evidence file numbers, or state both.
2. **"vs v0" in `evidence/s9b-run-2.txt`** is wrong: it uses the run's start (v4, 0.353 ms), so v1
   shows as "0.1x" (bug #51). The 7837x appears only in `PLAN.md` and the blog, computed by hand.
3. **Reproduction percentages for run 1.** `PROGRESS.jsonl` iter 14 quotes 7.2%, 6.7%, 10.8%, 9.3%.
   The current `evidence/s9b-run.txt` shows 7.2%, 6.7%, 8.9%, 7.5%. The file was regenerated later.
4. **PASS count in `s9b-run.txt`.** `PROGRESS.jsonl` iter 14 says "8 PASS, 1 FAIL"; the file has 6
   PASS lines and 1 FAIL line.
5. **Per-iteration lines in `s9b-run.txt`** say "noop" for iterations 1 to 4, which committed v1 to
   v4. The file predates the #42 fix. Use `evidence/issue-42-replay.txt` for attribution.
6. **Holdout pairing count.** `docs/bench.md`: "Four of its eight games pair with a training game".
   `test/fixtures/arcagi3/README.md`: "Five of them pair" and lists five pairs.
7. **ARC-AGI-3 baseline commit message** (`bench/arcagi3/avo/baseline-msg.txt`) says "0.267 on the
   five training games". The current target has ten games and scores 0.277.
8. **ARC-AGI-3 floor.** A `run.py` comment says determinism "is why .avo/config.json can set floor
   0". The config sets `floor: 0.1`.
9. **Blog cost line.** "Cost was ~$2.73/turn" in `docs/blog_post.md` applies to run 2 only.
10. **Blog run time.** "Run 2 ... 31 minutes" rounds 30m 41s; fine, but note the exact value.

---

## 8. Figures in `docs/img/`

All seven are hand-made SVGs, 760 px wide. They define colours as CSS variables with a
`prefers-color-scheme: dark` block. `rsvg-convert` is installed on this machine, so
`rsvg-convert -f pdf -o x.pdf x.svg` should work. Check that the light colours are used, since the
CSS variables and the media query may not survive conversion. Text uses system fonts, so check
glyph widths after conversion.

| File | What it shows | Use in the paper |
| --- | --- | --- |
| `results.svg` | Log-scale chart of median ms per search, v0 1810.4 ms to v7 0.231 ms; "7,837x faster, 0 regressions"; run 1 (34 min) and run 2 resumed (31 min) shaded; v3 tagged "Pigeonhole index: not in the hand-written ladder" | **Yes**, main results figure |
| `lineage-chain.svg` | Chain v0 → v7 with each version's ms and technique, the refused "interleaved entries" candidate (small 4.7% slower than v4) hanging off v4, and a note that run 2 made the same idea win as v5 | **Yes**, lineage and dead-end memory |
| `commit-rule.svg` | Four example candidates vs the best on `small`/`large`: faster on both (kept), tie + win (kept, v5), win + regress 4.7% (refused), tie on both (refused) | **Yes**, method section |
| `loop.svg` | Agent → `avo score` → `avo commit` → `avo supervise`, all reading and writing one store (lineage, memory, K) | **Yes**, system overview |
| `lineage-records.svg` | One version (fuzzysearch v3) as four committed records: commit with `Avo-Version`/`Avo-Score` trailers, `git notes --ref=avo`, `lineage/v003.md`, memory entry; vs gitignored trajectory (attempt log, worktrees, run logs) | Yes, data model |
| `knowledge.svg` | `knowledge/` and `lineage/` indexed by qmd (keyword + vector + rerank), one `avo know query` hit list; local-scan fallback | Yes, K section |
| `fan.svg` | `avo fan`: four probes in worktrees off HEAD, promote probe 2, then `avo score` and `avo commit`. Its scores are labeled as examples, not measured | Only as a diagram; say the numbers are illustrative |
