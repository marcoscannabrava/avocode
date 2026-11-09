// Derived numbers. Pure functions on stores.

export const ROLES = ["player", "scorer"];
const MS = { tsOf: (e) => (e && e.ts ? Date.parse(e.ts) : NaN) };

export function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}

/** Sum costs. Any unknown cost gives null. */
export function sumCost(costs) {
  let total = 0;
  for (const c of costs) {
    if (c === null || c === undefined) return null;
    total += c;
  }
  return Math.round(total * 1e6) / 1e6;
}

export function llmByRole(g) {
  const out = {};
  for (const role of ROLES) {
    out[role] = { calls: 0, in: 0, out: 0, cache: 0, costs: [], latency: [], fails: 0, errors: [] };
  }
  for (const e of g.llmEnd.values()) {
    const r = out[e.role];
    if (!r) continue;
    r.calls++;
    r.in += e.in_tokens;
    r.out += e.out_tokens;
    r.cache += e.cache_tokens;
    r.costs.push(e.cost_usd);
    r.latency.push(e.latency_ms);
    if (e.retries > 0 || !e.ok) { r.fails++; r.errors.push(e); }
  }
  for (const role of ROLES) {
    const r = out[role];
    r.cost = sumCost(r.costs);
    r.cacheRate = r.in + r.cache > 0 ? r.cache / (r.in + r.cache) : null;
    r.p50 = percentile(r.latency, 50);
    r.p95 = percentile(r.latency, 95);
    r.jsonFailRate = r.calls ? r.fails / r.calls : null;
  }
  return out;
}

/** Health of one game, for the dot. */
export function health(g, nowMs) {
  if (g.errors.length || g.end?.outcome === "error") return "error";
  if (g.end) return g.end.outcome === "won" ? "won" : "done";
  if (!g.events.length) return "pending";
  const open = g.openCalls();
  const oldest = Math.min(...open.map((c) => MS.tsOf(c)));
  if (open.length && nowMs - oldest > 30_000) return "waiting";
  const age = nowMs - MS.tsOf(g.events[g.events.length - 1]);
  if (!open.length && age > 120_000) return "stalled";
  return "playing";
}

export const HEALTH_ORDER = ["error", "stalled", "waiting", "playing", "pending", "done", "won"];

/** Main numbers for one game. */
export function gameMetrics(g, nowMs = Date.now()) {
  const steps = g.steps;
  const n = steps.length;
  const count = (code) => g.warnings.filter((w) => w.code === code).length;
  const llm = llmByRole(g);
  const levels = g.end?.levels_completed ?? (n ? steps[n - 1].after.levels_completed : 0);
  const winLevels = g.start?.win_levels ?? 0;
  const rounds = g.rounds.size;
  const maxActions = g.start?.budget?.max_actions ?? null;
  const last = g.events.length ? MS.tsOf(g.events[g.events.length - 1]) : NaN;
  const recent = steps.filter((s) => (nowMsOr(last, nowMs) - MS.tsOf(s)) <= 300_000);
  const span = recent.length > 1 ? (MS.tsOf(recent[recent.length - 1]) - MS.tsOf(recent[0])) / 60_000 : 0;
  const stepRate = span >= 0.25 ? (recent.length - 1) / span : null;  // need 15 s of data
  const open = g.openCalls();
  return {
    levels,
    winLevels,
    steps: n,
    rounds,
    maxActions,
    outcome: g.end?.outcome ?? null,
    health: health(g, nowMs),
    noopRate: n ? steps.filter((s) => s.diff.noop).length / n : null,
    repeatStateRate: n ? count("repeat_state") / n : null,
    repeatRounds: count("repeat_round"),
    fallbackRate: llm.player.calls ? count("bad_action") / llm.player.calls : null,
    modelChurn: rounds ? g.models.length / rounds : null,
    modelVersion: g.models.length ? g.models[g.models.length - 1].version : 0,
    llm,
    cost: sumCost(ROLES.map((r) => llm[r].cost)),
    stepRate,
    etaMin: stepRate && maxActions ? Math.max(0, maxActions - n) / stepRate : null,
    lastEventAgeS: Number.isNaN(last) ? null : Math.max(0, (nowMs - last) / 1000),
    openCall: open.length ? open[open.length - 1] : null,
    stepsPerLevel: g.levels.map((l) => l.steps_in_level),
    roundsPerLevel: g.levels.map((l) => l.rounds_in_level),
    warnings: g.warnings.length,
    errors: g.errors.length,
  };
}

function nowMsOr(last, now) {
  return Number.isNaN(last) ? now : last;
}

/** One row per action type. */
export function actionTable(g) {
  const model = g.models.length ? g.models[g.models.length - 1].model : null;
  const rows = new Map();
  for (const s of g.steps) {
    const name = s.action.name;
    if (!rows.has(name)) rows.set(name, { action: name, uses: 0, noops: 0, levelsAfter: 0 });
    const r = rows.get(name);
    r.uses++;
    if (s.diff.noop) r.noops++;
    if (s.after.levels_completed > s.before.levels_completed) r.levelsAfter++;
  }
  return [...rows.values()]
    .map((r) => ({
      ...r,
      noopRate: r.uses ? r.noops / r.uses : 0,
      modelSays: model?.allowable_actions?.[r.action] ?? "unknown",
    }))
    .sort((a, b) => a.action.localeCompare(b.action));
}

/** Cost of each round, from llm_end. */
function roundCosts(g) {
  const out = new Map();
  for (const [id, start] of g.llmStart) {
    const end = g.llmEnd.get(id);
    if (!end) continue;
    if (!out.has(start.round)) out.set(start.round, []);
    out.get(start.round).push(end.cost_usd);
  }
  return out;
}

/** One row per round. */
export function roundTable(g) {
  const costs = roundCosts(g);
  return g.roundList().map((r) => {
    const steps = r.steps;
    const lastStep = steps[steps.length - 1];
    return {
      round: r.round,
      startLevel: r.start.level,
      endLevel: lastStep ? lastStep.after.levels_completed : r.start.level,
      steps: steps.length,
      firstStep: steps.length ? steps[0].step : null,
      lastStep: lastStep ? lastStep.step : null,
      outcome: r.end?.outcome ?? "playing",
      hypothesis: (r.end?.hypothesis || "").split("\n")[0],
      noopRate: steps.length ? steps.filter((s) => s.diff.noop).length / steps.length : null,
      cost: sumCost(costs.get(r.round) ?? []),
    };
  });
}

/** Points (step, levels) for a step line. */
export function levelSeries(g) {
  const pts = [[0, 0]];
  for (const s of g.steps) pts.push([s.step, s.after.levels_completed]);
  return pts;
}

/** Totals for the run header. */
export function runMetrics(run, nowMs = Date.now()) {
  const games = [...run.games.values()].map((g) => ({ g, m: gameMetrics(g, nowMs) }));
  const first = run.start ? Date.parse(run.start.ts) : NaN;
  const lastTs = Math.max(...run.runEvents.map((e) => Date.parse(e.ts)),
    ...games.map(({ g }) => (g.lastTs ? Date.parse(g.lastTs) : -Infinity)));
  const endMs = run.end ? Date.parse(run.end.ts) : nowMs;
  return {
    games: games.length,
    gamesWon: games.filter(({ m }) => m.outcome === "won").length,
    levels: games.reduce((a, { m }) => a + m.levels, 0),
    winLevels: games.reduce((a, { m }) => a + m.winLevels, 0),
    steps: games.reduce((a, { m }) => a + m.steps, 0),
    errors: games.reduce((a, { m }) => a + m.errors, 0),
    warnings: games.reduce((a, { m }) => a + m.warnings, 0),
    cost: sumCost(games.map(({ m }) => m.cost)),
    durationS: Number.isNaN(first) ? null : (endMs - first) / 1000,
    live: !run.end,
    lastEventAgeS: Number.isFinite(lastTs) ? (nowMs - lastTs) / 1000 : null,
  };
}

/** Group failed-round hypotheses with counts. */
export function hypothesisGroups(model) {
  const groups = new Map();
  for (const f of model?.failed_rounds ?? []) {
    const key = (f.hypothesis || "").trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, { hypothesis: f.hypothesis, rounds: [] });
    groups.get(key).rounds.push(f.round);
  }
  return [...groups.values()].sort((a, b) => b.rounds.length - a.rounds.length);
}

/** Model versions per round. */
export function churnByRound(g) {
  const byRound = new Map(g.roundList().map((r) => [r.round, 0]));
  for (const m of g.models) {
    const step = g.byStep.get(m.step);
    const round = step ? step.round : 1;
    byRound.set(round, (byRound.get(round) ?? 0) + 1);
  }
  return [...byRound.entries()].map(([round, count]) => ({ round, count }));
}
