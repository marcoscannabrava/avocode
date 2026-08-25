// Ladder step 1: two-row rolling DP over Int32Array.
//
// The full matrix is never needed -- row i depends only on row i-1. Two Int32Arrays reused across
// every pair also stop the allocator from doing |queries| x |corpus| worth of work.

let prev = new Int32Array(64);
let cur = new Int32Array(64);

function distance(a, b) {
  const m = a.length;
  const n = b.length;
  if (prev.length < n + 1) {
    prev = new Int32Array(n + 1);
    cur = new Int32Array(n + 1);
  }
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      cur[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[n];
}

export function search(queries, corpus, k) {
  const out = [];
  for (const query of queries) {
    for (const match of corpus) {
      const d = distance(query, match);
      if (d <= k) out.push({ query, match, distance: d });
    }
  }
  return out;
}
