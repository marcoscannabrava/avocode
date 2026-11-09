import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GameStore, RunStore, parseLines } from "../store.js";
import {
  actionTable, churnByRound, gameMetrics, health, hypothesisGroups, levelSeries, percentile,
  roundTable, runMetrics, sumCost,
} from "../metrics.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "..", "..", "tests", "fixtures", "runs", "toy");

function load() {
  const run = new RunStore("toy");
  run.addRun(parseLines(readFileSync(join(FIXTURE, "run.jsonl"), "utf8")));
  const g = run.game("toy");
  g.add(parseLines(readFileSync(join(FIXTURE, "games", "toy", "events.jsonl"), "utf8")));
  return { run, g };
}

test("percentile and sumCost", () => {
  assert.equal(percentile([5, 1, 3], 50), 3);
  assert.equal(percentile([], 50), null);
  assert.equal(sumCost([0.1, 0.2]), 0.3);
  assert.equal(sumCost([0.1, null]), null);
});

test("game metrics on the fixture", () => {
  const { g } = load();
  const m = gameMetrics(g, Date.parse(g.lastTs));
  assert.equal(m.levels, 2);
  assert.equal(m.winLevels, 2);
  assert.equal(m.steps, 21);
  assert.equal(m.rounds, 2);
  assert.equal(m.outcome, "won");
  assert.equal(m.health, "won");
  assert.equal(m.repeatRounds, 0);
  assert.ok(m.repeatStateRate > 0);
  assert.equal(m.cost, 0);
  assert.equal(m.llm.player.calls, 20);
  assert.deepEqual(m.stepsPerLevel, [12, 9]);
  assert.deepEqual(m.roundsPerLevel, [2, 1]);
  assert.equal(m.modelChurn, g.models.length / 2);
});

test("round table", () => {
  const { g } = load();
  const rows = roundTable(g);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].outcome, "failed");
  assert.match(rows[0].hypothesis, /wall/);
  assert.equal(rows[1].outcome, "won");
  assert.equal(rows[1].endLevel, 2);
  assert.equal(rows[0].steps + rows[1].steps, 21);
});

test("action table", () => {
  const { g } = load();
  const rows = actionTable(g);
  const reset = rows.find((r) => r.action === "RESET");
  assert.equal(reset.uses, 1);
  const a1 = rows.find((r) => r.action === "ACTION1");
  assert.equal(a1.levelsAfter, 1);
  assert.equal(a1.modelSays, "up");
});

test("level series, run metrics, churn, hypotheses", () => {
  const { run, g } = load();
  const pts = levelSeries(g);
  assert.deepEqual(pts[0], [0, 0]);
  assert.deepEqual(pts[pts.length - 1], [21, 2]);
  const rm = runMetrics(run, Date.parse(g.lastTs));
  assert.equal(rm.gamesWon, 1);
  assert.equal(rm.levels, 2);
  assert.equal(rm.live, false);
  const churn = churnByRound(g);
  assert.equal(churn.reduce((a, c) => a + c.count, 0), g.models.length);
  const last = g.models[g.models.length - 1].model;
  assert.equal(hypothesisGroups(last)[0].rounds.length, 1);
});

test("health rules", () => {
  const g = new GameStore("x");
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  const ts = (s) => new Date(t0 + s * 1000).toISOString();
  assert.equal(health(g, t0), "pending");
  g.add([{ v: 1, type: "game_start", ts: ts(0) }]);
  assert.equal(health(g, t0 + 10_000), "playing");
  assert.equal(health(g, t0 + 200_000), "stalled");
  g.add([{ v: 1, type: "llm_start", call_id: "p-1", role: "player", ts: ts(1) }]);
  assert.equal(health(g, t0 + 40_000), "waiting");
  g.add([{ v: 1, type: "error", ts: ts(2) }]);
  assert.equal(health(g, t0 + 40_000), "error");
});

test("unknown schema version is flagged", () => {
  const g = new GameStore("x");
  g.add([{ v: 99, type: "step" }]);
  assert.equal(g.badVersion, 99);
  assert.equal(g.steps.length, 0);
});
