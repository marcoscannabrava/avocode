/**
 * The `avo` Pi extension: registers the six avo tools natively so a Pi session can score, commit,
 * read P_t, search and grow K, and fan out without shelling out to `avo`.
 *
 * Deliberately almost empty: the tools are in `tools.ts`, the behaviour they wrap in `src/`. This
 * file is only the entry point Pi discovers, which is what lets `tools.ts` be unit-tested with
 * injected deps and no Pi session.
 *
 * Wiring: Pi auto-discovers `.pi/extensions/<name>/index.ts` in a trusted project, so `avo install
 * --agent pi` symlinks `.pi/extensions/avo` here rather than copying — S5's one-symlink rule. For a
 * one-off, `pi -e pi/extensions/avo/index.ts` needs no wiring.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { avoTools } from "./tools.ts";

export default function (pi: ExtensionAPI): void {
  for (const tool of avoTools()) pi.registerTool(tool);
}
