# Run the tests

## The short answer

```sh
just check     # lint + typecheck + unit tests   (~seconds — run this before anything)
just e2e       # the end-to-end suites            (~minutes — drives the real bin/avo)
just all       # both
```

No `just`? Run the same things directly:

```sh
node_modules/.bin/oxlint src test pi bench && ./test/lint-sh.sh   # = just lint
node_modules/.bin/tsc --noEmit                                    # = just typecheck
node_modules/.bin/tsx --test test/*.test.ts                       # = just test
./test/e2e.sh                                                     # ...and the rest of test/e2e-*.sh
```

One unit file while you work on it:

```sh
node_modules/.bin/tsx --test test/compare.test.ts
```

## The tasks

| Command | What it does |
| --- | --- |
| `just check` | lint + typecheck + test — the health check every loop iteration runs first |
| `just lint` | oxlint, then `test/lint-sh.sh` — shellcheck over every shell script git knows about |
| `just typecheck` | `tsc --noEmit` |
| `just test` | the `node:test` unit suites |
| `just e2e` | exercises the real `bin/avo`; writes `evidence/*-e2e.txt` |
| `just all` | `check` + `e2e` |
| `just doctor` | `./bin/avo doctor` |
| `just install` | `./install.sh` |

## Two kinds of test

**Unit tests** (`test/*.test.ts`, `node:test` through `tsx`) — every `src/` module has one. Fast and
hermetic: `src/io.ts` exists so commands can be driven without a terminal, and `websearch.ts` takes an
injectable `Fetcher` so the backends are testable without a network.

**End-to-end suites** (`test/e2e-*.sh`) — they spawn the real `bin/avo` against real temporary git
repos, and each writes a transcript into `evidence/`. That directory is the point: a claim about
user-facing behavior is backed by a file showing the commands and their output.

| Suite | Covers |
| --- | --- |
| `e2e.sh` | the CLI skeleton, `doctor`, and invariant 6 (an API key value never appears in output) |
| `e2e-score.sh` | the `f` contract: validation, normalization, timeouts, `--parallel` |
| `e2e-lineage.sh` | `avo commit`, trailers, notes, `lineage/vNNN.md`, `avo best` |
| `e2e-mem.sh` | memory with and without `bd` — the JSON must be identical either way |
| `e2e-know.sh` | `K` with and without `qmd`, ingest provenance, the search backends |
| `e2e-install.sh` | wiring pi / claude / codex; the managed `AGENTS.md` block |
| `e2e-install-sh.sh` | `./install.sh`: the link, idempotency, `--force`, `--uninstall`, and `avo` resolving its checkout **through** the symlink |
| `e2e-fan.sh` | worktrees, the four guards, promote, resume |
| `e2e-supervise.sh` | stall and thrash detection, and the directive's citations |
| `e2e-run.sh` | the continuous loop, its manifest, token accounting, the stop conditions |
| `e2e-pi.sh` | the native pi tools and the supervisor extension |
| `e2e-bench.sh` | replays the six-step ladder through `avo score`/`avo commit` — the headroom proof |
| `e2e-arcagi3.sh` | the ARC-AGI-3 target: the target-aware protected manifest, `f`'s gates and sandbox, and its two-rung ladder. The half needing the python toolkit is `SKIP`ped unless `ARCAGI3_TARGET` names a set-up target, so CI never installs a game engine |
| `e2e-lint.sh` | the lint gate itself: every assertion is about it going **red** |

## The lint gate is deliberately unskippable

`test/lint-sh.sh` discovers its own targets from `git ls-files` (plus untracked, non-ignored files),
so a new script is checked before anyone remembers to list it. It needs shellcheck — but not
*installed* shellcheck: absent from `PATH` it falls back to `npm exec --yes -- shellcheck`. If neither
can run, it **fails**.

That is the point. It used to end in `|| echo "shellcheck: skipped (not installed)"`, which reported
32 real findings under a false reason and kept CI green through eight slices
([#2](https://github.com/marcoscannabrava/avocode/issues/2)). `test/e2e-lint.sh` holds it shut.

The shellcheck **version** is pinned in `SC_PIN`, and CI derives its install from that line rather
than naming its own — findings are not stable across versions. A runner at the wrong version warns
and still runs; refusing to lint would be a worse failure than the drift. `SHELLCHECK=<path>` pins a
runner and disables the fallback.

## CI

`.github/workflows/ci.yml` runs two jobs on every push to `main` and every PR: `check` (lint +
typecheck + test) and `e2e`, which uploads `evidence/` as an artifact. Both install the shellcheck
version read out of `test/lint-sh.sh`'s own pin.

The e2e job runs **without any agent CLI installed** — deliberately, because the S0 acceptance case is
`avo doctor` behaving correctly when the tools it drives are missing.

## Benchmark a real run

Tests prove the harness works. Whether the *loop* works is a separate question with its own tooling —
see [bench.md](bench.md).
