import { test } from "node:test";
import assert from "node:assert/strict";
import { actionLabel, actionText, duration, money } from "../html.js";

test("duration rounds before split", () => {
  assert.equal(duration(899.586), "15m 0s");
  assert.equal(duration(59.6), "1m 0s");
  assert.equal(duration(12.2), "12s");
  assert.equal(duration(null), "—");
});

test("money keeps small costs", () => {
  assert.notEqual(money(0.000168), "$0.000");
  assert.equal(money(0.000168), "$0.0002");
  assert.equal(money(0.00003), "<$0.0001");
  assert.equal(money(0.03), "$0.030");
  assert.equal(money(1.233342), "$1.23");
  assert.equal(money(0), "$0");
  assert.equal(money(null), "$?");
});

test("action label takes direction first", () => {
  assert.equal(actionLabel("Moves player obj#6 up 5 cells; seen seven times."), "up");
  assert.equal(actionLabel("Moves down 5 cells when unblocked."), "down");
  assert.equal(actionLabel("Rotates the HUD clockwise. Unconfirmed."), "rotates hud clockwise");
  assert.equal(actionLabel("Moves the 9,c player up 5 cells; seen six times."), "up");
  assert.equal(actionLabel("Paints the 5/b cell, then waits."), "paints cell");
  assert.equal(actionLabel("unknown"), "");
  assert.equal(actionLabel(undefined), "");
});

test("action text joins name and label", () => {
  const model = { allowable_actions: { ACTION1: "Moves player up 5 cells.", ACTION6: "Selects a tile." } };
  assert.equal(actionText({ name: "ACTION1" }, model), "ACTION1: up");
  assert.equal(actionText({ name: "ACTION6", x: 3, y: 4 }, model), "ACTION6 @ (3, 4): selects tile");
  assert.equal(actionText({ name: "ACTION2" }, model), "ACTION2");
  assert.equal(actionText({ name: "RESET", x: null }), "RESET");
});
