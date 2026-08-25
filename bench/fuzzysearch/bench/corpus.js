// PROTECTED -- part of `f`. Editing this file makes every score `correct: false`.
//
// The workload. A deterministic pseudo-lexicon: stems built from consonant/vowel syllables, then
// affixed. Shared prefixes and suffixes are common, exactly as in a real word list, which is what
// makes prefix/suffix trimming and length bucketing worth anything. No data file, no network, the
// same corpus on every machine.

const CONSONANTS = "bcdfghjklmnpqrstvwxyz";
const VOWELS = "aeiou";
// Weighted toward "" so most words are a bare stem plus a suffix.
const PREFIXES = ["", "", "", "", "un", "re", "in", "de", "pre", "over", "mis"];
const SUFFIXES = ["", "s", "ed", "ing", "er", "ly", "ness", "tion", "able", "est"];

/** Numerical Recipes LCG. Seeded, 32-bit, identical everywhere -- the corpus must not drift. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function stems(count, rand) {
  const out = [];
  for (let i = 0; i < count; i++) {
    let word = "";
    const syllables = 1 + Math.floor(rand() * 3);
    for (let j = 0; j < syllables; j++) {
      word += CONSONANTS[Math.floor(rand() * CONSONANTS.length)];
      word += VOWELS[Math.floor(rand() * VOWELS.length)];
      if (rand() < 0.4) word += CONSONANTS[Math.floor(rand() * CONSONANTS.length)];
    }
    out.push(word);
  }
  return out;
}

/** `count` distinct words, deterministic in `seed`. */
export function words(count, seed) {
  const rand = lcg(seed);
  const lexicon = stems(Math.max(8, Math.floor(count / 6)), rand);
  const seen = new Set();
  const out = [];
  while (out.length < count) {
    const word =
      PREFIXES[Math.floor(rand() * PREFIXES.length)] +
      lexicon[Math.floor(rand() * lexicon.length)] +
      SUFFIXES[Math.floor(rand() * SUFFIXES.length)];
    if (word.length < 3 || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

/**
 * The scored configs. Two of them on purpose: `avo commit` compares the score VECTOR, so a change
 * that only helps one size has to prove it does not hurt the other.
 */
export const CONFIGS = {
  small: { corpus: 2500, queries: 80, k: 2, corpusSeed: 7, querySeed: 99, minReps: 3, maxReps: 500, budgetMs: 300 },
  large: { corpus: 5000, queries: 120, k: 2, corpusSeed: 11, querySeed: 4242, minReps: 3, maxReps: 500, budgetMs: 300 },
};

export function workload(name) {
  const config = CONFIGS[name];
  if (config === undefined) {
    throw new Error(`unknown config '${name}' (have: ${Object.keys(CONFIGS).join(", ")})`);
  }
  return {
    ...config,
    corpusWords: words(config.corpus, config.corpusSeed),
    queryWords: words(config.queries, config.querySeed),
  };
}
