// Ladder step 6: v5, plus a letter-set bitmask prefilter.
//
// If a letter occurs in one word and not the other, some edit has to account for it. A single
// substitution can account for at most two such letters (one removed, one added), an insert or a
// delete for at most one -- so with `x` letters in the symmetric difference of the two letter sets,
// the distance is at least ceil(x / 2). Reject when x > 2k, using one xor and one popcount.
//
// Letters outside a-z all share bit 26. That UNDERcounts x, which makes the filter weaker and keeps
// it sound: a filter that can only ever reject less is safe, one that rejects more is a wrong answer.

let prev = new Int32Array(64);
let cur = new Int32Array(64);

function mask(word) {
  let m = 0;
  for (let i = 0; i < word.length; i++) {
    const c = word.charCodeAt(i);
    m |= c >= 97 && c <= 122 ? 1 << (c - 97) : 1 << 26;
  }
  return m;
}

function popcount(v) {
  v -= (v >> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
  v = (v + (v >> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >> 24;
}

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
  // One pass over the corpus builds both indexes; v5 paid |queries| x |corpus| just to read lengths.
  const byLength = new Map();
  for (const word of corpus) {
    const entry = { word, mask: mask(word) };
    const bucket = byLength.get(word.length);
    if (bucket === undefined) byLength.set(word.length, [entry]);
    else bucket.push(entry);
  }

  const budget = 2 * k;
  const out = [];
  for (const query of queries) {
    const lq = query.length;
    const qmask = mask(query);
    for (let len = lq - k; len <= lq + k; len++) {
      const bucket = byLength.get(len);
      if (bucket === undefined) continue;
      for (let b = 0; b < bucket.length; b++) {
        if (popcount(qmask ^ bucket[b].mask) > budget) continue;
        const match = bucket[b].word;
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
