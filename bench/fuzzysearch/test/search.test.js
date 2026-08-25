// PROTECTED -- part of `f`. Editing this file makes every score `correct: false`.
//
// The correctness gate. Every case here is checked against bench/reference.js or against a hand
// computed answer, never against `search`'s own output -- a gate that trusts the code it judges is
// not a gate.

import assert from "node:assert/strict";
import test from "node:test";
import { search } from "../src/search.js";
import { canonical, referenceDistance, referenceSearch } from "../bench/reference.js";
import { words } from "../bench/corpus.js";

const like = (queries, corpus, k) =>
  assert.equal(canonical(search(queries, corpus, k)), canonical(referenceSearch(queries, corpus, k)));

test("it exports a search function", () => {
  assert.equal(typeof search, "function");
});

test("no queries and no corpus both yield nothing", () => {
  assert.deepEqual(search([], ["alpha"], 2), []);
  assert.deepEqual(search(["alpha"], [], 2), []);
  assert.deepEqual(search([], [], 2), []);
});

test("k=0 admits exact matches only", () => {
  const got = search(["alpha"], ["alpha", "alpho", "alph", "alphas"], 0);
  assert.equal(canonical(got), "alpha alpha 0");
});

test("the reported distance is the true distance, not just a number <= k", () => {
  for (const [a, b, d] of [
    ["kitten", "sitting", 3],
    ["flaw", "lawn", 2],
    ["", "abc", 3],
    ["abc", "", 3],
    ["same", "same", 0],
    ["ab", "ba", 2],
  ]) {
    assert.equal(referenceDistance(a, b), d, `reference disagrees on ${a}/${b}`);
    const got = search([a], [b], d);
    assert.equal(canonical(got), `${a} ${b} ${d}`);
    // ...and one below the true distance must not match at all.
    if (d > 0) assert.deepEqual(search([a], [b], d - 1), []);
  }
});

test("an empty query still matches short words", () => {
  like([""], ["", "a", "ab", "abc"], 2);
});

test("a duplicated corpus entry is reported once per occurrence", () => {
  const got = search(["cat"], ["cat", "cat", "cot"], 1);
  assert.equal(canonical(got), "cat cat 0\ncat cat 0\ncat cot 1");
});

test("a query that matches nothing yields nothing for that query", () => {
  const got = search(["zzzzzzzzzz", "cat"], ["cat"], 1);
  assert.equal(canonical(got), "cat cat 0");
});

test("every query is searched, not just the first", () => {
  like(["cat", "dog", "bird"], ["cat", "cot", "dog", "dig", "bird", "bard"], 1);
});

test("unicode is compared by code unit, the same way the reference does", () => {
  like(["café", "naïve"], ["cafe", "café", "naive", "naïve"], 1);
});

test("case is significant", () => {
  like(["Cat"], ["cat", "Cat", "CAT"], 1);
});

test("large k admits everything, so the result set is the full cross product", () => {
  const queries = ["a", "bb"];
  const corpus = ["ccc", "dddd"];
  assert.equal(search(queries, corpus, 99).length, 4);
  like(queries, corpus, 99);
});

test("it agrees with the reference on a slice of the real corpus, at k=1 and k=2", () => {
  const corpus = words(400, 7);
  const queries = words(25, 99);
  for (const k of [0, 1, 2, 3]) like(queries, corpus, k);
});

test("it agrees with the reference on a corpus of near-identical long words", () => {
  const base = "unbreakableness";
  const corpus = [base];
  for (let i = 0; i < base.length; i++) {
    corpus.push(base.slice(0, i) + base.slice(i + 1)); // deletions
    corpus.push(`${base.slice(0, i)}x${base.slice(i)}`); // insertions
    corpus.push(base.slice(0, i) + "x" + base.slice(i + 1)); // substitutions
  }
  like([base], corpus, 2);
});

test("it does not mutate its inputs", () => {
  const queries = ["cat", "dog"];
  const corpus = ["cat", "cot", "dog"];
  search(queries, corpus, 2);
  assert.deepEqual(queries, ["cat", "dog"]);
  assert.deepEqual(corpus, ["cat", "cot", "dog"]);
});

test("calling it twice with the same arguments gives the same answer", () => {
  const queries = words(12, 99);
  const corpus = words(200, 7);
  assert.equal(canonical(search(queries, corpus, 2)), canonical(search(queries, corpus, 2)));
});
