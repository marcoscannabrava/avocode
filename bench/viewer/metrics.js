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

/** Input (with cache reads) and output tokens. */
export function tokenTotals(llm) {
  const t = { in: 0, out: 0 };
  for (const role of ROLES) {
    t.in += llm[role].in + llm[role].cache;
    t.out += llm[role].out;
  }
  return { ...t, total: t.in + t.out };
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
    tokens: tokenTotals(llm),
    stepRate,
    etaMin: stepRate && maxActions ? Math.max(0, maxActions - n) / stepRate : null,
    lastEventAgeS: Number.isNaN(last) ? null : Math.max(0, (nowMs - last) / 1000),
    openCall: open.length ? open[open.length - 1] : null,
    stepsPerLevel: g.levels.map((l) => l.steps_in_level),
    openLevelSteps: openLevelSteps(g, levels, winLevels),
    roundsPerLevel: g.levels.map((l) => l.rounds_in_level),
    costPerLevel: costPerLevel(g),
    modelPerStep: n ? g.models.filter((u) => u.step > 0).length / n : null,
    lostSteps: lostSteps(g),
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

/** True when a step gained a level. */
export function isLevelUp(s) {
  return s.after.levels_completed > s.before.levels_completed;
}

/** Steps on the level not yet done. */
function openLevelSteps(g, levels, winLevels) {
  if (winLevels && levels >= winLevels) return null;
  const last = g.levels.length ? g.levels[g.levels.length - 1].step : 0;
  const n = g.steps.filter((s) => s.step > last).length;
  return n || null;
}

/** LLM cost of each level, in order. */
export function costPerLevel(g) {
  const ends = g.levels.map((l) => l.step);
  const buckets = ends.map(() => []);
  buckets.push([]);
  for (const [id, end] of g.llmEnd) {
    const start = g.llmStart.get(id);
    if (!start) continue;
    buckets[ends.filter((e) => e < start.step).length].push(end.cost_usd);
  }
  if (!buckets[buckets.length - 1].length) buckets.pop();
  return buckets.map(sumCost);
}

/** Problems of each step, keyed by step. */
export function stepProblems(g) {
  const codes = new Map();
  for (const w of g.warnings) {
    if (!codes.has(w.step)) codes.set(w.step, []);
    codes.get(w.step).push(w.code);
  }
  const out = new Map();
  for (const s of g.steps) {
    const c = codes.get(s.step) ?? [];
    const p = {
      noop: s.diff.noop,
      repeat: c.includes("repeat_state"),
      fallback: c.includes("bad_action"),
      skipped: s.flags.includes("scorer_skipped"),
      codes: c,
    };
    p.lost = p.noop || p.repeat;
    p.any = p.lost || p.fallback || p.skipped;
    out.set(s.step, p);
  }
  return out;
}

/** Short words for a step's problems. */
export function problemWords(p) {
  if (!p) return [];
  const out = [];
  if (p.noop) out.push("no-op");
  for (const c of p.codes) if (!out.includes(c)) out.push(c);
  if (p.skipped) out.push("scorer_skipped");
  return out;
}

/** No-op or repeat-state steps, no double count. */
export function lostSteps(g) {
  let n = 0;
  for (const p of stepProblems(g).values()) if (p.lost) n++;
  return n;
}

/** Runs of 3+ same lost actions. */
export function loopRuns(g, min = 3) {
  const probs = stepProblems(g);
  const out = [];
  let cur = null;
  const key = (s) => `${s.round}|${s.action.name}|${s.action.x}|${s.action.y}`;
  const close = () => { if (cur && cur.count >= min) out.push(cur); cur = null; };
  for (const s of g.steps) {
    if (!probs.get(s.step).lost) { close(); continue; }
    if (cur && cur.key === key(s) && cur.last === s.step - 1) {
      cur.last = s.step;
      cur.count++;
    } else {
      close();
      cur = { key: key(s), round: s.round, action: s.action.name, first: s.step, last: s.step, count: 1 };
    }
  }
  close();
  return out.map(({ key: _k, ...r }) => r);
}

function lastGrid(line) {
  return line ? { w: line.w, h: line.h, hex: line.frames[line.frames.length - 1] } : null;
}

/** Changed-cell counts on one level. */
export function changeCounts(steps, frameOf, level, action = null) {
  const inLevel = steps.filter((s) => s.before.levels_completed === level);
  const up = steps.find((s) => isLevelUp(s) && s.after.levels_completed === level);
  const baseStep = inLevel.length ? inLevel[0].step - 1 : up ? up.step : 0;
  const base = lastGrid(frameOf(baseStep));
  const counts = new Map();
  let used = 0;
  for (const s of inLevel) {
    if (isLevelUp(s)) continue;
    if (action ? s.action.name !== action : s.action.name === "RESET") continue;
    const a = lastGrid(frameOf(s.step - 1)), b = lastGrid(frameOf(s.step));
    if (!a || !b || a.w !== b.w || a.h !== b.h) continue;
    used++;
    for (let i = 0; i < b.hex.length; i++) if (a.hex[i] !== b.hex[i]) counts.set(i, (counts.get(i) ?? 0) + 1);
  }
  return { base, counts, steps: used };
}

/** Level numbers seen in a game. */
export function levelsSeen(g) {
  let max = 0;
  for (const s of g.steps) max = Math.max(max, s.after.levels_completed);
  return [...Array(max + 1).keys()];
}

/** "model/effort" for one role. */
export function modelLabel(config, role) {
  const m = config?.[`${role}_model`];
  if (!m) return "?";
  const e = config[`${role}_effort`];
  return e ? `${m}/${e}` : m;
}

/** One compare row per run and game. */
export function compareRow(runId, manifest, g, nowMs = Date.now()) {
  const m = gameMetrics(g, nowMs);
  const cfg = manifest?.config ?? {};
  return {
    run: runId,
    game: g.id,
    tags: manifest?.tags ?? [],
    player: manifest?.prompts?.player ?? "?",
    scorer: manifest?.prompts?.scorer ?? "?",
    models: `${modelLabel(cfg, "player")} · ${modelLabel(cfg, "scorer")}`,
    levels: m.levels,
    winLevels: m.winLevels,
    steps: m.steps,
    stepsPerLevel: m.stepsPerLevel,
    openLevelSteps: m.openLevelSteps,
    noopRate: m.noopRate,
    repeatStateRate: m.repeatStateRate,
    lostSteps: m.lostSteps,
    cost: m.cost,
    costPerLevel: m.levels && m.cost !== null ? m.cost / m.levels : null,
  };
}

/** Rows for many runs, in run order. */
export function compareRows(runs, nowMs = Date.now()) {
  const rows = [];
  const sorted = [...runs].sort((a, b) => a.runId.localeCompare(b.runId));
  for (const { runId, manifest, run } of sorted) {
    for (const g of run.games.values()) rows.push(compareRow(runId, manifest, g, nowMs));
  }
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    r.newPlayer = !!prev && prev.player !== r.player;
    r.newScorer = !!prev && prev.scorer !== r.scorer;
  });
  return rows;
}
