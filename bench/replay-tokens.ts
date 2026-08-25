/**
 * Re-parses a finished `avo run`'s raw agent logs and prints them next to what its manifest
 * recorded — an audit of the harness's own bookkeeping, from bytes it already wrote.
 *
 *     npx tsx bench/replay-tokens.ts <target-repo>/.avo/runs/<run-id>
 *
 * Written for #43, where the manifest reported 44 input tokens for a loop that sent 985,039, and
 * kept because the same comparison is what tells you whether the *next* run's numbers can be
 * trusted. Nothing is re-run and no agent is spawned.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseAgentOutput } from "../src/agents.ts";

const runDir = process.argv[2];
const logs = join(runDir, "logs");
const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));

const n = (x: number) => x.toLocaleString("en-US");
const rows: string[] = [];
let tot = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
let cost = 0;
let costSeen = false;

for (const f of readdirSync(logs).sort((a, b) => parseInt(a) - parseInt(b))) {
  const iter = parseInt(f);
  const parsed = parseAgentOutput("claude", readFileSync(join(logs, f), "utf8"));
  const was = manifest.iterations.find((i: { iter: number }) => i.iter === iter)?.agent?.tokens ?? null;
  const t = parsed.tokens;
  if (t !== null) {
    tot = {
      input: tot.input + t.input,
      output: tot.output + t.output,
      cache_read: tot.cache_read + t.cache_read,
      cache_write: tot.cache_write + t.cache_write,
    };
  }
  if (parsed.cost_usd !== null) {
    cost += parsed.cost_usd;
    costSeen = true;
  }
  const bytes = readFileSync(join(logs, f)).length;
  const capped = bytes >= 200_000;
  rows.push(
    `  it ${iter}  log ${n(bytes)} bytes${capped ? "  <- OVER the 200KB cap; the result event was cut off" : ""}` +
      `\n        manifest recorded  ${was === null ? "nothing at all" : `in ${n(was.input)} / out ${n(was.output)}`}` +
      `\n        replayed           ${t === null ? "nothing at all" : `in ${n(t.input)} / out ${n(t.output)} / cache read ${n(t.cache_read)} + write ${n(t.cache_write)}`}` +
      `   cost ${parsed.cost_usd === null ? "not in this log" : `$${parsed.cost_usd.toFixed(4)}`}` +
      (t === null
        ? ""
        : `\n        input actually sent ${n(t.input + t.cache_read + t.cache_write)}; the manifest recorded ${n(was?.input ?? 0)} of it` +
          ` (${(((was?.input ?? 0) / (t.input + t.cache_read + t.cache_write)) * 100).toFixed(4)}%)`),
  );
}

const mt = manifest.tokens ?? { input: 0, output: 0 };
console.log(`# ${process.env["AVO_REPLAY_TITLE"] ?? "avo run: manifest vs. the agent logs behind it"}`);
console.log(`#`);
console.log(`# ${runDir}`);
console.log(`# Same six raw claude logs the run already wrote, re-parsed by the fixed parser. Nothing`);
console.log(`# is re-run and no agent is spawned: the evidence is that the bytes were always there.`);
console.log(`#`);
console.log(rows.join("\n"));
console.log("");
console.log(`  manifest total   in ${n(mt.input)} / out ${n(mt.output)}   cost: not recorded`);
console.log(
  `  replayed total   in ${n(tot.input)} / out ${n(tot.output)} / cache read ${n(tot.cache_read)} + write ${n(tot.cache_write)}` +
    `   cost: ${costSeen ? `$${cost.toFixed(2)}` : "not reported"}`,
);
const sent = tot.input + tot.cache_read + tot.cache_write;
console.log("");
console.log(`  input tokens the run actually sent:  ${n(sent)}`);
console.log(`  input tokens the manifest recorded:  ${n(mt.input)}  (${((mt.input / sent) * 100).toFixed(4)}% of them)`);
console.log(`  cost the manifest could not report:  $${cost.toFixed(2)}`);
console.log("");
console.log(`# Why four of the six iterations replay to nothing, and what that cost:`);
console.log(`#`);
console.log(`# Their logs are ALREADY truncated on disk. spawnRunner capped stdout at the first 200KB`);
console.log(`# and dropped the rest, and a claude stream carries its usage, its cost and the agent's`);
console.log(`# final message in the LAST event. The correlation is exact — the two logs under the cap`);
console.log(`# have a result event, the four at or over it have none:`);
for (const f of readdirSync(logs).sort((a, b) => parseInt(a) - parseInt(b))) {
  const raw = readFileSync(join(logs, f), "utf8");
  const bytes = Buffer.byteLength(raw);
  console.log(
    `#   ${f}  ${String(n(bytes)).padStart(9)} bytes  ${bytes >= 200_000 ? "capped " : "intact "}` +
      ` result event: ${raw.includes('"type":"result"') ? "present" : "GONE"}`,
  );
}
console.log(`#`);
console.log(`# So the four numbers above are a FLOOR on what the run cost: the true total is higher by`);
console.log(`# whatever iterations 3-6 spent, which those logs can no longer say. spawnRunner now keeps`);
console.log(`# a 50KB rolling tail inside the same 200KB budget, so a future run records all six.`);
