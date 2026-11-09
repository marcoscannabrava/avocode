import { test } from "node:test";
import assert from "node:assert/strict";
import { Tail, splitLines } from "../tail.js";

test("splitLines keeps the partial line", () => {
  assert.deepEqual(splitLines("", '{"a":1}\n{"b"'), { lines: ['{"a":1}'], partial: '{"b"' });
  assert.deepEqual(splitLines('{"b"', ":2}\n"), { lines: ['{"b":2}'], partial: "" });
});

function fakeServer(file) {
  return async (url, opts) => {
    const range = opts.headers.Range;
    const data = new TextEncoder().encode(file.text);
    const start = range ? Number(range.match(/bytes=(\d+)-/)[1]) : 0;
    if (start >= data.length && range) return { status: 416, ok: false };
    const body = data.slice(start);
    return { status: range ? 206 : 200, ok: true, arrayBuffer: async () => body.buffer };
  };
}

test("Tail reads only new bytes and waits for full lines", async () => {
  const file = { text: '{"n":1}\n{"n":' };
  const tail = new Tail("/x", fakeServer(file));
  assert.deepEqual(await tail.poll(), [{ n: 1 }]);
  assert.deepEqual(await tail.poll(), []);
  file.text += '2}\n{"n":3}\n';
  assert.deepEqual(await tail.poll(), [{ n: 2 }, { n: 3 }]);
  assert.deepEqual(await tail.poll(), []);
});

test("Tail handles multi-byte text split across polls", async () => {
  const full = '{"s":"é"}\n';
  const bytes = new TextEncoder().encode(full);
  let sent = 0;
  const parts = [5, bytes.length];
  const tail = new Tail("/x", async () => {
    const end = parts.shift();
    const body = bytes.slice(sent, end);
    sent = end;
    return { status: 206, ok: true, arrayBuffer: async () => body.buffer };
  });
  assert.deepEqual(await tail.poll(), []);
  assert.deepEqual(await tail.poll(), [{ s: "é" }]);
});
