// PROTECTED -- part of `f`. Editing this file makes every score `correct: false`.
//
// An independent, deliberately slow reference. It exists so correctness can be checked without
// trusting anything in src/: the gate never runs the code it is judging. Do not "optimize" it --
// its only job is to be obviously right.

/** Levenshtein distance, textbook full-matrix form. */
export function referenceDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const rows = [];
  for (let i = 0; i <= m; i++) rows.push(Array.from({ length: n + 1 }, () => 0));
  for (let i = 0; i <= m; i++) rows[i][0] = i;
  for (let j = 0; j <= n; j++) rows[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const substitution = rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, substitution);
    }
  }
  return rows[m][n];
}

/** The same contract as `search`, computed the slow obvious way. */
export function referenceSearch(queries, corpus, k) {
  const out = [];
  for (const query of queries) {
    for (const match of corpus) {
      const d = referenceDistance(query, match);
      if (d <= k) out.push({ query, match, distance: d });
    }
  }
  return out;
}

/**
 * A canonical, order-insensitive rendering of a result set, so two implementations can be compared
 * with one string equality. Sorting is what makes result ORDER a free choice for the candidate:
 * bucketing the corpus or scanning it backwards must stay legal.
 */
export function canonical(results) {
  if (!Array.isArray(results)) return `not an array: ${typeof results}`;
  return results
    .map((r) => {
      if (r === null || typeof r !== "object") return `!bad-entry(${typeof r})`;
      return `${r.query} ${r.match} ${r.distance}`;
    })
    .sort()
    .join("\n");
}
