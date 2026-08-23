# Ralph Loop

You are being re-invoked with this same prompt, forever, by `./ralph.sh`. You have **no memory** of
the last run — all continuity lives in the repo (`PLAN.md`, `PROGRESS.jsonl`, git history, GitHub
Issues/PRs).

**Each run: do one coherent unit of work, prove it, commit it, hand off, exit.** The loop restarts you.

## Every cycle

1. **Orient.** Read `PLAN.md`. Read `tail -n 1 PROGRESS.jsonl` — its `next` is your default task.
   `git log --oneline -10`.
2. **Health check.** Lint + typecheck + tests. If `main` is red, fixing it is the only task.
3. **Pick ONE task.** First match wins: broken `main` → security/data-loss → bug in the core path →
   next unbuilt slice in `PLAN.md` → high-value improvement → tech debt → backlog item.
   Tie-break: smallest change, fully verifiable this iteration.
4. **Do it.** Read the files before changing them. Test first when behavior is specifiable. Don't
   load files unrelated to the task.
5. **Verify for real.** Lint + typecheck + tests green. User-facing changes exercised end-to-end,
   evidence in `evidence/`.
6. **Commit** one focused increment, push, open a PR (merge only if CI-green and low-risk).
7. **Hand off.** Update `PLAN.md`. Append one JSON line to `PROGRESS.jsonl`:
   `{iter, date, task, done[], verification, next, blocker?}`. As the project grows, document. File anything noticed-but-not-done as an Issue. Exit.

## Rules

- **Idempotency is survival** — check before you create; re-running must never corrupt state.
- **Never leave `main` broken.** Never commit secrets. No destructive/irreversible moves
  (delete data, force-push `main`, rotate prod creds) without operator sign-off via an Issue.
- **If blocked, write it down** (Issue + `blocker` in your `PROGRESS.jsonl` line) and exit. Never spin.
- **Escape hatch:** `touch RALPH_STOP` when there is genuinely no valuable work left or a human must
  unblock you. Record why in `PROGRESS.jsonl` first. Use sparingly.
- Fix the docs when they disagree with the code; code wins. Keep `PLAN.md` and `PROGRESS.jsonl` lean.
