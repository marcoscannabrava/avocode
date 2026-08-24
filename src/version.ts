import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** The single source of truth for the version is package.json. */
export const VERSION: string = (
  JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string }
).version;
