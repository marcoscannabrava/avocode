/**
 * Drives the avo-supervisor extension through Pi's OWN machinery: the real `DefaultResourceLoader`
 * that discovers it, the real `ExtensionRunner` that dispatches to it, a real `SessionManager`, and
 * the real `emitToolResult` path — against a real repo with a real scorer.
 *
 * What is scripted is the *model*, not the harness. A stalling sequence driven by an actual LLM is
 * neither deterministic nor offline, and the thing under test has nothing to do with what the model
 * says: it reacts to tool results. So the script is a sequence of tool calls — score, score, score,
 * with the candidate getting worse each time — executed through the tool definitions Pi registered,
 * with each result fed back through `runner.emitToolResult` exactly as Pi's tool-execution loop
 * does. Everything between the tool result and the injected message is Pi's, not ours.
 *
 * That distinction matters because the unit suite already proves the decision. What it cannot prove
 * is that Pi routes a `tool_result` for a *custom* tool to a handler in a *different* extension, or
 * that `pi.sendMessage` from inside that handler reaches the session. Those are this file's job.
 *
 * Not a `.test.ts` file: it is a harness the shell suite runs, checked in rather than written into
 * the repo root at run time (a stray file in avocode's tree is the self-perturbation bug S3 and S6
 * both hit).
 *
 * Usage: tsx test/pi-supervise-drive.ts --cwd <repo> --agent-dir <dir> [--scores N] [--mutate FILE]
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  SessionManager,
  type ExtensionContextActions,
  type ExtensionActions,
  type ExtensionUIContext,
  type ModelRegistry,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { SteerDetails } from "../pi/extensions/avo-supervisor/supervisor.ts";

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

const cwd = arg("cwd");
const agentDir = arg("agent-dir");
if (cwd === undefined || agentDir === undefined) {
  console.error("usage: tsx test/pi-supervise-drive.ts --cwd <repo> --agent-dir <dir> [--scores N] [--mutate FILE]");
  process.exit(2);
}
const scores = Number(arg("scores") ?? 6);
const mutate = arg("mutate") ?? "impl.sh";

// ------------------------------------------------------------------ pi's own loader
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await loader.reload({ resolveProjectTrust: async () => true });
const loaded = loader.getExtensions();

// ------------------------------------------------------------------ pi's own runner
const session = SessionManager.inMemory(cwd);
const sent: { customType: string; details: SteerDetails }[] = [];
const notices: { message: string; type: string }[] = [];
let status: string | undefined;

const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, session, {} as unknown as ModelRegistry);

const unsupported = (name: string) => () => {
  throw new Error(`this harness does not implement pi.${name}`);
};
runner.bindCore(
  {
    // The real modes append the entry and then hand it to the agent; the entry is the half that
    // matters here, because it is what a reload and a branch read back.
    sendMessage: (message: { customType: string; content: string; display: boolean; details?: unknown }) => {
      session.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
      sent.push({ customType: message.customType, details: message.details as SteerDetails });
    },
    appendEntry: (customType: string, data?: unknown) => void session.appendCustomEntry(customType, data),
    sendUserMessage: unsupported("sendUserMessage"),
    setSessionName: unsupported("setSessionName"),
    getSessionName: () => session.getSessionName(),
    setLabel: unsupported("setLabel"),
    getActiveTools: () => runner.getAllRegisteredTools().map((t) => t.definition.name),
    getAllTools: () => [],
    setActiveTools: unsupported("setActiveTools"),
    refreshTools: () => {},
    getCommands: () => [],
    setModel: unsupported("setModel"),
    getThinkingLevel: () => "off",
    setThinkingLevel: unsupported("setThinkingLevel"),
  } as unknown as ExtensionActions,
  {
    getModel: () => undefined,
    getScopedModels: () => [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    getSignal: () => undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
  } satisfies ExtensionContextActions,
);
runner.setUIContext(
  {
    notify: (message: string, type = "info") => notices.push({ message, type }),
    setStatus: (_key: string, text: string | undefined) => {
      status = text;
    },
  } as unknown as ExtensionUIContext,
  "print",
);

await runner.emit({ type: "session_start", sessionFile: undefined, resumed: false } as never);

/** One tool call the way Pi makes it: execute the registered definition, then emit the result. */
async function callTool(name: string, params: Record<string, unknown>): Promise<unknown> {
  const def = runner.getToolDefinition(name);
  if (def === undefined) throw new Error(`${name} is not registered — the tools extension did not load`);
  let details: unknown;
  let isError = false;
  try {
    ({ details } = (await def.execute(`call-${name}`, params as never, undefined, undefined, runner.createContext())) as {
      details: unknown;
    });
  } catch (e) {
    isError = true;
    details = { error: (e as Error).message };
  }
  await runner.emitToolResult({
    type: "tool_result",
    toolCallId: `call-${name}`,
    toolName: name,
    input: params,
    content: [],
    isError,
    details,
  } as ToolResultEvent);
  return details;
}

// ---------------------------------------------------------------- the scripted stall
// v1 first, so there is a best to stall against. Then a run of candidates that only get worse:
// nothing improves, `since_best` climbs past the threshold and keeps climbing.
const commit = await callTool("avo_commit", { why: "drive: the baseline candidate" });
const afterCommit = sent.length;

for (let i = 0; i < scores; i++) {
  appendFileSync(join(cwd, mutate), `# padding ${i}\n`);
  await callTool("avo_score", {});
}
const afterStall = sent.length;

// A branch back to before the directive is a model that never read it, so it must be steered
// again. `resetLeaf()` rather than `branch(firstEntry)`, because the first entry IS the directive
// here — branching *to* it would leave it on the branch and prove the opposite of what is meant.
// `session_start` is how pi rebuilds extension state after a session replacement.
const beforeBranch = session.getBranch().length;
session.resetLeaf();
await runner.emit({ type: "session_start", sessionFile: undefined, resumed: true } as never);
await callTool("avo_score", {});

console.log(
  JSON.stringify({
    loadErrors: loaded.errors.map((e) => (typeof e === "string" ? e : JSON.stringify(e))),
    extensions: loaded.extensions.map((e) => e.path),
    tools: runner.getAllRegisteredTools().map((t) => t.definition.name).sort(),
    handlesToolResult: runner.hasHandlers("tool_result"),
    commit,
    /** How many directives the stalling run produced. One is the whole point. */
    steersDuringStall: afterStall - afterCommit,
    branchEntriesBefore: beforeBranch,
    steersAfterBranch: sent.length - afterStall,
    customTypes: [...new Set(sent.map((s) => s.customType))],
    episodes: sent.map((s) => s.details?.episodes ?? []),
    kinds: sent.map((s) => s.details?.kinds ?? []),
    sinceBest: sent.map((s) => s.details?.state?.since_best ?? null),
    status,
    notices,
  }),
);
