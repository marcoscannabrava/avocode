// Ladder step 5: v4, plus a length index over the corpus.
//
// v2's prefilter still touches every corpus word once per query to read its length. Bucketing the
// corpus by length once per call turns that into 2k+1 bucket lookups per query: O(|corpus|) of
// indexing instead of O(|queries| x |corpus|) of rejection.

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
  const byLength = new Map();
  for (const word of corpus) {
    const bucket = byLength.get(word.length);
    if (bucket === undefined) byLength.set(word.length, [word]);
    else bucket.push(word);
  }

  const out = [];
  for (const query of queries) {
    const lq = query.length;
    for (let len = lq - k; len <= lq + k; len++) {
      const bucket = byLength.get(len);
      if (bucket === undefined) continue;
      for (const match of bucket) {
        const shorter = lq < len ? lq : len;
        let s = 0;
        while (s < shorter && query.charCodeAt(s) === match.charCodeAt(s)) s++;
        let e = 0;
        while (e < shorter - s && query.charCodeAt(lq - 1 - e) === match.charCodeAt(len - 1 - e)) e++;
        const d = distance(query, s, lq - e, match, s, len - e, k);
        if (d <= k) out.push({ query, match, distance: d });
      }
    }
  }
  return out;
}
