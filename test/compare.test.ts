import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compareVectors, relDelta, scoreVector, type Vector } from "../src/compare.ts";
import { CONFIG_PATH, DEFAULT_CONFIG, loadConfig, type AvoConfig } from "../src/config.ts";

const cfg = (over: Partial<AvoConfig> = {}): AvoConfig => ({ ...DEFAULT_CONFIG, ...over });

function repo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "avo-cmp-"));
  mkdirSync(join(dir, ".avo"), { recursive: true });
  for (const [p, body] of Object.entries(files)) writeFileSync(join(dir, p), body);
  return dir;
}

// ---------------------------------------------------------------- scoreVector

test("scoreVector flips a lower-is-better metric so higher always wins", () => {
  const v = scoreVector({ primary: 10, higher_is_better: false, scores: { a: 10, b: 4 } });
  assert.deepEqual(v, { a: -10, b: -4 });
});

test("scoreVector passes a higher-is-better metric through unchanged", () => {
  const v = scoreVector({ primary: 10, higher_is_better: true, scores: { a: 10 } });
  assert.deepEqual(v, { a: 10 });
});

test("a scorer with no scores object still yields a one-config vector under '*'", () => {
  assert.deepEqual(scoreVector({ primary: 3, higher_is_better: true, scores: {} }), { "*": 3 });
  assert.deepEqual(scoreVector({ primary: 3, higher_is_better: false, scores: {} }), { "*": -3 });
});

test("a failing attempt has an empty vector — there is nothing to rank", () => {
  assert.deepEqual(scoreVector({ primary: null, higher_is_better: true, scores: {} }), {});
});

// ---------------------------------------------------------------- relDelta

test("relDelta is a signed relative change against the magnitude of the baseline", () => {
  assert.equal(relDelta(110, 100), 0.1);
  assert.equal(relDelta(90, 100), -0.1);
  // direction-normalized lower-is-better values are negative; improving means moving toward zero
  assert.equal(relDelta(-8, -10), 0.2);
  assert.equal(relDelta(-12, -10), -0.2);
});

test("relDelta reports any move off a zero baseline as infinite, so no floor can swallow it", () => {
  assert.equal(relDelta(5, 0), Infinity);
  assert.equal(relDelta(-5, 0), -Infinity);
  assert.equal(relDelta(0, 0), 0);
});

// ---------------------------------------------------------------- the commit rule

test("the first version commits unconditionally — there is nothing to beat", () => {
  const c = compareVectors({ a: 1 }, null, cfg());
  assert.equal(c.commit, true);
  assert.equal(c.decision, "first");
  assert.deepEqual(c.added, ["a"]);
});

test("dominate-or-tie commits when one config improves and none regress", () => {
  const c = compareVectors({ a: 11, b: 5 }, { a: 10, b: 5 }, cfg());
  assert.equal(c.commit, true);
  assert.equal(c.decision, "improved");
  assert.deepEqual(c.improved, ["a"]);
  assert.deepEqual(c.regressed, []);
});

test("a win on one config cannot pay for a regression on another", () => {
  const c = compareVectors({ a: 100, b: 1 }, { a: 10, b: 10 }, cfg());
  assert.equal(c.commit, false);
  assert.equal(c.decision, "regressed");
  assert.deepEqual(c.regressed, ["b"]);
  assert.match(c.reason, /cannot pay for/);
});

test("an exact tie is refused: the lineage records progress, not equal-scoring rewrites", () => {
  const c = compareVectors({ a: 10 }, { a: 10 }, cfg());
  assert.equal(c.commit, false);
  assert.equal(c.decision, "tie");
});

test("measuring less than the best version blocks the commit", () => {
  const c = compareVectors({ a: 99 }, { a: 10, b: 10 }, cfg());
  assert.equal(c.commit, false);
  assert.equal(c.decision, "missing-configs");
  assert.deepEqual(c.missing, ["b"]);
  assert.match(c.reason, /may not measure less/);
});

test("measuring *more* than the best version does not block it", () => {
  const c = compareVectors({ a: 11, b: 3 }, { a: 10 }, cfg());
  assert.equal(c.commit, true);
  assert.deepEqual(c.added, ["b"]);
  // a new config has no baseline, so it cannot be part of the improve/regress verdict
  assert.deepEqual(c.deltas.map((d) => d.config), ["a"]);
});

test("a flipped metric direction is refused rather than compared as if it had not flipped", () => {
  const c = compareVectors({ a: 1 }, { a: 10 }, cfg(), {
    candidateHigherIsBetter: true,
    bestHigherIsBetter: false,
  });
  assert.equal(c.commit, false);
  assert.equal(c.decision, "direction-changed");
  assert.match(c.reason, /not comparable/);
});

test("the floor is a symmetric noise band: neither a small win nor a small loss counts", () => {
  const floored = cfg({ floor: 0.05 });
  assert.equal(compareVectors({ a: 102 }, { a: 100 }, floored).decision, "tie");
  assert.equal(compareVectors({ a: 98 }, { a: 100 }, floored).decision, "tie");
  assert.equal(compareVectors({ a: 106 }, { a: 100 }, floored).decision, "improved");
  assert.equal(compareVectors({ a: 94 }, { a: 100 }, floored).decision, "regressed");
});

test("with a floor, a regression outside the band still blocks an improvement inside it", () => {
  const c = compareVectors({ a: 100.5, b: 80 }, { a: 100, b: 100 }, cfg({ floor: 0.02 }));
  assert.equal(c.commit, false);
  assert.equal(c.decision, "regressed");
});

// ---------------------------------------------------------------- mean reduction

test("reduce:mean lets a big win pay for a small loss — the point of opting into it", () => {
  const c = compareVectors({ a: 100, b: 9 }, { a: 10, b: 10 }, cfg({ reduce: "mean" }));
  assert.equal(c.commit, true);
  assert.equal(c.decision, "improved");
  assert.equal(c.mean?.best, 10);
  assert.equal(c.mean?.candidate, 54.5);
  // per-config verdicts are still reported, so the regression is visible in the record
  assert.deepEqual(c.regressed, ["b"]);
});

test("reduce:mean refuses a candidate whose mean does not move", () => {
  const c = compareVectors({ a: 12, b: 8 }, { a: 10, b: 10 }, cfg({ reduce: "mean" }));
  assert.equal(c.commit, false);
  assert.equal(c.decision, "tie");
});

test("weights steer the mean", () => {
  const weighted = cfg({ reduce: "mean", weights: { a: 3, b: 1 } });
  // a improves 20%, b regresses 20%; weighted 3:1 the mean rises
  const c = compareVectors({ a: 12, b: 8 }, { a: 10, b: 10 }, weighted);
  assert.equal(c.commit, true);
  assert.equal(c.mean?.candidate, 11);
});

test("reduce:mean still refuses to measure less than the best version", () => {
  const c = compareVectors({ a: 1000 }, { a: 10, b: 10 }, cfg({ reduce: "mean" }));
  assert.equal(c.decision, "missing-configs");
  assert.equal(c.commit, false);
});

test("all-zero weights are reported, not divided by", () => {
  const c = compareVectors({ a: 20 }, { a: 10 }, cfg({ reduce: "mean", weights: { a: 0 } }));
  assert.equal(c.commit, false);
  assert.match(c.reason, /weight/);
});

test("a floor of zero still requires a strict improvement", () => {
  const tiny: Vector = { a: 10.000001 };
  assert.equal(compareVectors(tiny, { a: 10 }, cfg()).commit, true);
  assert.equal(compareVectors({ a: 10 }, { a: 10 }, cfg()).commit, false);
});

// ---------------------------------------------------------------- .avo/config.json

test("a missing config file is the common case and never warns", () => {
  const dir = repo();
  const loaded = loadConfig(dir);
  assert.deepEqual(loaded.config, DEFAULT_CONFIG);
  assert.deepEqual(loaded.warnings, []);
  assert.equal(loaded.present, false);
  rmSync(dir, { recursive: true, force: true });
});

test("a well-formed config file is read", () => {
  const dir = repo({
    [CONFIG_PATH]: JSON.stringify({ reduce: "mean", floor: 0.02, weights: { a: 2 }, configs: ["b1", "b8"] }),
  });
  const { config, warnings } = loadConfig(dir);
  assert.deepEqual(warnings, []);
  assert.equal(config.reduce, "mean");
  assert.equal(config.floor, 0.02);
  assert.deepEqual(config.weights, { a: 2 });
  assert.deepEqual(config.configs, ["b1", "b8"]);
  rmSync(dir, { recursive: true, force: true });
});

test("a malformed config falls back to the defaults with a warning naming the field", () => {
  const dir = repo({ [CONFIG_PATH]: JSON.stringify({ reduce: "average" }) });
  const { config, warnings } = loadConfig(dir);
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] as string, /'reduce'/);
  rmSync(dir, { recursive: true, force: true });
});

test("unparseable JSON degrades instead of crashing (invariant 4)", () => {
  const dir = repo({ [CONFIG_PATH]: "{not json" });
  const { config, warnings } = loadConfig(dir);
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.match(warnings[0] as string, /not valid JSON/);
  rmSync(dir, { recursive: true, force: true });
});

test("invalid config names are dropped rather than handed to the scorer", () => {
  const dir = repo({ [CONFIG_PATH]: JSON.stringify({ configs: ["ok", "--rm -rf"] }) });
  const { config, warnings } = loadConfig(dir);
  assert.equal(config.configs, null);
  assert.match(warnings[0] as string, /invalid config names/);
  rmSync(dir, { recursive: true, force: true });
});

test("a negative floor is rejected — the noise band cannot be inverted", () => {
  const dir = repo({ [CONFIG_PATH]: JSON.stringify({ floor: -1 }) });
  const { config, warnings } = loadConfig(dir);
  assert.equal(config.floor, 0);
  assert.match(warnings[0] as string, /'floor'/);
  rmSync(dir, { recursive: true, force: true });
});
