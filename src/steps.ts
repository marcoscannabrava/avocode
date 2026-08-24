/**
 * How the scaffolding commands report themselves. Every step says what it did, so a second run
 * visibly changes nothing and idempotency is checkable from the output alone (invariant 5).
 *
 * Lives apart from `init.ts` so `knowledge.ts` can report the same way without a module cycle —
 * `avo init` folds `avo know init`'s steps into its own.
 */
export type StepAction = "created" | "unchanged" | "skipped" | "failed";

export interface InitStep {
  name: string;
  action: StepAction;
  detail: string;
}
