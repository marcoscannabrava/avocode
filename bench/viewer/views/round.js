// Round player: grid, diff, step controls.
import { drawGrid } from "../grid.js";
import { esc, secs, shortAction } from "../html.js";

const ui = { playing: null, speed: 1, diff: true, before: false, follow: false, frame: null, key: "", model: false };

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

function sidePanel(g, r, s, idx) {
  const calls = s.call_ids.map((id) => {
    const end = g.llmEnd.get(id);
    const role = id.startsWith("p") ? "player" : "scorer";
    const lat = end ? secs(end.latency_ms) : "running…";
    return `<a href="#/game/${encodeURIComponent(g.id)}/llm/${encodeURIComponent(id)}">${role} ${lat}</a>`;
  }).join(" · ") || "—";
  const warns = g.warnings.filter((w) => w.step === s.step)
    .map((w) => `<div><code>${esc(w.code)}</code> ${esc(w.message)}</div>`).join("");
  const isLast = idx === r.steps.length - 1;
  const end = isLast && r.end ? `<b>round end</b><span>${esc(r.end.outcome)}${r.end.hypothesis ? `: ${esc(r.end.hypothesis)}` : ""}</span>` : "";
  const update = g.models.find((u) => u.step === s.step);
  const mv = `<a href="#/game/${encodeURIComponent(g.id)}/model/${s.model_version}">v${s.model_version}</a>`
    + (update ? ` → <a href="#/game/${encodeURIComponent(g.id)}/model/${update.version}">v${update.version}</a> <span class="muted">(${esc(update.changes.slice(0, 3).join(", "))}${update.changes.length > 3 ? "…" : ""})</span>` : "");
  return `<div class="panel kv">
    <b>step</b><span>${s.step} <span class="muted">(round ${s.round}, step ${s.round_step})</span> level ${s.level}</span>
    <b>action</b><span class="mono">${esc(s.action.name)}${s.action.x !== null && s.action.x !== undefined ? ` @ (${s.action.x}, ${s.action.y})` : ""}</span>
    <b>reason</b><span>${esc(s.reason) || "—"}</span>
    <b>status</b><span>${esc(s.status)} · diff ${s.diff.cells} cells${s.diff.noop ? " (no-op)" : ""} · ${esc(s.after.game_state)}</span>
    <b>Model</b><span>${mv}</span>
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

function strip(g, r, idx) {
  const repeat = new Set(g.warnings.filter((w) => w.code === "repeat_state").map((w) => w.step));
  const cells = r.steps.map((s, i) => {
    const cls = [`act-${s.action.name}`, s.diff.noop ? "hollow" : "", repeat.has(s.step) ? "rep" : "", i === idx ? "cur" : ""].join(" ");
    return `<a class="${cls}" href="${link(g, r.round, s.step)}" title="${s.step}: ${esc(shortAction(s.action))}"></a>`;
  }).join("");
  const out = r.end?.outcome ?? "playing";
  return `<div class="strip">${cells}<span class="end-${out}" title="${esc(out)}">${out === "failed" ? "✗" : ""}</span></div>`;
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
        </div></div>
      <div>${sidePanel(g, r, s, idx)}${modelPanel(g, s)}</div>
    </div>
    <div class="controls">
      <button id="first">◀◀</button><button id="back">◀</button>
      <button id="play">${ui.playing ? "❚❚" : "▶"}</button><button id="fwd">▶</button><button id="last">▶▶</button>
      <select id="speed">${[1, 2, 4, 8].map((v) => `<option value="${v}" ${v === ui.speed ? "selected" : ""}>${v}x</option>`).join("")}</select>
      <input type="range" id="slider" min="0" max="${r.steps.length - 1}" value="${idx}">
      <span class="mono">${idx + 1} / ${r.steps.length}</span>
    </div>
    ${strip(g, r, idx)}
    <p class="muted">Keys: ← → step · space play · [ ] round · d diff · b before/after · m Model</p>`;
  if (shown) {
    drawGrid(el.querySelector("#grid"), shown, {
      prev: ui.diff && !ui.before ? prev : null,
      click: s.action.name === "ACTION6" ? { x: s.action.x, y: s.action.y } : null,
    });
  }
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
