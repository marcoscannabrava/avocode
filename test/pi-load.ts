/**
 * Loads a repo's Pi extensions exactly the way Pi itself does — `DefaultResourceLoader`, the real
 * discovery paths, the real trust rules — and prints what came back as one line of JSON.
 *
 * This exists because unit tests can only prove that `avoTools()` returns six tool definitions.
 * Whether Pi *finds and accepts* them is a different question, and it is the one that breaks: a
 * wrong directory name, an untrusted project, a module that throws at import time, or a schema Pi
 * rejects all look identical from inside the extension. The e2e drives this against a repo wired by
 * the real `avo install`, so the link, the discovery path and the trust rule are all under test.
 *
 * Not a `.test.ts` file on purpose: it is a harness the shell suite runs, not a suite itself.
 *
 * Project trust is a CALLER decision, not something the loader reads from settings: `reload()`
 * takes a `resolveProjectTrust` callback and only then admits project-local `.pi/extensions`. That
 * is the same seam `pi` resolves from `defaultProjectTrust`, a saved `trust.json` or `--approve`,
 * so `--trust no` here is exactly what a headless run in an unapproved project sees.
 *
 * Usage: tsx test/pi-load.ts --cwd <repo> --agent-dir <dir> [--trust yes|no] [--path <index.ts>]
 */

import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

const cwd = arg("cwd");
const agentDir = arg("agent-dir");
if (cwd === undefined || agentDir === undefined) {
  console.error("usage: tsx test/pi-load.ts --cwd <repo> --agent-dir <dir> [--path <index.ts>]");
  process.exit(2);
}

const explicit = arg("path");
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  additionalExtensionPaths: explicit === undefined ? [] : [explicit],
  // Only extensions are under test; skills, prompts and themes have their own suite (S5).
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});

const trusted = (arg("trust") ?? "yes") === "yes";
await loader.reload({ resolveProjectTrust: async () => trusted });
const loaded = loader.getExtensions();
console.log(
  JSON.stringify({
    errors: loaded.errors.map((e) => (typeof e === "string" ? e : JSON.stringify(e))),
    extensions: loaded.extensions.map((e) => ({ path: e.path, tools: [...e.tools.keys()] })),
  }),
);
