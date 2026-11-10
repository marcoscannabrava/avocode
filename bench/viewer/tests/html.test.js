import { test } from "node:test";
import assert from "node:assert/strict";
import { duration, money } from "../html.js";

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
