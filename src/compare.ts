import type { AvoConfig } from "./config.ts";

/**
 * A direction-normalized score vector: higher is always better, whatever the metric's own
 * direction. This is what the commit rule compares — never the scalar `primary`, which is only
 * their mean and lets one config's win hide another's regression (PLAN §6 Q1).
 */
export type Vector = Record<string, number>;

/** The shape both an `Attempt` and a committed version's `Avo-Score` trailer satisfy. */
export interface Scored {
  primary: number | null;
  higher_is_better: boolean;
  scores: Record<string, number>;
}

/**
 * The vector form of `f`. A scorer that reports no `scores` object is still a one-config scorer:
 * its whole-repo measurement becomes the `*` config, so single- and multi-config repos compare
 * through exactly the same code path.
 */
export function scoreVector(s: Scored): Vector {
  const sign = s.higher_is_better ? 1 : -1;
  const keys = Object.keys(s.scores);
  if (keys.length > 0) {
    const v: Vector = {};
    for (const k of keys) v[k] = (s.scores[k] as number) * sign;
    return v;
  }
  return s.primary === null ? {} : { "*": s.primary * sign };
}

/**
 * Signed relative change from `best` to `candidate`, both direction-normalized. `Infinity` when
 * the baseline is exactly zero and the candidate moved off it — any change from zero is infinitely
 * relative, and the floor should not silently swallow it.
 */
export function relDelta(candidate: number, best: number): number {
  const d = candidate - best;
  if (d === 0) return 0;
  const scale = Math.abs(best);
  if (scale === 0) return d > 0 ? Infinity : -Infinity;
  return d / scale;
}

export type Decision =
  | "first" // no committed version yet
  | "improved" // commit
  | "regressed" // at least one config got worse
  | "tie" // nothing moved outside the floor
  | "missing-configs" // measured less than the best version did
  | "direction-changed"; // the metric flipped direction — not comparable

export interface ConfigDelta {
  config: string;
  best: number;
  candidate: number;
  /** Relative change, direction-normalized. Positive is always an improvement. */
  rel: number;
  verdict: "improved" | "regressed" | "same";
}

export interface Comparison {
  commit: boolean;
  decision: Decision;
  /** One sentence, safe to show a human and specific enough for an agent to act on. */
  reason: string;
  deltas: ConfigDelta[];
  improved: string[];
  regressed: string[];
  /** Configs the candidate measured that the best version did not. Allowed. */
  added: string[];
  /** Configs the best version measured that the candidate did not. Blocks the commit. */
  missing: string[];
  reduce: AvoConfig["reduce"];
  floor: number;
  /** Only for `reduce: "mean"`. */
  mean?: { best: number; candidate: number; rel: number };
}

const pct = (rel: number): string =>
  rel === Infinity ? "+∞" : rel === -Infinity ? "-∞" : `${rel >= 0 ? "+" : ""}${(rel * 100).toFixed(2)}%`;

const list = (xs: readonly string[]): string => xs.map((x) => `'${x}'`).join(", ");

/**
 * The commit rule (paper §3.2, reduction per PLAN §6 Q1). Correctness is *not* checked here —
 * `avo commit` gates on it first; this only ranks two passing candidates.
 *
 * Two anti-gaming rules ride along: a config the best version measured but the candidate did not
 * blocks the commit (you cannot improve by measuring less), while a *new* config does not; and a
 * metric that changed direction is refused outright rather than compared as if it hadn't.
 */
export function compareVectors(
  candidate: Vector,
  best: Vector | null,
  cfg: AvoConfig,
  meta: { candidateHigherIsBetter?: boolean | undefined; bestHigherIsBetter?: boolean | undefined } = {},
): Comparison {
  const base: Omit<Comparison, "commit" | "decision" | "reason"> = {
    deltas: [],
    improved: [],
    regressed: [],
    added: [],
    missing: [],
    reduce: cfg.reduce,
    floor: cfg.floor,
  };

  if (best === null) {
    return {
      ...base,
      added: Object.keys(candidate).sort(),
      commit: true,
      decision: "first",
      reason: "no committed version yet; this becomes v1",
    };
  }

  if (
    meta.candidateHigherIsBetter !== undefined &&
    meta.bestHigherIsBetter !== undefined &&
    meta.candidateHigherIsBetter !== meta.bestHigherIsBetter
  ) {
    const dir = (h: boolean) => (h ? "higher_is_better" : "lower_is_better");
    return {
      ...base,
      commit: false,
      decision: "direction-changed",
      reason:
        `the metric direction changed (best version is ${dir(meta.bestHigherIsBetter)}, ` +
        `this attempt is ${dir(meta.candidateHigherIsBetter)}); the two are not comparable — ` +
        "start a fresh lineage rather than reinterpreting the old scores",
    };
  }

  const bestKeys = Object.keys(best).sort();
  const missing = bestKeys.filter((k) => !(k in candidate));
  const added = Object.keys(candidate)
    .filter((k) => !(k in best))
    .sort();

  if (missing.length > 0) {
    return {
      ...base,
      added,
      missing,
      commit: false,
      decision: "missing-configs",
      reason:
        `the best version scored ${list(missing)} and this attempt did not; ` +
        "a commit may not measure less than the version it replaces",
    };
  }

  const deltas: ConfigDelta[] = bestKeys.map((config) => {
    const b = best[config] as number;
    const c = candidate[config] as number;
    const rel = relDelta(c, b);
    return {
      config,
      best: b,
      candidate: c,
      rel,
      verdict: rel > cfg.floor ? "improved" : rel < -cfg.floor ? "regressed" : "same",
    };
  });
  const improved = deltas.filter((d) => d.verdict === "improved").map((d) => d.config);
  const regressed = deltas.filter((d) => d.verdict === "regressed").map((d) => d.config);
  const withDeltas = { ...base, deltas, improved, regressed, added, missing };
  const band = cfg.floor > 0 ? ` (floor ±${pct(cfg.floor).slice(1)})` : "";

  if (cfg.reduce === "mean") {
    const weight = (c: string) => cfg.weights[c] ?? 1;
    const total = bestKeys.reduce((a, c) => a + weight(c), 0);
    if (total <= 0) {
      return {
        ...withDeltas,
        commit: false,
        decision: "tie",
        reason: "every configured weight is zero, so the weighted mean is undefined; fix 'weights'",
      };
    }
    const wmean = (v: Vector) => bestKeys.reduce((a, c) => a + (v[c] as number) * weight(c), 0) / total;
    const bMean = wmean(best);
    const cMean = wmean(candidate);
    const rel = relDelta(cMean, bMean);
    const mean = { best: bMean, candidate: cMean, rel };
    if (rel > cfg.floor) {
      return {
        ...withDeltas,
        mean,
        commit: true,
        decision: "improved",
        reason: `the weighted mean improved ${pct(rel)}${band}`,
      };
    }
    return {
      ...withDeltas,
      mean,
      commit: false,
      decision: rel < -cfg.floor ? "regressed" : "tie",
      reason:
        rel < -cfg.floor
          ? `the weighted mean regressed ${pct(rel)}${band}`
          : `the weighted mean did not improve${band}`,
    };
  }

  if (regressed.length > 0) {
    const worst = deltas.filter((d) => d.verdict === "regressed").sort((a, b) => a.rel - b.rel);
    return {
      ...withDeltas,
      commit: false,
      decision: "regressed",
      reason:
        `${list(regressed)} regressed (worst: ${worst[0]?.config} ${pct(worst[0]?.rel ?? 0)})${band}` +
        (improved.length > 0 ? `, and ${list(improved)} improved — a win on one config cannot pay for a loss on another` : ""),
    };
  }
  if (improved.length === 0) {
    return {
      ...withDeltas,
      commit: false,
      decision: "tie",
      reason: `no config improved${band}; the lineage records progress, not equal-scoring rewrites`,
    };
  }
  const bestDelta = deltas.filter((d) => d.verdict === "improved").sort((a, b) => b.rel - a.rel)[0];
  return {
    ...withDeltas,
    commit: true,
    decision: "improved",
    reason: `${list(improved)} improved (best: ${bestDelta?.config} ${pct(bestDelta?.rel ?? 0)}) and nothing regressed${band}`,
  };
}

export { pct as formatRel };
