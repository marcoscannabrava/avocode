import { test } from "node:test";
import assert from "node:assert/strict";
import { diffHtml, diffLines, diffWords, foldSame, keyedDiffOps } from "../textdiff.js";

test("line diff", () => {
  const ops = diffLines("a\nb\nc\nd", "a\nx\nc\nd\ne");
  assert.deepEqual(ops.map((o) => o.op + o.text), ["samea", "delb", "addx", "samec", "samed", "adde"]);
  assert.deepEqual(diffLines("", "").map((o) => o.op), ["same"]);
});

test("fold keeps context", () => {
  const a = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
  const b = a.replace("l10", "L10");
  const ops = foldSame(diffLines(a, b), 2);
  assert.equal(ops.filter((o) => o.op === "fold").length, 2);
  assert.equal(ops.filter((o) => o.op === "same").length, 4);
  assert.equal(ops[0].op, "fold");
  assert.equal(ops[0].count, 8);
});

test("word diff marks only changed words", () => {
  const ops = diffWords("obj#6 at x=34..38 y=15..19", "obj#6 at x=34..38 y=10..14");
  assert.ok(ops.some((o) => o.op === "del" && o.text === "15..19"));
  assert.ok(!ops.some((o) => o.op !== "same" && o.text === "obj#6"));
  const html = diffHtml(diffLines("a b c", "a x c"));
  assert.match(html, /<mark>b<\/mark>/);
  assert.match(html, /<mark>x<\/mark>/);
});

test("element keys pair by obj id", () => {
  const a = { "colors 9/c, obj#6, x=19..23 y=30..34": "player", "color 4 background": "floor" };
  const b = { "colors 9/c, obj#6, x=19..23 y=25..29": "player", "color 4 background": "floor" };
  const ops = keyedDiffOps(a, b);
  assert.equal(ops.length, 2);
  assert.equal(ops[0].op, "del");
  assert.equal(ops[1].op, "add");
  assert.match(ops[1].text, /y=25..29/);
  const html = diffHtml(ops);
  assert.match(html, /<mark>25..29<\/mark>/);
  assert.ok(!/<mark>player/.test(html));
});
