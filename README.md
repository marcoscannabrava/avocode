# avocode

An [AVO](avo-paper.md)-inspired agent harness. AVO replaces classical evolutionary variation
operators with an autonomous coding agent — `Vary(P_t) = Agent(P_t, K, f)`. `avocode` extracts that
harness and makes it general and agent-agnostic.

See [PLAN.md](PLAN.md) for the architecture, the slice order, and the invariants.

## Status

Slice S0 (skeleton + health check) is done. `avo doctor` is the only real command so far.

## Quickstart

```sh
npm install
just check          # lint + typecheck + test
./bin/avo doctor    # dependency and API-key status
```

`avo doctor` exits 1 when a required dependency (`git`, `jq`) is missing, or when no coding agent
(`pi`, `claude`, `codex`) is on `PATH` — one is required to act as the variation operator. Optional
dependencies (`qmd`, `bd`, `hyperfine`, `just`) are reported but never fail the check; each slice
that needs one degrades with a named fallback. API keys are reported as present/unset only — their
values never appear in any output.

## Tasks

| Command | What it does |
| --- | --- |
| `just check` | lint + typecheck + test — the health check every Ralph cycle runs first |
| `just e2e` | exercises the real `bin/avo`; writes `evidence/s0-e2e.txt` |
| `just all` | `check` + `e2e` |
| `just doctor` | `./bin/avo doctor` |

## Layout

```
bin/avo        entrypoint; runs src/main.ts through tsx (no build step)
src/cli.ts     subcommand dispatcher
src/doctor.ts  dependency + API-key report
src/io.ts      injectable output sink, so commands are unit-testable
test/          node:test unit tests + e2e.sh
evidence/      artifacts proving user-facing behavior works end to end
```

`ralph.sh` is the meta loop that builds this repo; it is not part of `avo` itself.
