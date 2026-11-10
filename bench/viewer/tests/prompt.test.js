import { test } from "node:test";
import assert from "node:assert/strict";
import { headingOf, objBox, promptSections } from "../prompt.js";

test("sections split at known headings", () => {
  const text = "Model (version 3):\nGoal: x\nRound 1, step 2 of this round.\nCurrent State:\nobj#1 a\nhistory: 2 steps\naround obj#6 at x=1..2 y=3..4 (step 5):\nPick the next action.";
  const names = promptSections(text).map((s) => s.name);
  assert.deepEqual(names, ["Model", "Round", "Current State", "history", "around", "Task"]);
  assert.equal(headingOf("Old Model (version 65):"), "Old Model");
  assert.equal(headingOf("  obj#1"), null);
});

test("object boxes", () => {
  assert.deepEqual(objBox("obj#6 sprite 9,c size 25 at x=34..38 y=15..19"), { id: 6, x0: 34, x1: 38, y0: 15, y1: 19 });
  assert.deepEqual(objBox("obj#14 region 3 at x=13 y=61..62"), { id: 14, x0: 13, x1: 13, y0: 61, y1: 62 });
  assert.equal(objBox("background 4, 14 objects"), null);
});
