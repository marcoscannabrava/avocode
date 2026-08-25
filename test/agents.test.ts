import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILTIN_AGENT_NAMES,
  CLAUDE,
  CODEX,
  PI,
  customTemplate,
  parseAgentOutput,
  resolveTemplate,
  type CustomAgent,
} from "../src/agents.ts";

// The three flag assertions below are the whole reason this file exists. Each names a flag whose
// absence fails *silently* — the agent starts, does nothing useful, exits 0 — so a test that only
// checked "some args were produced" would pass while `avo fan` returned N empty probes.

test("the pi template passes --approve, without which project skills never load", () => {
  const args = PI.args({ prompt: "do the thing", model: null });
  assert.ok(args.includes("--approve"), `expected --approve in ${args.join(" ")}`);
  assert.deepEqual(args.slice(0, 4), ["--mode", "json", "--print", "--approve"]);
  assert.deepEqual(args.slice(-2), ["--", "do the thing"]);
});

test("the claude template passes --verbose and bypassPermissions", () => {
  const args = CLAUDE.args({ prompt: "p", model: "haiku" });
  assert.ok(args.includes("--verbose"), "stream-json under --print requires --verbose");
  assert.deepEqual(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2), [
    "--permission-mode",
    "bypassPermissions",
  ]);
  assert.deepEqual(args.slice(-4), ["--model", "haiku", "--", "p"]);
});

test("the codex template sandboxes writes to the worktree rather than bypassing the sandbox", () => {
  const args = CODEX.args({ prompt: "p", model: null });
  assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2), ["--sandbox", "workspace-write"]);
  assert.ok(!args.some((a) => a.includes("dangerously")), "workspace-write is the point; do not bypass it");
  assert.equal(args[0], "exec");
});

test("a prompt beginning with a dash is a prompt, not a flag", () => {
  for (const t of [PI, CLAUDE, CODEX]) {
    const args = t.args({ prompt: "--help me", model: null });
    assert.equal(args.at(-2), "--", `${t.name} must end option parsing before the prompt`);
    assert.equal(args.at(-1), "--help me");
  }
});

test("no model means no --model flag at all, not an empty one", () => {
  for (const t of [PI, CLAUDE, CODEX]) {
    const args = t.args({ prompt: "p", model: null });
    assert.ok(!args.includes("--model"), `${t.name} passed --model with nothing to give it`);
  }
});

const CUSTOM: CustomAgent = {
  name: "stub",
  command: "./stub.sh",
  args: ["--headless", "--model={model}", "{prompt}"],
  format: "text",
};

test("a custom template substitutes placeholders inside an argument", () => {
  assert.deepEqual(customTemplate(CUSTOM).args({ prompt: "hi", model: "tiny" }), [
    "--headless",
    "--model=tiny",
    "hi",
  ]);
});

test("an argument mentioning {model} disappears when there is no model", () => {
  assert.deepEqual(customTemplate(CUSTOM).args({ prompt: "hi", model: null }), ["--headless", "hi"]);
});

test("resolveTemplate finds the built-ins and the declared custom agent", () => {
  for (const n of BUILTIN_AGENT_NAMES) {
    const t = resolveTemplate(n, null);
    assert.ok(!("error" in t) && t.name === n);
  }
  const t = resolveTemplate("stub", CUSTOM);
  assert.ok(!("error" in t) && t.command === "./stub.sh");
});

test("an unknown agent names the alternatives and how to declare one", () => {
  const t = resolveTemplate("gpt", null);
  assert.ok("error" in t);
  assert.match(t.error, /pi \| claude \| codex/);
  assert.match(t.error, /\.avo\/config\.json/);
});

test("an unknown agent alongside a custom one lists the custom name too", () => {
  const t = resolveTemplate("gpt", CUSTOM);
  assert.ok("error" in t);
  assert.match(t.error, /pi \| claude \| codex \| stub/);
});

// ------------------------------------------------------- reading what the agent said
// The fixtures below are trimmed from real runs of claude 2.1.241, codex-cli 0.147.0 and the shapes
// pi 0.84.3 documents in docs/json.md — not from memory.

const CLAUDE_STREAM = [
  `{"type":"system","subtype":"init","session_id":"s","model":"claude-haiku-4-5-20251001"}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"OK"}]}}`,
  `{"type":"result","subtype":"success","is_error":false,"result":"edited kernel.py","usage":{"input_tokens":10,"output_tokens":36}}`,
].join("\n");

test("claude stream-json: the result line carries both the summary and the tokens", () => {
  assert.deepEqual(parseAgentOutput("claude", CLAUDE_STREAM), {
    summary: "edited kernel.py",
    tokens: { input: 10, output: 36, cache_read: 0, cache_write: 0 },
    cost_usd: null,
  });
});

// Trimmed verbatim from iteration 1 of the S9b-1 run against bench/fuzzysearch — the turn #43 was
// filed about. 24 uncached input tokens and half a million cached ones: reading `input_tokens`
// alone reports 0.004% of what the turn actually sent.
const CLAUDE_CACHED = [
  `{"type":"result","subtype":"success","is_error":false,"result":"rewrote the scan","total_cost_usd":1.1622600000000003,`,
  `"usage":{"input_tokens":24,"cache_creation_input_tokens":49963,"cache_read_input_tokens":523326,`,
  `"output_tokens":15977,"output_tokens_details":{"thinking_tokens":9539},"service_tier":"standard"}}`,
].join("");

test("claude's cached input is kept, and kept apart from the uncached input it is priced against", () => {
  assert.deepEqual(parseAgentOutput("claude", CLAUDE_CACHED), {
    summary: "rewrote the scan",
    tokens: { input: 24, output: 15977, cache_read: 523326, cache_write: 49963 },
    cost_usd: 1.1622600000000003,
  });
});

test("claude's own total_cost_usd is recorded rather than re-derived from token arithmetic", () => {
  // The agent knows its per-model rates and we do not; #28's budget has to spend this number.
  assert.equal(parseAgentOutput("claude", CLAUDE_CACHED).cost_usd, 1.1622600000000003);
  assert.equal(parseAgentOutput("claude", CLAUDE_STREAM).cost_usd, null);
});

const PI_STREAM = [
  `{"type":"session","version":3,"id":"u","cwd":"/tmp"}`,
  `{"type":"message_update","usage":{"input":12,"output":3,"cacheRead":0,"cacheWrite":0,"cost":0}}`,
  `{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"tried loop unrolling"}],"usage":{"input":12,"output":40,"cacheRead":0,"cacheWrite":0,"cost":0}}}`,
  `{"type":"agent_end","messages":[]}`,
].join("\n");

test("pi json mode: message_end wins over the streamed updates, and thinking is not the summary", () => {
  assert.deepEqual(parseAgentOutput("pi", PI_STREAM), {
    summary: "tried loop unrolling",
    tokens: { input: 12, output: 40, cache_read: 0, cache_write: 0 },
    cost_usd: 0,
  });
});

test("pi reports cacheRead/cacheWrite/cost in its own camelCase, and all three are read", () => {
  const out = `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"x"}],"usage":{"input":12,"output":40,"cacheRead":9000,"cacheWrite":700,"cost":0.42}}}`;
  assert.deepEqual(parseAgentOutput("pi", out), {
    summary: "x",
    tokens: { input: 12, output: 40, cache_read: 9000, cache_write: 700 },
    cost_usd: 0.42,
  });
});

const CODEX_STREAM = [
  `{"type":"thread.started","thread_id":"t"}`,
  `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"rewrote the inner loop"}}`,
  `{"type":"turn.completed","usage":{"input_tokens":13138,"cached_input_tokens":0,"output_tokens":5}}`,
].join("\n");

test("codex json: item.completed is the message, turn.completed is the usage", () => {
  assert.deepEqual(parseAgentOutput("codex", CODEX_STREAM), {
    summary: "rewrote the inner loop",
    tokens: { input: 13138, output: 5, cache_read: 0, cache_write: 0 },
    cost_usd: null,
  });
});

// The one place the three agents genuinely disagree, and the reason `input` is normalized rather
// than copied: codex follows OpenAI, where cached_input_tokens is a SUBSET of input_tokens, while
// claude and pi report the cached portion disjointly. Left raw, `input + cache_read` would count
// codex's cache hits twice and claude's not at all.
test("codex's cached_input_tokens is a subset of input_tokens, so it is subtracted out", () => {
  const out = `{"type":"turn.completed","usage":{"input_tokens":13138,"cached_input_tokens":12000,"output_tokens":5}}`;
  assert.deepEqual(parseAgentOutput("codex", out).tokens, {
    input: 1138,
    output: 5,
    cache_read: 12000,
    cache_write: 0,
  });
});

test("a nonsensical cached > input never yields a negative uncached count", () => {
  const out = `{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":99,"output_tokens":5}}`;
  assert.equal(parseAgentOutput("codex", out).tokens?.input, 0);
});

test("a killed agent's half-written last line does not lose the earlier ones", () => {
  const truncated = `${CODEX_STREAM.split("\n").slice(0, 2).join("\n")}\n{"type":"turn.comp`;
  assert.equal(parseAgentOutput("codex", truncated).summary, "rewrote the inner loop");
});

test("noise interleaved with the event stream is skipped, not fatal", () => {
  const noisy = `warning: something\n${CLAUDE_STREAM}\nnpm notice new version`;
  assert.equal(parseAgentOutput("claude", noisy).summary, "edited kernel.py");
});

test("a structured agent that printed no final message falls back to its last line", () => {
  const out = `{"type":"system","subtype":"init"}\nfatal: out of credits`;
  assert.deepEqual(parseAgentOutput("claude", out), {
    summary: "fatal: out of credits",
    tokens: null,
    cost_usd: null,
  });
});

test("a text agent's summary is its last non-empty line", () => {
  assert.deepEqual(parseAgentOutput("text", "step one\nstep two\n\n"), {
    summary: "step two",
    tokens: null,
    cost_usd: null,
  });
});

test("no output at all is null, not an empty string", () => {
  for (const f of ["pi", "claude", "codex", "text"] as const) {
    assert.equal(parseAgentOutput(f, "   \n\n").summary, null);
  }
});

test("usage carrying only cached input is a real reading, not the absence of one", () => {
  // Before #43 this returned null: the two fields it does carry were the two being dropped.
  const out = `{"type":"result","result":"x","usage":{"cache_read_input_tokens":5}}`;
  assert.deepEqual(parseAgentOutput("claude", out).tokens, { input: 0, output: 0, cache_read: 5, cache_write: 0 });
});

test("usage with none of the four field shapes present is null rather than zeros", () => {
  const out = `{"type":"result","result":"x","usage":{"service_tier":"standard"}}`;
  assert.equal(parseAgentOutput("claude", out).tokens, null);
});
