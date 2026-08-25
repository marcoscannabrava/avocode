/**
 * The `avo` Pi extension: registers the six avo tools natively so a Pi session can score, commit,
 * read P_t, search and grow K, and fan out without shelling out to `avo`.
 *
 * Deliberately almost empty. The tools themselves are in `tools.ts` and the behaviour they wrap is
 * in `src/`; this file exists only to be the entry point Pi discovers. Keeping it this thin is what
 * lets `tools.ts` be unit-tested with injected deps and no Pi session at all.
 *
 * Wiring: Pi auto-discovers `.pi/extensions/<name>/index.ts` in a trusted project, so `avo install
 * --agent pi` symlinks `.pi/extensions/avo` at this directory rather than copying it — the same
 * one-symlink rule S5 used for `.agents/skills`. For a one-off, `pi -e pi/extensions/avo/index.ts`
 * works without any wiring.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { avoTools } from "./tools.ts";

export default function (pi: ExtensionAPI): void {
  for (const tool of avoTools()) pi.registerTool(tool);
}
