// Ladder step 3: v2, plus common prefix/suffix trimming.
//
// A shared prefix or suffix contributes nothing to the distance, so it can be sliced off before the
// DP runs. On this corpus -- stems with shared affixes -- that shrinks a lot of tables, though the
// slicing itself costs something, which is why the win here is small enough to be a real test of
// `floor`.

let prev = new Int32Array(64);
let cur = new Int32Array(64);

/** Distance over a[as..ae) and b[bs..be), addressed by index so nothing is allocated. */
function distance(a, as, ae, b, bs, be) {
  const m = ae - as;
  const n = be - bs;
  if (m === 0) return n;
  if (n === 0) return m;
  if (prev.length < n + 1) {
    prev = new Int32Array(n + 1);
    cur = new Int32Array(n + 1);
  }
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(as + i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(bs + j - 1) ? 0 : 1;
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
    const lq = query.length;
    for (const match of corpus) {
      const lm = match.length;
      const diff = lm - lq;
      if (diff > k || -diff > k) continue;
      const shorter = lq < lm ? lq : lm;
      let s = 0;
      while (s < shorter && query.charCodeAt(s) === match.charCodeAt(s)) s++;
      let e = 0;
      while (e < shorter - s && query.charCodeAt(lq - 1 - e) === match.charCodeAt(lm - 1 - e)) e++;
      const d = distance(query, s, lq - e, match, s, lm - e);
      if (d <= k) out.push({ query, match, distance: d });
    }
  }
  return out;
}
