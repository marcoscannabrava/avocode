/**
 * Drives the native tools the way Pi drives them — `execute(id, params, signal, onUpdate, ctx)` —
 * against a repo given on the command line, and prints the two results as one line of JSON.
 *
 * The e2e then reads the same repo back with `bin/avo`. That is the point: invariant 1 says
 * `avo commit` is the only writer of a version, and the extension is supposed to BE that writer
 * rather than a second one that agrees with it today. A version written here must be a version the
 * CLI sees, with the trailer the CLI writes and the rationale in the rendered lineage.
 *
 * Not a `.test.ts` file: it is a harness the shell suite runs. It lives in `test/` rather than
 * being written into the repo root at run time, because a stray file in avocode's own working tree
 * is the self-perturbation bug S3 and S6 both hit — `avo commit` would count it as a candidate.
 *
 * Usage: tsx test/pi-drive.ts <repo>
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { avoTools } from "../pi/extensions/avo/tools.ts";

const cwd = process.argv[2];
if (cwd === undefined) {
  console.error("usage: tsx test/pi-drive.ts <repo>");
  process.exit(2);
}

const tools = new Map(avoTools().map((t) => [t.name, t]));
const ctx = { cwd } as unknown as ExtensionContext;

const commit = await tools.get("avo_commit")!.execute("c1", { why: "e2e: the baseline scorer" } as never, undefined, undefined, ctx);
const lineage = await tools.get("avo_lineage")!.execute("c2", {} as never, undefined, undefined, ctx);
console.log(JSON.stringify({ commit: commit.details, lineage: lineage.details }));
