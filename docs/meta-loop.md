# The meta loop

avocode is built by the loop it implements. The one that *builds* this repo is
[`ralph`](https://github.com/marcoscannabrava/ralph) — it was `ralph.sh` here until it earned its
own repo, and it was never part of `avo` itself.

```sh
curl -fsSL https://raw.githubusercontent.com/marcoscannabrava/ralph/main/ralph -o ~/.local/bin/ralph
chmod +x ~/.local/bin/ralph
ralph                      # loop until RALPH_STOP or Ctrl+C
```

It re-invokes a coding agent with [`PROMPT.md`](../PROMPT.md) forever. The agent has **no memory**
between runs — all continuity lives in the repo:

| File | Role |
| --- | --- |
| [`PLAN.md`](../PLAN.md) | the slice order, the invariants, the open questions. Read first, every cycle |
| `PROGRESS.jsonl` | one JSON line per iteration: `{iter, date, task, done[], verification, next, blocker?}`. Its last `next` is the default task |
| `evidence/` | what each iteration actually proved |
| git history + GitHub Issues | everything else |

## Why its interrupt handling is load-bearing history

A session that outlives its loop gets reparented to init and goes on editing the working tree. That
is how two agents once ended up committing to one checkout here
([#33](https://github.com/marcoscannabrava/avocode/issues/33)). The fix, and the tests that hold it
in place, live in the `ralph` repo now.

## One handoff trap, learned the hard way

**Never write `fixed`, `closes` or `resolves` next to an issue number in a commit message unless
you fixed it.** GitHub matches the keyword, not the sentence — one iteration's honest
`Filed, not fixed: #49` closed #49 as completed, and the bug was still live a full iteration later.
Write `filed #49 (not fixed)` instead.
