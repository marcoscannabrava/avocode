import { test } from "node:test";
import assert from "node:assert/strict";
import { elementBoxes, elementName, elementsAt } from "../elements.js";

test("element name drops coordinates", () => {
  assert.equal(elementName("0/1 at x=20..22, y=31..33"), "0/1");
  assert.equal(elementName("9,c sprite x=34..38 y=15..19 (obj#6)"), "9,c sprite (obj#6)");
  assert.equal(elementName("3 region (obj#0), x=14..53 y=8..49"), "3 region (obj#0)");
});

test("element boxes need x and y", () => {
  const model = { element_breakdown: {
    "c/9 at x=19..23, y=25..29": "player",
    "4 background": "wall",
    "dot x=5 y=6": "one cell",
  } };
  const boxes = elementBoxes(model);
  assert.equal(boxes.length, 2);
  assert.deepEqual([boxes[0].x0, boxes[0].x1, boxes[0].y0, boxes[0].y1], [19, 23, 25, 29]);
  assert.deepEqual([boxes[1].x0, boxes[1].x1], [5, 5]);
  assert.equal(elementsAt(boxes, 20, 26)[0].text, "player");
  assert.equal(elementsAt(boxes, 0, 0).length, 0);
  assert.deepEqual(elementBoxes(null), []);
});
