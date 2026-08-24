# avocode

An [AVO](avo-paper.md)-inspired agent harness. AVO replaces classical evolutionary variation
operators with an autonomous coding agent — `Vary(P_t) = Agent(P_t, K, f)`. `avocode` extracts that
harness and makes it general and agent-agnostic.

See [PLAN.md](PLAN.md) for the architecture, the slice order, and the invariants.

## Status

S0 (skeleton + health check), S1 (`f` — scoring) and S2 (`P_t` — lineage) are done. `avo doctor`,
`avo score`, `avo commit`, `avo lineage` and `avo best` work.

## Quickstart

```sh
npm install
just check          # lint + typecheck + test
./bin/avo doctor    # dependency and API-key status

cd /your/repo
avo score --init hyperfine   # scaffold .avo/score (or: pytest, vitest)
avo score                    # run it
avo score --json | jq .      # the normalized attempt an agent reads

# ...now change something, and let the commit rule decide whether it was progress
avo commit --why "hoisted the bounds check out of the loop"
avo lineage                  # P_t so far
avo best --json              # what the next candidate must beat
```

## `avo score` — the `f` contract

`f` is the only thing that tells the agent whether a variation was an improvement, so its contract
is frozen: `.avo/score` is any executable printing one JSON line, and it always exits 0 — a build
error or a failed test is a *result*, and the agent can only act on it as data. See
[templates/score/README.md](templates/score/README.md) for the full authoring guide and
[PLAN.md](PLAN.md) §3 for the contract itself.

`avo score` validates that line, names the offending field when it is wrong, normalizes it into an
**attempt** (`primary` flipped so higher is always better; `null` when the candidate fails), and
appends it to `.avo/attempts.jsonl`. Attempts are not commits — that gate is `avo commit`.

| Flag | |
| --- | --- |
| `--json` | the normalized attempt as one line |
| `--parallel` | fan configs out concurrently, if the scorer implements `--configs` |
| `--timeout <s>` | kill the scorer — and its children — after s seconds |
| `--init <t>` | scaffold `.avo/score` from a template; idempotent, never clobbers an edit |
| `--no-record` | skip the attempt log |
| `--cwd <dir>` | treat dir as the repo root |

Exit codes: `0` pass, `1` ran but failed, `2` harness error (no scorer, malformed output, timeout).

## `avo commit` — the commit rule

A new version is persisted **only** when it passes correctness *and* beats the best committed one.
`avo commit` is the only writer of committed lineage: it scores, compares, and either commits or
refuses with a reason specific enough to act on.

```
$ avo commit --why "dropped the padding comment"
avo commit

  scored       8 bytes
  best         v1 (28940fc)
  *            34 -> 8  +76.47%  improved

committed v2 as 219a215 — '*' improved (best: * +76.47%) and nothing regressed
```

The comparison is over the **score vector**, never the scalar `primary`: by default a candidate
commits iff no config regressed and at least one improved, so a large win on one config can never
pay for a regression on another. A config the best version measured but the candidate did not
blocks the commit — you cannot improve by measuring less. Tune it in `.avo/config.json`:

```json
{ "reduce": "mean", "floor": 0.02, "weights": { "b1_s4096": 2 }, "configs": ["b1_s4096", "b8_s1024"] }
```

`floor` is a symmetric relative noise band; `reduce: "mean"` opts into letting configs trade off;
`configs` declares the scorer's config names so `avo score --parallel` skips the discovery probe.

| Flag | |
| --- | --- |
| `--why <text>` | the rationale; lands in the commit body and in `lineage/vNNN.md` |
| `--dry-run` | report the decision, write nothing |
| `--json` `--parallel` `--timeout <s>` `--no-record` `--cwd <dir>` | as for `avo score` |

Exit codes: `0` committed or no-op, `1` refused, `2` harness error. Re-running with no change is a
no-op, never a duplicate.

## `avo lineage` and `avo best` — reading `P_t`

A committed version is a commit carrying `Avo-Version` and `Avo-Score` trailers, plus the full
attempt in `git notes --ref=avo` and a rendered `lineage/vNNN.md` (score table, diffstat,
rationale). Nothing else defines a version, which is what keeps `avo commit` the only writer.

```sh
avo lineage             # the score curve so far
avo lineage show 3      # one version, with its rationale
avo lineage diff 1 3    # score delta and the patch between two versions
avo best --json         # what the next candidate must beat
```

Because the commit rule only admits non-regressions, the lineage is monotone by construction and
`avo best` is simply the highest-numbered version. `lineage/` is plain markdown on purpose: S4
indexes it as a qmd collection so the agent can semantically search its own history.

`.avo/attempts.jsonl` and `.avo/worktrees/` are **trajectory, not lineage** — `avo commit`
gitignores them and keeps them out of every version it writes.

## `avo doctor`

`avo doctor` exits 1 when a required dependency (`git`, `jq`) is missing, or when no coding agent
(`pi`, `claude`, `codex`) is on `PATH` — one is required to act as the variation operator. Optional
dependencies (`qmd`, `bd`, `hyperfine`, `just`) are reported but never fail the check; each slice
that needs one degrades with a named fallback. API keys are reported as present/unset only — their
values never appear in any output.

## Tasks

| Command | What it does |
| --- | --- |
| `just check` | lint + typecheck + test — the health check every Ralph cycle runs first |
| `just e2e` | exercises the real `bin/avo`; writes `evidence/s{0,1,2}-e2e.txt` |
| `just all` | `check` + `e2e` |
| `just doctor` | `./bin/avo doctor` |

## Layout

```
bin/avo           entrypoint; runs src/main.ts through tsx (no build step)
src/cli.ts        subcommand dispatcher
src/doctor.ts     dependency + API-key report
src/score.ts      f — run, validate and normalize .avo/score
src/config.ts     .avo/config.json — the reduction, the floor, declared configs
src/compare.ts    the commit rule's comparator over the score vector
src/lineage.ts    Pt — avo commit, avo lineage, avo best
src/io.ts         injectable output sink, so commands are unit-testable
templates/score/  reference scorers + the authoring guide
test/             node:test unit tests + e2e.sh, e2e-score.sh, e2e-lineage.sh
evidence/         artifacts proving user-facing behavior works end to end
```

`ralph.sh` is the meta loop that builds this repo; it is not part of `avo` itself.
