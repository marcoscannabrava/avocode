/**
 * The `avo-supervisor` Pi extension: watches `avo_score` / `avo_commit` results and injects S7's
 * steering directive natively, so a stalling session is corrected inside the loop instead of
 * between processes.
 *
 * Deliberately almost empty, like `pi/extensions/avo/index.ts`. Everything is in `supervisor.ts`,
 * the behaviour it steers on in `src/supervise.ts`; this is only Pi's discovery point.
 *
 * A SEPARATE extension from `avo`, not a second half: the tools are useful without a supervisor, and
 * an operator already running `avo run` should be able to load one and not the other. `avo install
 * --agent pi` links both.
 *
 * For a one-off: `pi -e pi/extensions/avo/index.ts -e pi/extensions/avo-supervisor/index.ts`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installSupervisor } from "./supervisor.ts";

export default function (pi: ExtensionAPI): void {
  installSupervisor(pi);
}
