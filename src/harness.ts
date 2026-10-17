// Paths avo writes; imports nothing (#24).

/** Memory without `bd`. Already a qmd collection, like the rest of lineage/. */
export const MEMORY_PATH = "lineage/memory.jsonl";
/**
 * Trajectory, not population. Written *by* the harness during a variation step, so they must never
 * enter the lineage: committing them puts the log of how a version was reached inside it, and leaves
 * the tree permanently dirty — which defeats the no-op check in `avo commit`.
 */
export const TRAJECTORY_PATHS: readonly string[] = [".avo/attempts.jsonl", ".avo/worktrees", ".avo/runs"];
export const TRAJECTORY_IGNORE = ".avo/.gitignore";
/**
 * Everything avo writes *by itself*, none of which may read as a candidate change: the trajectory
 * log, the harness gitignore, and the memory log `avo commit` appends *after* committing. Without
 * this, v1's memory makes the next run see a change the agent never made — scoring an unchanged
 * tree, refusing it, and remembering that refusal, which dirties the tree again.
 *
 * Unlike TRAJECTORY_PATHS these stay staged: they belong in the repo, they are just not evidence of
 * a variation.
 */
export const HARNESS_PATHS: readonly string[] = [...TRAJECTORY_PATHS, TRAJECTORY_IGNORE, MEMORY_PATH];

/** True for a path avo writes. */
export function isHarnessPath(path: string): boolean {
  return HARNESS_PATHS.some((t) => path === t || path.startsWith(`${t}/`));
}

/** Drops what avo wrote itself, so a repo the agent did not touch still reads as clean. */
export function withoutTrajectory(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter((l) => l.trim() !== "")
    .filter((l) => {
      // porcelain v1: XY <path>, where a rename is "XY old -> new".
      const path = l.slice(3).split(" -> ").pop() ?? "";
      return !isHarnessPath(path.replace(/^"|"$/g, ""));
    });
}
