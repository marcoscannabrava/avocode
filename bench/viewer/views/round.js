// Round player: grid, diff, step controls.
import { drawGrid } from "../grid.js";
import { esc, secs, shortAction } from "../html.js";
import { isLevelUp, problemWords, stepProblems } from "../metrics.js";
import { stripCells } from "./game.js";

const ui = {
  playing: null, speed: 1, diff: true, before: false, follow: false, frame: null, key: "", model: false,
  problems: false,
};

export function liveRefresh() { return ui.follow; }

export function leave() { stop(); }

function stop() {
  if (ui.playing) clearInterval(ui.playing);
  ui.playing = null;
}

function link(g, round, step) {
  return `#/game/${encodeURIComponent(g.id)}/round/${round}${step !== undefined ? `/step/${step}` : ""}`;
}

function frameOf(line, idx) {
  if (!line) return null;
  const i = idx === null || idx >= line.frames.length ? line.frames.length - 1 : idx;
  return { w: line.w, h: line.h, hex: line.frames[i], index: i, count: line.frames.length };
}

let state = null;   // {ctx, g, r, idx}

function goStep(delta) {
  if (!state) return;
  const { ctx, g, r, idx } = state;
  const next = Math.max(0, Math.min(r.steps.length - 1, idx + delta));
  if (next === idx) { stop(); return false; }
  ui.frame = null;
  ctx.go(link(g, r.round, r.steps[next].step));
  return true;
}

function goRound(delta) {
  if (!state) return;
  const { ctx, g, r } = state;
  const rounds = g.roundList().map((x) => x.round);
  const i = rounds.indexOf(r.round) + delta;
  if (i >= 0 && i < rounds.length) { stop(); ctx.go(link(g, rounds[i])); }
}

function togglePlay() {
  if (ui.playing) { stop(); state?.ctx.rerender(); return; }
  ui.playing = setInterval(() => { if (!goStep(1)) state?.ctx.rerender(); }, 1000 / ui.speed);
  state?.ctx.rerender();
}

export function onKey(e, ctx) {
  const keys = {
    ArrowLeft: () => goStep(-1), ArrowRight: () => goStep(1), " ": togglePlay,
    "[": () => goRound(-1), "]": () => goRound(1),
    d: () => { ui.diff = !ui.diff; ctx.rerender(); },
    b: () => { ui.before = !ui.before; ctx.rerender(); },
    m: () => { if (state) ctx.go(`#/game/${encodeURIComponent(state.g.id)}/model/${state.step?.model_version ?? ""}`); },
  };
  const fn = keys[e.key];
  if (fn) { e.preventDefault(); fn(); }
}

function levelText(s) {
  const a = s.before.levels_completed, b = s.after.levels_completed;
  if (b > a) return `level ${a + 1} <span class="lvl-up">level complete · levels done ${a} → ${b}</span>`;
  return `level ${a + 1} <span class="muted">(levels done ${a})</span>`;
}

/** Goal and open questions the Player saw. */
function beliefRows(g, s) {
  const model = g.modelAt(s.model_version);
  if (!model) return "";
  const qs = (model.open_questions ?? []).map((q) => `<li>${esc(q)}</li>`).join("");
  return `<b>goal</b><span>${esc(model.prompt) || "—"}</span>
    ${qs ? `<b>open questions</b><span><ul class="tight">${qs}</ul></span>` : ""}`;
}

function sidePanel(g, r, s, idx, probs) {
  const gid = encodeURIComponent(g.id);
  const calls = s.call_ids.map((id) => {
    const end = g.llmEnd.get(id);
    const role = id.startsWith("p") ? "player" : "scorer";
    const lat = end ? secs(end.latency_ms) : "running…";
    return `<a href="#/game/${gid}/llm/${encodeURIComponent(id)}">${role} ${lat}</a>`;
  }).join(" · ") || "—";
  const warns = g.warnings.filter((w) => w.step === s.step)
    .map((w) => `<div><code>${esc(w.code)}</code> ${esc(w.message)}</div>`).join("");
  const isLast = idx === r.steps.length - 1;
  const end = isLast && r.end ? `<b>round end</b><span>${esc(r.end.outcome)}${r.end.hypothesis ? `: ${esc(r.end.hypothesis)}` : ""}</span>` : "";
  const update = g.models.find((u) => u.step === s.step);
  let mv = `<a href="#/game/${gid}/model/${s.model_version}">v${s.model_version}</a>`;
  if (update) {
    mv += ` → <a href="#/game/${gid}/model/${update.version}" title="${esc(update.changes.join("\n"))}">v${update.version}</a>`
      + `<div class="muted">${esc(update.summary || `${update.changes.length} fields changed`)}</div>`;
  } else if (problemWords(probs.get(s.step)).includes("scorer_skipped")) {
    mv += ' <span class="muted">(Scorer skipped, no change)</span>';
  }
  const status = isLevelUp(s) ? `<span class="lvl-up">level complete</span> · ${esc(s.after.game_state)}`
    : `${esc(s.status)} · ${esc(s.after.game_state)}`;
  return `<div class="panel kv">
    <b>step</b><span>${s.step} <span class="muted">(round ${s.round}, step ${s.round_step})</span></span>
    <b>level</b><span>${levelText(s)}</span>
    <b>action</b><span class="mono">${esc(s.action.name)}${s.action.x !== null && s.action.x !== undefined ? ` @ (${s.action.x}, ${s.action.y})` : ""}</span>
    <b>reason</b><span>${esc(s.reason) || "—"}</span>
    <b>status</b><span>${status} · diff ${s.diff.cells} cells${s.diff.noop ? " (no-op)" : ""}</span>
    <b>Model</b><span>${mv}</span>
    ${beliefRows(g, s)}
    <b>calls</b><span>${calls}</span>
    <b>flags</b><span>${s.flags.map((f) => `<code>${esc(f)}</code>`).join(" ") || "—"}</span>
    ${warns ? `<b>warnings</b><span>${warns}</span>` : ""}
    ${end}
  </div>`;
}

/** Full Model after this step, collapsed. */
function modelPanel(g, s) {
  const update = g.models.find((u) => u.step === s.step);
  const version = update ? update.version : s.model_version;
  const model = g.modelAt(version);
  const note = update ? "updated in this step" : "no change in this step";
  const body = model ? `<pre>${esc(JSON.stringify(model, null, 2))}</pre>` : '<p class="muted">No Model yet.</p>';
  return `<details class="model-full" id="model-full" ${ui.model ? "open" : ""}>
    <summary>Full Model v${version} <span class="muted">(${note})</span></summary>${body}</details>`;
}

function strip(g, r, idx, probs) {
  const cells = stripCells(g, r, probs, (s) => link(g, r.round, s.step), idx);
  const out = r.end?.outcome ?? "playing";
  return `<div class="strip">${cells}<span class="end-${out}" title="${esc(out)}">${out === "failed" ? "✗" : ""}</span></div>`;
}

/** One row per step, with problems. */
function stepLog(g, r, idx, probs) {
  const rows = r.steps.map((s, i) => {
    const p = probs.get(s.step);
    if (ui.problems && !p?.any && i !== idx) return "";
    const words = problemWords(p);
    const cls = ["click", i === idx ? "cur" : "", isLevelUp(s) ? "lvl-row" : ""].join(" ");
    return `<tr class="${cls}" data-href="${link(g, r.round, s.step)}">
      <td class="num">${s.step}</td><td class="mono">${esc(shortAction(s.action))}</td>
      <td class="num">${s.diff.cells}</td>
      <td>${isLevelUp(s) ? '<span class="lvl-up">level complete</span> ' : ""}${words.map((w) => `<code>${esc(w)}</code>`).join(" ")}</td>
      <td class="num">v${s.model_version}</td><td>${esc(s.reason)}</td></tr>`;
  }).join("");
  return `<div class="flex" style="margin-top:16px"><h2 style="margin:0">Step log</h2>
      <label><input type="checkbox" id="problems" ${ui.problems ? "checked" : ""}> problems only</label>
      <span class="muted">no-op, repeat state, fallback, Scorer skipped</span></div>
    <div class="steplog" id="steplog"><table><thead><tr><th class="num">step</th><th>action</th><th class="num">diff</th>
      <th>flags and warnings</th><th class="num">Model</th><th>reason</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export async function render(ctx, route, el, g) {
  let roundNo = route.round;
  if (ui.follow && g.rounds.size) roundNo = Math.max(...g.rounds.keys());
  const r = g.rounds.get(roundNo);
  if (!r) { el.innerHTML = `<p>No round ${esc(route.round)}.</p>`; return; }
  if (!r.steps.length) { el.innerHTML = `<p>Round ${r.round} has no steps yet.</p>`; return; }
  let idx = route.step !== undefined ? r.steps.findIndex((s) => s.step === route.step) : 0;
  if (ui.follow) idx = r.steps.length - 1;
  if (idx < 0) idx = 0;
  const s = r.steps[idx];
  const key = `${g.id}/${s.step}`;
  if (key !== ui.key) { ui.frame = null; ui.key = key; }
  state = { ctx, g, r, idx, step: s };
  const probs = stepProblems(g);
  const levelUp = isLevelUp(s);
  const frames = await ctx.need(g.id, "frames.jsonl");
  if (!frames.get(s.step)) await frames.refresh();
  const cur = frameOf(frames.get(s.step), ui.frame);
  const prevLine = frames.get(s.step - 1);
  const prev = frameOf(prevLine, null);
  const shown = ui.before ? prev : cur;
  const rounds = g.roundList();
  const pos = rounds.findIndex((x) => x.round === r.round);
  el.innerHTML = `<div class="flex"><h1>Round ${r.round}</h1>
      <span class="muted">${r.steps.length} steps · ${esc(r.end?.outcome ?? "playing")} · start level ${r.start.level}${r.start.full_reset ? " · full reset" : ""}</span>
      ${pos > 0 ? `<a href="${link(g, rounds[pos - 1].round)}">◀ round ${rounds[pos - 1].round}</a>` : ""}
      ${pos < rounds.length - 1 ? `<a href="${link(g, rounds[pos + 1].round)}">round ${rounds[pos + 1].round} ▶</a>` : ""}</div>
    <div class="round-layout" style="margin-top:12px">
      <div><canvas class="grid" id="grid"></canvas>
        <div class="controls">
          <button id="diff" class="${ui.diff ? "on" : ""}" title="d">diff</button>
          <button id="before" class="${ui.before ? "on" : ""}" title="b">${ui.before ? "before" : "after"}</button>
          ${cur && cur.count > 1 ? `<button id="fprev">◀</button><span class="mono">frame ${cur.index + 1}/${cur.count}</span><button id="fnext">▶</button>` : ""}
          <button id="follow" class="${ui.follow ? "on" : ""}">follow</button>
          ${levelUp && ui.diff && !ui.before ? '<span class="muted">new level, diff hidden</span>' : ""}
        </div></div>
      <div>${sidePanel(g, r, s, idx, probs)}${modelPanel(g, s)}</div>
    </div>
    <div class="controls">
      <button id="first">◀◀</button><button id="back">◀</button>
      <button id="play">${ui.playing ? "❚❚" : "▶"}</button><button id="fwd">▶</button><button id="last">▶▶</button>
      <select id="speed">${[1, 2, 4, 8].map((v) => `<option value="${v}" ${v === ui.speed ? "selected" : ""}>${v}x</option>`).join("")}</select>
      <input type="range" id="slider" min="0" max="${r.steps.length - 1}" value="${idx}">
      <span class="mono">${idx + 1} / ${r.steps.length}</span>
    </div>
    ${strip(g, r, idx, probs)}
    <p class="muted">Keys: ← → step · space play · [ ] round · d diff · b before/after · m Model</p>
    ${stepLog(g, r, idx, probs)}`;
  if (shown) {
    drawGrid(el.querySelector("#grid"), shown, {
      prev: ui.diff && !ui.before && !levelUp ? prev : null,
      click: s.action.name === "ACTION6" ? { x: s.action.x, y: s.action.y } : null,
    });
  }
  for (const tr of el.querySelectorAll("#steplog tr[data-href]")) tr.onclick = () => ctx.go(tr.dataset.href);
  el.querySelector("#problems").onchange = (e) => { ui.problems = e.target.checked; ctx.rerender(); };
  const box = el.querySelector("#steplog"), row = box.querySelector("tr.cur");
  if (row) box.scrollTop = row.offsetTop - box.clientHeight / 2;
  el.querySelector("#model-full").ontoggle = (e) => { ui.model = e.target.open; };
  const on = (id, fn) => { const b = el.querySelector(id); if (b) b.onclick = fn; };
  on("#diff", () => { ui.diff = !ui.diff; ctx.rerender(); });
  on("#before", () => { ui.before = !ui.before; ctx.rerender(); });
  on("#follow", () => { ui.follow = !ui.follow; ctx.rerender(); });
  on("#fprev", () => { ui.frame = Math.max(0, cur.index - 1); ctx.rerender(); });
  on("#fnext", () => { ui.frame = Math.min(cur.count - 1, cur.index + 1); ctx.rerender(); });
  on("#first", () => goStep(-idx));
  on("#back", () => goStep(-1));
  on("#fwd", () => goStep(1));
  on("#last", () => goStep(r.steps.length));
  on("#play", togglePlay);
  el.querySelector("#speed").onchange = (e) => {
    ui.speed = Number(e.target.value);
    if (ui.playing) { stop(); togglePlay(); }
  };
  el.querySelector("#slider").oninput = (e) => ctx.go(link(g, r.round, r.steps[Number(e.target.value)].step));
}
