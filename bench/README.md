# `bench/` — the optimization targets

A target is a **template**, not a working repo. `bench/init.sh` materializes one into a fresh git repo
of its own, outside this checkout, and the loop is pointed at that with `--cwd`.

| Target | `f` | Direction | Extra setup |
| --- | --- | --- | --- |
| `fuzzysearch` | median ms per search, 2 configs | lower is better | none |
| `arcagi3` | ARC-AGI-3 levels completed, 10 configs | higher is better | `bench/setup.sh` (venv + games) |

```sh
export PATH="$PWD/bin:$PATH"                          # the skills call `avo`, not ./bin/avo

./bench/init.sh ~/work/fuzzysearch                    # or: --target arcagi3
cd ~/work/arcagi3 && ./bench/setup.sh                 # arcagi3 only
.avo/score | jq .                                     # does f work?

avo init --cwd ~/work/arcagi3
avo run  --cwd ~/work/arcagi3 --agent claude --prompt-file ~/work/arcagi3/task.md --max-iters 12

./bench/verify-run.sh ~/work/arcagi3 --target arcagi3 # the curve, re-measured
./bench/init.sh --verify ~/work/arcagi3 --target arcagi3
```

**Full runbook, prerequisites and troubleshooting: [`docs/bench.md`](../docs/bench.md).** Each target
also ships its own `README.md` describing what it is and what counts as cheating.

## What is in here

| Path | |
| --- | --- |
| `init.sh` | materialize a target into its own repo; `--verify` audits that `f` was not edited |
| `verify-run.sh` | turn a finished `avo run` into `evidence/`: the curve, re-measured from each commit |
| `replay-tokens.ts` | re-parse a run's agent logs and diff against what the manifest recorded |
| `<target>/` | the template: the candidate, `f`, and `avo/protected.txt` naming what is off limits |
