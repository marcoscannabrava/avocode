// The candidate. This is the ONLY file the optimizer may change.
//
//   search(queries, corpus, k) -> every (query, word) pair whose Levenshtein distance is <= k
//
// The implementation below is correct and deliberately unoptimized: a full DP matrix built out of
// nested arrays, for every one of the |queries| x |corpus| pairs. Making it faster without making
// it wrong is the whole task. See ../README.md for what is in bounds.

/** Levenshtein distance between `a` and `b`, via the full (m+1)x(n+1) DP matrix. */
function distance(a, b) {
  const m = a.length;
  const n = b.length;
  const d = [];
  for (let i = 0; i <= m; i++) {
    d.push(Array.from({ length: n + 1 }, () => 0));
    d[i][0] = i;
  }
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[m][n];
}

/**
 * Every (query, word) pair within edit distance `k`, in any order.
 *
 * @param {readonly string[]} queries
 * @param {readonly string[]} corpus
 * @param {number} k maximum edit distance, inclusive
 * @returns {{query: string, match: string, distance: number}[]}
 */
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
