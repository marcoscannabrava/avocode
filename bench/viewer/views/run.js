// Run overview: health, score, cost.
import { HEALTH_ORDER, gameMetrics, levelSeries, modelLabel, runMetrics } from "../metrics.js";
import { stackedBars, stepLine } from "../charts.js";
import { age, duration, esc, money, tile } from "../html.js";

const HEALTH_TEXT = {
  won: "✓ won", done: "done", error: "✗ error", playing: "● playing", waiting: "⚠ waiting",
  stalled: "⚠ stalled", pending: "pending",
};

export function liveRefresh() { return true; }

function bar(value, max, cls = "") {
  const w = max ? Math.min(100, (100 * value) / max) : 0;
  return `<span class="bar ${cls}"><i style="width:${w}%"></i></span>`;
}

function lastEvent(m) {
  if (m.health === "waiting" && m.openCall) {
    return `${age(m.lastEventAgeS)} ${esc(m.openCall.role)}`;
  }
  if (m.outcome) return "—";
  return age(m.lastEventAgeS);
}

export function render(ctx, route, el) {
  const now = ctx.now();
  const run = ctx.run;
  const rm = runMetrics(run, now);
  const man = ctx.manifest ?? {};
  const git = man.git?.commit ? `git ${esc(man.git.commit.slice(0, 7))}${man.git.dirty ? "*" : ""}` : "";
  const tags = (man.tags ?? []).map((t) => `<code>${esc(t)}</code>`).join(" ");
  const cfg = man.config ?? run.start?.config ?? {};
  const settings = [
    `player <span class="mono">${esc(modelLabel(cfg, "player"))}</span>`,
    `scorer <span class="mono">${esc(modelLabel(cfg, "scorer"))}</span>`,
    `max_actions ${esc(cfg.max_actions ?? "?")}`,
    `skip_noop_scorer ${cfg.skip_noop_scorer === undefined ? "?" : cfg.skip_noop_scorer ? "on" : "off"}`,
  ].join(" · ");
  const rows = [...run.games.values()].map((g) => ({ g, m: gameMetrics(g, now) }));
  rows.sort((a, b) => HEALTH_ORDER.indexOf(a.m.health) - HEALTH_ORDER.indexOf(b.m.health)
    || a.g.id.localeCompare(b.g.id));

  let html = `<div class="flex"><h1 class="mono">run ${esc(run.runId)}</h1>
    <span>${rm.live ? '<span class="dot h-playing"></span>live' : "finished"}</span>
    <span>${duration(rm.durationS)}</span><span>${money(rm.cost)}</span>
    <span class="muted mono">${git}</span>${tags}<a href="#/runs">compare runs</a></div>
    <div class="muted" style="margin-top:4px">${settings}</div>`;
  html += `<div class="tiles" style="margin-top:10px">
    ${tile("levels", `${rm.levels}/${rm.winLevels}`)}${tile("games won", `${rm.gamesWon}/${rm.games}`)}
    ${tile("steps", rm.steps)}${tile("errors", rm.errors)}${tile("warnings", rm.warnings)}
    ${tile("cost", money(rm.cost))}${tile("prompts", `<span class="mono" style="font-size:12px">P ${esc(man.prompts?.player ?? "?")}<br>S ${esc(man.prompts?.scorer ?? "?")}</span>`)}
  </div>`;

  html += `<h2>Games</h2><table><thead><tr><th>game</th><th>state</th><th>levels</th>
    <th class="num">rounds</th><th>steps / budget</th><th class="num">cost</th><th>last event</th></tr></thead><tbody>`;
  for (const { g, m } of rows) {
    html += `<tr class="click" data-href="#/game/${encodeURIComponent(g.id)}">
      <td class="mono">${esc(g.id)}</td>
      <td><span class="dot h-${m.health}"></span>${HEALTH_TEXT[m.health] ?? m.health}</td>
      <td>${bar(m.levels, m.winLevels)}${m.levels}/${m.winLevels}</td>
      <td class="num">${m.rounds}</td>
      <td>${bar(m.steps, m.maxActions, "budget")}${m.steps}/${m.maxActions ?? "?"}</td>
      <td class="num">${money(m.cost)}</td><td>${lastEvent(m)}</td></tr>`;
  }
  html += "</tbody></table>";

  const series = rows.map(({ g }, i) => ({
    name: g.id, color: `var(--c${(i % 8) + 1})`, pts: levelSeries(g),
    xEnd: g.steps.length ? g.steps[g.steps.length - 1].step : 0,
  }));
  const xMax = Math.max(1, ...rows.map(({ m }) => m.steps));
  const yMax = Math.max(1, ...rows.map(({ m }) => m.winLevels));
  const legend = series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("");
  const costRows = rows.map(({ g, m }) => ({
    label: g.id.slice(0, 14),
    parts: [{ cls: "player", name: "P", value: m.llm.player.cost ?? 0 },
      { cls: "scorer", name: "S", value: m.llm.scorer.cost ?? 0 }],
  }));
  html += `<div class="grid2"><div><h2>Levels over steps</h2><div class="panel">
      ${stepLine({ series, xMax, yMax, height: 220 })}<div class="legend">${legend}</div></div></div>
    <div><h2>Cost by role</h2><div class="panel">${stackedBars(costRows, { fmt: money })}
      <div class="legend"><span><i style="background:var(--player)"></i>player</span>
      <span><i style="background:var(--scorer)"></i>scorer</span></div></div></div></div>`;
  el.innerHTML = html;
  for (const tr of el.querySelectorAll("tr[data-href]")) tr.onclick = () => ctx.go(tr.dataset.href);
}
