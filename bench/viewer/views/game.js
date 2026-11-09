// Game view: progress, rounds, actions, maps.
import { actionTable, gameMetrics, levelSeries, roundTable } from "../metrics.js";
import { scatter, stepLine } from "../charts.js";
import { drawGrid } from "../grid.js";
import { age, esc, money, pct, secs, shortAction, tile } from "../html.js";

export function liveRefresh() { return false; }

function gameLink(g, rest = "") { return `#/game/${encodeURIComponent(g.id)}${rest}`; }

function timeline(g, m) {
  const rounds = roundTable(g);
  const lastStep = g.steps.length ? g.steps[g.steps.length - 1].step : 1;
  const bands = rounds.map((r) => ({
    x0: Math.max(0, (r.firstStep ?? 1) - 1), x1: r.lastStep ?? lastStep, cls: r.outcome,
    title: `round ${r.round}: ${r.outcome}`, href: gameLink(g, `/round/${r.round}`),
  }));
  const pts = levelSeries(g);
  const marks = g.models.map((u) => {
    const lv = g.byStep.get(u.step)?.after.levels_completed ?? 0;
    return { x: u.step, y: lv, title: `v${u.version}: ${u.summary || u.changes.join(", ")}` };
  });
  return stepLine({
    series: [{ name: "levels", color: "var(--won)", pts, xEnd: lastStep }],
    bands, marks, xMax: lastStep, yMax: Math.max(1, m.winLevels), width: 1200, height: 240,
  });
}

function roundRows(g) {
  return roundTable(g).map((r) => `<tr class="click" data-href="${gameLink(g, `/round/${r.round}`)}">
    <td class="num">${r.round}</td><td class="num">${r.startLevel}</td><td class="num">${r.endLevel}</td>
    <td class="num">${r.steps}</td><td><span class="dot h-${r.outcome === "won" ? "won" : r.outcome === "failed" ? "stalled" : r.outcome === "playing" ? "playing" : "done"}"></span>${esc(r.outcome)}</td>
    <td>${esc(r.hypothesis)}</td><td class="num">${pct(r.noopRate)}</td><td class="num">${money(r.cost)}</td></tr>`).join("");
}

function actionRows(g) {
  return actionTable(g).map((r) => `<tr><td class="mono">${esc(r.action)}</td><td class="num">${r.uses}</td>
    <td class="num">${pct(r.noopRate)}</td><td class="num">${r.levelsAfter}</td><td>${esc(r.modelSays)}</td></tr>`).join("");
}

function actionStrip(g) {
  const repeat = new Set(g.warnings.filter((w) => w.code === "repeat_state").map((w) => w.step));
  return g.roundList().map((r) => {
    const cells = r.steps.map((s) => {
      const cls = [`act-${s.action.name}`, s.diff.noop ? "hollow" : "", repeat.has(s.step) ? "rep" : ""].join(" ");
      return `<a class="${cls}" href="${gameLink(g, `/round/${r.round}/step/${s.step}`)}" title="${s.step}: ${esc(shortAction(s.action))}"></a>`;
    }).join("");
    const end = `<span class="end-${r.end?.outcome ?? "playing"}" title="${esc(r.end?.outcome ?? "playing")}"></span>`;
    return `<div class="strip-row"><span class="lbl">round ${r.round}</span><div class="strip" style="margin:0">${cells}${end}</div></div>`;
  }).join("");
}

function legendActions() {
  const names = ["RESET", "ACTION1", "ACTION2", "ACTION3", "ACTION4", "ACTION5", "ACTION6", "ACTION7"];
  return names.map((n) => `<span><i class="act-${n}"></i>${n === "RESET" ? n : "A" + n.slice(-1)}</span>`).join("")
    + '<span><i class="hollow" style="box-shadow:inset 0 0 0 2px var(--c0)"></i>no-op</span>'
    + '<span><i style="box-shadow:inset 0 0 0 2px var(--failed)"></i>repeat state</span>';
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

async function drawMaps(ctx, g, el) {
  if (!g.steps.length) { el.querySelector("#clicknote").textContent = "No steps yet."; return; }
  const frames = await ctx.need(g.id, "frames.jsonl");
  const last = g.steps[g.steps.length - 1].step;
  const lastLine = frames.get(last) ?? frames.get(0);
  if (!lastLine) return;
  const frame = { w: lastLine.w, h: lastLine.h, hex: lastLine.frames[lastLine.frames.length - 1] };
  const clicks = new Map();
  const changes = new Map();
  for (const s of g.steps) {
    if (s.action.name === "ACTION6" && s.action.x !== null) {
      const i = s.action.y * frame.w + s.action.x;
      clicks.set(i, (clicks.get(i) ?? 0) + 1);
    }
    const a = frames.get(s.step - 1), b = frames.get(s.step);
    if (!a || !b || a.w !== b.w || a.h !== b.h) continue;
    const ha = a.frames[a.frames.length - 1], hb = b.frames[b.frames.length - 1];
    for (let i = 0; i < hb.length; i++) if (ha[i] !== hb[i]) changes.set(i, (changes.get(i) ?? 0) + 1);
  }
  drawGrid(el.querySelector("#clickmap"), frame, { size: 320, fade: true, heat: clicks });
  drawGrid(el.querySelector("#changemap"), frame, { size: 320, fade: true, heat: changes });
  el.querySelector("#clicknote").textContent = clicks.size ? `${[...clicks.values()].reduce((a, b) => a + b, 0)} clicks` : "no clicks";
}

export async function render(ctx, route, el, g) {
  const m = gameMetrics(g, ctx.now());
  const tiles = [
    tile("levels", `${m.levels}/${m.winLevels}`), tile("outcome", esc(m.outcome ?? m.health)),
    tile("steps", `${m.steps}/${m.maxActions ?? "?"}`), tile("rounds", m.rounds),
    tile("steps per level", m.stepsPerLevel.join(", ") || "—"),
    tile("rounds per level", m.roundsPerLevel.join(", ") || "—"),
    tile("no-op rate", pct(m.noopRate)), tile("repeat-state rate", pct(m.repeatStateRate)),
    tile("repeat rounds", m.repeatRounds), tile("fallback rate", pct(m.fallbackRate)),
    tile("Model churn", m.modelChurn === null ? "—" : m.modelChurn.toFixed(1)),
    tile("cost", money(m.cost)),
    tile("player p50 / p95", `${secs(m.llm.player.p50)} / ${secs(m.llm.player.p95)}`),
    tile("scorer p50 / p95", `${secs(m.llm.scorer.p50)} / ${secs(m.llm.scorer.p95)}`),
    tile("JSON fail P / S", `${pct(m.llm.player.jsonFailRate)} / ${pct(m.llm.scorer.jsonFailRate)}`),
    tile("cache rate P / S", `${pct(m.llm.player.cacheRate)} / ${pct(m.llm.scorer.cacheRate)}`),
    tile("step rate", m.stepRate ? `${m.stepRate.toFixed(1)}/min` : "—"),
    tile("time to finish", m.outcome ? "—" : m.etaMin ? `${Math.round(m.etaMin)} min` : "—"),
    tile("last event", age(m.lastEventAgeS)),
  ];
  const errors = g.errors.map((e) => `<div class="banner"><b>error in ${esc(e.where)}</b> at step ${e.step}: ${esc(e.message)}<pre>${esc(e.traceback)}</pre></div>`).join("");
  el.innerHTML = `${errors}
    <div class="flex"><h1 class="mono">${esc(g.id)}</h1>
      <a href="${gameLink(g, "/model")}">Model history (v${m.modelVersion})</a>
      ${g.rounds.size ? `<a href="${gameLink(g, `/round/${Math.max(...g.rounds.keys())}`)}">latest round</a>` : ""}</div>
    <div class="tiles" style="margin-top:10px">${tiles.join("")}</div>
    <h2>Progress</h2><div class="panel">${timeline(g, m)}
      <div class="legend"><span><i style="background:var(--won)"></i>levels</span>
      <span><i style="background:var(--scorer);border-radius:50%"></i>Model update</span>
      <span>bands: round outcome (click to open)</span></div></div>
    <h2>Rounds</h2><table><thead><tr><th class="num">round</th><th class="num">start lvl</th><th class="num">end lvl</th>
      <th class="num">steps</th><th>outcome</th><th>Scorer hypothesis</th><th class="num">no-op</th><th class="num">cost</th></tr></thead>
      <tbody>${roundRows(g)}</tbody></table>
    <h2>Actions</h2><table><thead><tr><th>action</th><th class="num">uses</th><th class="num">no-op %</th>
      <th class="num">levels gained after</th><th>Model says</th></tr></thead><tbody>${actionRows(g)}</tbody></table>
    <h2>Action strip</h2><div class="panel">${actionStrip(g)}<div class="legend" style="margin-top:8px">${legendActions()}</div></div>
    <div class="grid2"><div><h2>Click map</h2><div class="panel"><canvas class="grid" id="clickmap"></canvas>
        <div class="muted" id="clicknote"></div></div></div>
      <div><h2>Change map</h2><div class="panel"><canvas class="grid" id="changemap"></canvas>
        <div class="muted">Cells that changed most</div></div></div></div>
    <div class="grid2"><div><h2>LLM latency</h2><div class="panel">${latency(g)}
      <div class="legend"><span><i style="background:var(--player)"></i>player</span><span><i style="background:var(--scorer)"></i>scorer</span></div></div></div>
      <div><h2>Calls with errors or retries</h2>${badCalls(g)}</div></div>`;
  for (const tr of el.querySelectorAll("tr[data-href]")) tr.onclick = () => ctx.go(tr.dataset.href);
  drawMaps(ctx, g, el).catch((err) => {
    el.querySelector("#clicknote").textContent = `Could not load frames: ${err.message}`;
  });
}
