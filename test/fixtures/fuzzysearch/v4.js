// Ladder step 4: v3, plus Ukkonen's band and a row-minimum early exit.
//
// Only cells within k of the diagonal can be on a path of cost <= k, so the DP is 2k+1 wide rather
// than n wide. And once every reachable cell in a row exceeds k, no continuation can come back
// under it -- the pair is rejected without finishing the table. Both of these depend on k being
// small, which is the whole point of a *thresholded* search.
//
// The subtlety that bites: column 0 of row i holds i, which is still <= k for the first k rows, so
// it has to be part of the row minimum. Leaving it out makes the early exit reject pairs that do
// match -- and only for words whose common prefix is short, which is exactly the case a random
// fixture is least likely to contain.

let prev = new Int32Array(64);
let cur = new Int32Array(64);

/** min(distance over a[as..ae) and b[bs..be), k+1). */
function distance(a, as, ae, b, bs, be, k) {
  const m = ae - as;
  const n = be - bs;
  if (m === 0) return n <= k ? n : k + 1;
  if (n === 0) return m <= k ? m : k + 1;
  if (m - n > k || n - m > k) return k + 1;
  if (prev.length < n + 1) {
    prev = new Int32Array(n + 1);
    cur = new Int32Array(n + 1);
  }
  const cap = k + 1;
  const firstBand = n < k ? n : k;
  for (let j = 0; j <= n; j++) prev[j] = j <= firstBand ? j : cap;
  for (let i = 1; i <= m; i++) {
    let lo = i - k;
    if (lo < 1) lo = 1;
    let hi = i + k;
    if (hi > n) hi = n;
    // Only the band and its immediate shoulders are read next row; filling the rest is wasted work.
    for (let j = lo - 1 < 0 ? 0 : lo - 1; j <= hi + 1 && j <= n; j++) cur[j] = cap;
    cur[0] = i <= k ? i : cap;
    let best = cur[0];
    const ca = a.charCodeAt(as + i - 1);
    for (let j = lo; j <= hi; j++) {
      const cost = ca === b.charCodeAt(bs + j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      const v = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > k) return cap;
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
      const d = distance(query, s, lq - e, match, s, lm - e, k);
      if (d <= k) out.push({ query, match, distance: d });
    }
  }
  return out;
}
