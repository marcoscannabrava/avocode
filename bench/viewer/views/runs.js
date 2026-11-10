// Runs table: compare runs by prompt hash.
import { RunStore, parseLines, safeName } from "../store.js";
import { compareRows } from "../metrics.js";
import { scatter } from "../charts.js";
import { esc, money, pct } from "../html.js";

const cache = new Map();   // runId -> {runId, manifest, run}
const ui = { sort: "run" };

async function text(url) {
  const resp = await fetch(url, { cache: "no-store" });
  return resp.ok ? resp.text() : "";
}

/** Load one finished run once. */
async function loadRun(runId) {
  if (cache.has(runId)) return cache.get(runId);
  const base = `/runs/${encodeURIComponent(runId)}`;
  const raw = await text(`${base}/manifest.json`);
  const manifest = raw ? JSON.parse(raw) : null;
  const run = new RunStore(runId);
  run.addRun(parseLines(await text(`${base}/run.jsonl`)));
  await Promise.all([...run.games.keys()].map(async (id) => {
    run.games.get(id).add(parseLines(await text(`${base}/games/${encodeURIComponent(safeName(id))}/events.jsonl`)));
  }));
  const item = { runId, manifest, run };
  if (run.end) cache.set(runId, item);
  return item;
}

function levelList(done, open) {
  const parts = done.map(String);
  if (open !== null && open !== undefined) parts.push(`${open}+`);
  return parts.join(", ") || "—";
}

function meanSteps(r) {
  if (!r.stepsPerLevel.length) return null;
  return r.stepsPerLevel.reduce((a, b) => a + b, 0) / r.stepsPerLevel.length;
}

export async function render(ctx, route, el) {
  const ids = ctx.config?.runs ?? [];
  if (!el.querySelector("#runstable")) el.innerHTML = `<p class="muted">Loading ${ids.length} runs…</p>`;
  const items = await Promise.all(ids.map((id) => (id === ctx.runId
    ? { runId: id, manifest: ctx.manifest, run: ctx.run } : loadRun(id))));
  let rows = compareRows(items, ctx.now());
  const order = rows.map((r) => `${r.run}|${r.game}`);
  if (ui.sort === "hash") {
    rows = [...rows].sort((a, b) => a.player.localeCompare(b.player) || a.scorer.localeCompare(b.scorer)
      || a.run.localeCompare(b.run));
    rows.forEach((r, i) => {
      r.newPlayer = i > 0 && rows[i - 1].player !== r.player;
      r.newScorer = i > 0 && rows[i - 1].scorer !== r.scorer;
    });
  }
  const hash = (h, isNew) => `<td class="mono ${isNew ? "diffcell" : ""}">${esc(h)}</td>`;
  const body = rows.map((r) => `<tr class="click" data-run="${esc(r.run)}" data-game="${esc(r.game)}">
    <td class="mono">${esc(r.run)}${r.run === ctx.runId ? " <span class=\"muted\">(open)</span>" : ""}</td>
    <td>${r.tags.map((t) => `<code>${esc(t)}</code>`).join(" ")}</td>
    <td class="mono" style="white-space:nowrap">${esc(r.game)}</td>
    ${hash(r.player, r.newPlayer)}${hash(r.scorer, r.newScorer)}
    <td class="mono" style="font-size:12px">${esc(r.models)}</td>
    <td class="num">${r.levels}/${r.winLevels}</td><td class="num">${r.steps}</td>
    <td>${levelList(r.stepsPerLevel, r.openLevelSteps)}</td>
    <td class="num">${pct(r.noopRate)}</td><td class="num">${pct(r.repeatStateRate)}</td>
    <td class="num">${r.lostSteps}</td><td class="num">${money(r.cost)}</td>
    <td class="num">${r.costPerLevel === null ? "—" : money(r.costPerLevel)}</td></tr>`).join("");
  const pts = rows.map((r) => {
    const x = order.indexOf(`${r.run}|${r.game}`) + 1;
    const mean = meanSteps(r);
    return mean === null
      ? { x, y: r.steps, cls: "failed", title: `${r.run} ${r.game}: no level in ${r.steps} steps` }
      : { x, y: mean, cls: "won", title: `${r.run} ${r.game}: ${mean.toFixed(1)} steps per level` };
  });
  el.innerHTML = `<div class="flex"><h1>Runs</h1><span class="muted">${ids.length} runs in runs/</span>
      <label>sort <select id="sort"><option value="run" ${ui.sort === "run" ? "selected" : ""}>run order</option>
        <option value="hash" ${ui.sort === "hash" ? "selected" : ""}>prompt hash</option></select></label>
      <span class="muted">Blue hash: differs from the row above.</span></div>
    <div id="runstable" style="margin-top:12px;overflow-x:auto"><table><thead><tr><th>run</th><th>tags</th><th>game</th>
      <th>player hash</th><th>scorer hash</th><th>models</th><th class="num">levels</th><th class="num">steps</th>
      <th>steps per level</th><th class="num">no-op</th><th class="num">repeat state</th><th class="num">lost steps</th>
      <th class="num">cost</th><th class="num">cost per level</th></tr></thead><tbody>${body}</tbody></table></div>
    <h2>Steps per level, in run order</h2><div class="panel">${scatter(pts, { xMax: Math.max(1, order.length), yLabel: "steps", width: 1200, height: 220 })}
      <div class="legend"><span><i style="background:var(--won)"></i>mean steps per done level</span>
      <span><i style="background:var(--failed)"></i>no level done (total steps)</span></div></div>`;
  for (const tr of el.querySelectorAll("tr[data-run]")) {
    tr.onclick = () => {
      const game = `#/game/${encodeURIComponent(tr.dataset.game)}`;
      if (tr.dataset.run === ctx.runId) ctx.go(game);
      else location.href = `/?run=${encodeURIComponent(tr.dataset.run)}${game}`;
    };
  }
  el.querySelector("#sort").onchange = (e) => { ui.sort = e.target.value; ctx.rerender(); };
}
