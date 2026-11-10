import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GameStore, RunStore, parseLines } from "../store.js";
import {
  changeCounts, compareRow, compareRows, costPerLevel, gameMetrics, levelsSeen, loopRuns, lostSteps, stepProblems,
} from "../metrics.js";
import { ticks } from "../charts.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "..", "..", "tests", "fixtures", "runs", "toy");
const read = (...p) => readFileSync(join(FIXTURE, ...p), "utf8");

function load() {
  const run = new RunStore("toy");
  run.addRun(parseLines(read("run.jsonl")));
  const g = run.game("toy");
  g.add(parseLines(read("games", "toy", "events.jsonl")));
  const frames = new Map(parseLines(read("games", "toy", "frames.jsonl")).map((f) => [f.step, f]));
  return { run, g, frames, manifest: JSON.parse(read("manifest.json")) };
}

test("change map keeps levels apart", () => {
  const { g, frames } = load();
  const get = (s) => frames.get(s);
  const l0 = changeCounts(g.steps, get, 0);
  const l1 = changeCounts(g.steps, get, 1);
  // Level 0: steps 1..11, minus RESET (3) and no-op.
  assert.ok(l0.steps <= 10);
  assert.equal(l1.steps, 8);
  // Level 1 base is the grid after step 12.
  const f12 = frames.get(12);
  assert.equal(l1.base.hex, f12.frames[f12.frames.length - 1]);
  // Only level 0 steps feed level 0.
  const only = (lvl) => g.steps.filter((s) => s.before.levels_completed === lvl
    && s.after.levels_completed === lvl && s.action.name !== "RESET").length;
  assert.ok(l0.steps <= only(0));
  assert.equal(changeCounts(g.steps, get, 0, "ACTION4").steps, 6);
  assert.deepEqual(levelsSeen(g), [0, 1, 2]);
});

test("lost steps and loops", () => {
  const { g } = load();
  const probs = stepProblems(g);
  assert.equal(probs.get(2).noop, true);
  assert.equal(probs.get(14).repeat, true);
  assert.equal(lostSteps(g), 2);
  assert.deepEqual(loopRuns(g), []);
  const h = new GameStore("x");
  const step = (n, noop) => ({ v: 1, type: "step", step: n, round: 1, action: { name: "ACTION1", x: null, y: null },
    diff: { noop }, flags: [], before: { levels_completed: 0 }, after: { levels_completed: 0 } });
  h.add([{ v: 1, type: "round_start", round: 1, level: 0 },
    step(1, false), step(2, true), step(3, true), step(4, true), step(5, false)]);
  assert.deepEqual(loopRuns(h), [{ round: 1, action: "ACTION1", first: 2, last: 4, count: 3 }]);
  assert.equal(lostSteps(h), 3);
});

test("open level, cost per level, compare row", () => {
  const { g, manifest } = load();
  const m = gameMetrics(g, Date.parse(g.lastTs));
  assert.equal(m.openLevelSteps, null);
  assert.equal(costPerLevel(g).length, 2);
  const row = compareRow("toy", manifest, g, Date.parse(g.lastTs));
  assert.equal(row.levels, 2);
  assert.equal(row.player, manifest.prompts.player);
  assert.deepEqual(row.stepsPerLevel, [12, 9]);
  assert.equal(row.lostSteps, 2);
  // Cut the game at step 15: level 1 is open.
  const h = new GameStore("cut");
  h.add(g.events.filter((e) => e.type !== "game_end" && (e.step === undefined || e.step <= 15)));
  assert.equal(gameMetrics(h).openLevelSteps, 3);
});

test("ticks use round steps", () => {
  const t = ticks(100, 8);
  assert.ok(t.every((v) => v % 20 === 0));
  assert.equal(t[t.length - 1], 100);
  assert.deepEqual(ticks(39, 4), [0, 10, 20, 30]);
  assert.deepEqual(ticks(2, 4), [0, 1, 2]);
  assert.deepEqual(ticks(0), [0]);
});

test("compare rows for two runs", () => {
  const a = load(), b = load();
  const mb = { ...b.manifest, prompts: { ...b.manifest.prompts, player: "other" } };
  const rows = compareRows([{ runId: "r2", manifest: mb, run: b.run }, { runId: "r1", manifest: a.manifest, run: a.run }],
    Date.parse(a.g.lastTs));
  assert.deepEqual(rows.map((r) => r.run), ["r1", "r2"]);
  assert.equal(rows[0].newPlayer, false);
  assert.equal(rows[1].newPlayer, true);
  assert.equal(rows[1].newScorer, false);
  assert.equal(rows[1].costPerLevel, rows[1].cost / 2);
});
