// Game view: progress, rounds, actions, maps.
import {
  actionTable, changeCounts, gameMetrics, isLevelUp, levelSeries, levelsSeen, loopRuns, problemWords,
  roundTable, stepProblems,
} from "../metrics.js";
import { scatter, stepLine } from "../charts.js";
import { drawGrid } from "../grid.js";
import { age, esc, money, pct, secs, stepTip, tile, tokens } from "../html.js";

const ui = { mapLevel: null, mapAction: "", game: null };

export function liveRefresh() { return false; }

function gameLink(g, rest = "") { return `#/game/${encodeURIComponent(g.id)}${rest}`; }

function stepLink(g, s) { return gameLink(g, `/round/${s.round}/step/${s.step}`); }

function timeline(g, m, probs) {
  const rounds = roundTable(g);
  const lastStep = g.steps.length ? g.steps[g.steps.length - 1].step : 1;
  const bands = rounds.map((r) => ({
    x0: Math.max(0, (r.firstStep ?? 1) - 1), x1: r.lastStep ?? lastStep, cls: r.outcome,
    title: `round ${r.round}: ${r.outcome}`, href: gameLink(g, `/round/${r.round}`),
  }));
  const models = g.models.filter((u) => u.step > 0).map((u) => ({
    x: u.step, cls: "scorer", title: `v${u.version}: ${u.summary || u.changes.join(", ")}`,
    href: gameLink(g, `/model/${u.version}`),
  }));
  const events = [];
  for (const s of g.steps) {
    const p = probs.get(s.step);
    if (isLevelUp(s)) {
      events.push({ x: s.step, cls: "won", title: `step ${s.step}: level complete`, href: stepLink(g, s) });
    } else if (p.codes.length) {
      events.push({ x: s.step, cls: "failed", title: `step ${s.step}: ${p.codes.join(", ")}`, href: stepLink(g, s) });
    }
  }
  return stepLine({
    series: [{ name: "levels", color: "var(--won)", pts: levelSeries(g), xEnd: lastStep }],
    bands, xMax: lastStep, yMax: Math.max(1, m.winLevels), width: 1200, height: 220,
    lanes: [{ label: "Model", items: models }, { label: "events", items: events }],
  });
}

function outcomeDot(o) {
  return { won: "won", failed: "stalled", playing: "playing" }[o] ?? "done";
}

function roundsTable(g) {
  const rows = roundTable(g);
  const hyp = rows.some((r) => r.hypothesis);
  const body = rows.map((r) => `<tr class="click" data-href="${gameLink(g, `/round/${r.round}`)}">
    <td class="num">${r.round}</td><td class="num">${r.startLevel}</td><td class="num">${r.endLevel}</td>
    <td class="num">${r.steps}</td><td><span class="dot h-${outcomeDot(r.outcome)}"></span>${esc(r.outcome)}</td>
    ${hyp ? `<td>${esc(r.hypothesis)}</td>` : ""}<td class="num">${pct(r.noopRate)}</td><td class="num">${money(r.cost)}</td></tr>`).join("");
  return `<table><thead><tr><th class="num">round</th><th class="num">start lvl</th><th class="num">end lvl</th>
    <th class="num">steps</th><th>outcome</th>${hyp ? "<th>Scorer hypothesis</th>" : ""}<th class="num">no-op</th>
    <th class="num">cost</th></tr></thead><tbody>${body}</tbody></table>`;
}

function actionRows(g) {
  return actionTable(g).map((r) => `<tr><td class="mono">${esc(r.action)}</td><td class="num">${r.uses}</td>
    <td class="num">${pct(r.noopRate)}</td><td class="num">${r.levelsAfter}</td><td>${esc(r.modelSays)}</td></tr>`).join("");
}

/** Strip cells for one round. */
export function stripCells(g, r, probs, href, cur = -1) {
  return r.steps.map((s, i) => {
    const p = probs.get(s.step);
    const cls = [`act-${s.action.name}`, p?.noop ? "hollow" : "", p?.repeat ? "rep" : "",
      isLevelUp(s) ? "lvl" : "", i === cur ? "cur" : ""].join(" ");
    return `<a class="${cls}" href="${href(s)}" title="${esc(stepTip(s, problemWords(p)))}"></a>`;
  }).join("");
}

function actionStrip(g, probs) {
  return g.roundList().map((r) => {
    const cells = stripCells(g, r, probs, (s) => stepLink(g, s));
    const end = `<span class="end-${r.end?.outcome ?? "playing"}" title="${esc(r.end?.outcome ?? "playing")}"></span>`;
    return `<div class="strip-row"><span class="lbl">round ${r.round}</span><div class="strip" style="margin:0">${cells}${end}</div></div>`;
  }).join("");
}

export function legendActions(names) {
  return names.map((n) => `<span><i class="act-${n}"></i>${n === "RESET" ? n : "A" + n.slice(-1)}</span>`).join("")
    + '<span><i style="box-shadow:inset 0 0 0 2px var(--c0)"></i>no-op</span>'
    + '<span><i style="box-shadow:inset 0 0 0 2px var(--failed)"></i>repeat state</span>'
    + '<span><i style="box-shadow:inset 0 -3px 0 var(--won)"></i>level complete</span>';
}

function loopsList(g) {
  const loops = loopRuns(g);
  if (!loops.length) return '<p class="muted">No loops of 3 or more lost steps.</p>';
  return `<ul class="loops">${loops.map((l) => `<li><a href="${gameLink(g, `/round/${l.round}/step/${l.first}`)}">steps ${l.first}–${l.last}</a>,
    <span class="mono">${esc(l.action)}</span> ×${l.count} <span class="muted">(round ${l.round})</span></li>`).join("")}</ul>`;
}

function latency(g) {
  const pts = [];
  for (const [id, end] of g.llmEnd) {
    const start = g.llmStart.get(id);
    if (!start) continue;
    pts.push({ x: start.step, y: end.latency_ms / 1000, cls: end.role,
      title: `${id}: ${secs(end.latency_ms)}, ${end.in_tokens} in`, href: gameLink(g, `/llm/${id}`) });
  }
  return scatter(pts, { yLabel: "seconds", height: 200 });
}

function badCalls(g) {
  const rows = [...g.llmEnd.values()].filter((e) => e.retries > 0 || !e.ok);
  if (!rows.length) return '<p class="muted">No calls with errors or retries.</p>';
  return `<table><tr><th>call</th><th>role</th><th class="num">retries</th><th>ok</th><th>error</th></tr>${rows.map((e) => `
    <tr class="click" data-href="${gameLink(g, `/llm/${e.call_id}`)}"><td class="mono">${esc(e.call_id)}</td><td>${e.role}</td>
    <td class="num">${e.retries}</td><td>${e.ok ? "yes" : "no"}</td><td>${esc((e.error || "").slice(0, 120))}</td></tr>`).join("")}</table>`;
}

function usesClicks(g) {
  const avail = g.start?.available_actions ?? [];
  return avail.includes("ACTION6") || g.steps.some((s) => s.action.name === "ACTION6");
}

function mapControls(g) {
  const levels = levelsSeen(g);
  const names = [...new Set(g.steps.map((s) => s.action.name))].sort();
  const lvl = levels.map((l) => `<option value="${l}" ${l === ui.mapLevel ? "selected" : ""}>level ${l + 1}</option>`).join("");
  const act = ['<option value="">all actions</option>', ...names.map((n) =>
    `<option ${n === ui.mapAction ? "selected" : ""}>${esc(n)}</option>`)].join("");
  return `<div class="controls" style="margin:0 0 8px"><select id="maplevel">${lvl}</select><select id="mapaction">${act}</select></div>`;
}

async function drawMaps(ctx, g, el) {
  const note = el.querySelector("#changenote");
  if (!g.steps.length) { note.textContent = "No steps yet."; return; }
  const frames = await ctx.need(g.id, "frames.jsonl");
  const map = changeCounts(g.steps, (s) => frames.get(s), ui.mapLevel, ui.mapAction || null);
  if (map.base) drawGrid(el.querySelector("#changemap"), map.base, { size: 360, fade: true, heat: map.counts });
  note.textContent = `${map.steps} steps on level ${ui.mapLevel + 1}. Level changes and resets are skipped.`;
  const clickmap = el.querySelector("#clickmap");
  if (!clickmap) return;
  const clicks = new Map();
  for (const s of g.steps) {
    if (s.action.name !== "ACTION6" || s.action.x === null || s.before.levels_completed !== ui.mapLevel) continue;
    const i = s.action.y * map.base.w + s.action.x;
    clicks.set(i, (clicks.get(i) ?? 0) + 1);
  }
  if (map.base) drawGrid(clickmap, map.base, { size: 360, fade: true, heat: clicks });
  el.querySelector("#clicknote").textContent = clicks.size
    ? `${[...clicks.values()].reduce((a, b) => a + b, 0)} clicks on level ${ui.mapLevel + 1}` : "no clicks";
}

function levelList(done, open) {
  const parts = done.map((v) => String(v));
  if (open !== null && open !== undefined) parts.push(`${open}+`);
  return parts.join(", ") || "—";
}

export async function render(ctx, route, el, g) {
  const m = gameMetrics(g, ctx.now());
  const probs = stepProblems(g);
  if (ui.game !== g.id) { ui.game = g.id; ui.mapLevel = null; ui.mapAction = ""; }
  const levels = levelsSeen(g);
  if (ui.mapLevel === null || !levels.includes(ui.mapLevel)) ui.mapLevel = levels[0];
  const many = m.rounds > 1;
  const live = !m.outcome;
  const openCost = m.costPerLevel.length > m.stepsPerLevel.length
    ? money(m.costPerLevel[m.costPerLevel.length - 1]) : null;
  const tiles = [
    tile("levels", `${m.levels}/${m.winLevels}`,
      "Levels completed / levels in the game. This is the score."),
    tile("outcome", esc(m.outcome ?? m.health),
      "How the game ended (won, budget, error), or its health while it plays."),
    tile("steps", `${m.steps}/${m.maxActions ?? "?"}`,
      "Actions sent to the game / action budget (max_actions)."),
    tile("rounds", m.rounds,
      "Tries at the game. A new round starts after a game over or a reset."),
    tile("steps per level", levelList(m.stepsPerLevel, m.openLevelSteps),
      "Steps to complete each level. 'N+' is the level still open. Lower is better."),
    tile("rounds per level", m.roundsPerLevel.join(", ") || "—",
      "Rounds used to complete each level. 1 means no game over on that level."),
    tile("cost per level", levelList(m.costPerLevel.slice(0, m.stepsPerLevel.length).map(money), openCost),
      "LLM cost spent on each level. '+' is the level still open."),
    tile("lost steps", `${m.lostSteps} <span class="muted" style="font-size:12px">${pct(m.steps ? m.lostSteps / m.steps : null)}</span>`,
      "Steps that changed nothing (no-op) or went back to a state seen before in the round. Each step counts once."),
    tile("no-op rate", pct(m.noopRate),
      "Share of steps where the grid did not change."),
    tile("repeat-state rate", pct(m.repeatStateRate),
      "Share of steps that gave a grid already seen in this round."),
    many ? tile("repeat rounds", m.repeatRounds,
      "Rounds that started with the same actions as an earlier round.") : "",
    tile("fallback rate", pct(m.fallbackRate),
      "Share of Player calls that gave a bad action. The agent used a fallback action."),
    tile("Model updates / step", m.modelPerStep === null ? "—" : m.modelPerStep.toFixed(2),
      "Scorer Model updates per step. Near 1 means the Model changes after almost every step."),
    many ? tile("Model churn / round", m.modelChurn === null ? "—" : m.modelChurn.toFixed(1),
      "Model versions per round. High churn with no level gain means noise.") : "",
    tile("cost", money(m.cost),
      "Total LLM cost of this game, Player and Scorer."),
    tile("tokens in / out", `${tokens(m.tokens.in)} / ${tokens(m.tokens.out)}`,
      "LLM tokens sent (cache reads included) / tokens received, both roles."),
    tile("player p50 / p95", `${secs(m.llm.player.p50)} / ${secs(m.llm.player.p95)}`,
      "Player call time: median / 95th percentile."),
    tile("scorer p50 / p95", `${secs(m.llm.scorer.p50)} / ${secs(m.llm.scorer.p95)}`,
      "Scorer call time: median / 95th percentile."),
    tile("JSON fail P / S", `${pct(m.llm.player.jsonFailRate)} / ${pct(m.llm.scorer.jsonFailRate)}`,
      "Share of calls whose reply was not valid JSON on the first try (retry or fail). Player / Scorer."),
    tile("cache rate P / S", `${pct(m.llm.player.cacheRate)} / ${pct(m.llm.scorer.cacheRate)}`,
      "Share of input tokens read from the prompt cache. Player / Scorer. Higher costs less."),
    live ? tile("step rate", m.stepRate ? `${m.stepRate.toFixed(1)}/min` : "—",
      "Steps per minute over the last 5 minutes.") : "",
    live ? tile("time to finish", m.etaMin ? `${Math.round(m.etaMin)} min` : "—",
      "Steps left in the budget / step rate.") : "",
    live ? tile("last event", age(m.lastEventAgeS),
      "Time since the last event from this game.") : "",
  ];
  const errors = g.errors.map((e) => `<div class="banner"><b>error in ${esc(e.where)}</b> at step ${e.step}: ${esc(e.message)}<pre>${esc(e.traceback)}</pre></div>`).join("");
  const names = [...new Set(["RESET", ...(g.start?.available_actions ?? []), ...g.steps.map((s) => s.action.name)])].sort();
  const clicks = usesClicks(g);
  const changePanel = `<div><h2>Change map</h2><div class="panel">${mapControls(g)}<canvas class="grid" id="changemap"></canvas>
    <div class="muted" id="changenote"></div></div></div>`;
  const clickPanel = clicks ? `<div><h2>Click map</h2><div class="panel"><canvas class="grid" id="clickmap"></canvas>
    <div class="muted" id="clicknote"></div></div></div>` : "";
  el.innerHTML = `${errors}
    <div class="flex"><h1 class="mono">${esc(g.id)}</h1>
      <a href="${gameLink(g, "/model")}">Model history (v${m.modelVersion})</a>
      ${g.rounds.size ? `<a href="${gameLink(g, `/round/${Math.max(...g.rounds.keys())}`)}">latest round</a>` : ""}</div>
    <div class="tiles" style="margin-top:10px">${tiles.join("")}</div>
    <h2>Progress</h2><div class="panel">${timeline(g, m, probs)}
      <div class="legend"><span><i style="background:var(--won)"></i>levels</span>
      <span><i style="background:var(--scorer)"></i>Model update</span>
      <span><i style="background:var(--failed)"></i>warning</span>
      <span><i style="background:var(--won)"></i>level complete</span>
      <span>bands: round outcome (click to open)</span></div></div>
    <h2>Rounds</h2>${roundsTable(g)}
    <h2>Actions</h2><table><thead><tr><th>action</th><th class="num">uses</th><th class="num">no-op %</th>
      <th class="num">levels gained after</th><th>Model says</th></tr></thead><tbody>${actionRows(g)}</tbody></table>
    <h2>Action strip</h2><div class="panel">${actionStrip(g, probs)}<div class="legend" style="margin-top:8px">${legendActions(names)}</div></div>
    <h2>Loops</h2><div class="panel">${loopsList(g)}</div>
    <div class="${clicks ? "grid2" : ""}">${changePanel}${clickPanel}</div>
    <div class="grid2"><div><h2>LLM latency</h2><div class="panel">${latency(g)}
      <div class="legend"><span><i style="background:var(--player)"></i>player</span><span><i style="background:var(--scorer)"></i>scorer</span></div></div></div>
      <div><h2>Calls with errors or retries</h2>${badCalls(g)}</div></div>`;
  for (const tr of el.querySelectorAll("tr[data-href]")) tr.onclick = () => ctx.go(tr.dataset.href);
  el.querySelector("#maplevel").onchange = (e) => { ui.mapLevel = Number(e.target.value); ctx.rerender(); };
  el.querySelector("#mapaction").onchange = (e) => { ui.mapAction = e.target.value; ctx.rerender(); };
  drawMaps(ctx, g, el).catch((err) => {
    el.querySelector("#changenote").textContent = `Could not load frames: ${err.message}`;
  });
}
