// One LLM call: prompt, reply, diff, grid.
import { drawGrid } from "../grid.js";
import { esc, money, secs } from "../html.js";
import { objBox, promptSections } from "../prompt.js";
import { diffHtml, diffLines, foldSame } from "../textdiff.js";

const ui = { tab: "user", box: null, call: null };
let nav = null;   // {ctx, prev, next}

function callLink(g, id) { return `#/game/${encodeURIComponent(g.id)}/llm/${encodeURIComponent(id)}`; }

/** Calls of one role, in step order. */
function sameRole(g, role) {
  return [...g.llmStart.values()].filter((c) => c.role === role)
    .sort((a, b) => a.step - b.step || a.seq - b.seq);
}

function neighbours(g, rec) {
  const list = sameRole(g, rec.role);
  const i = list.findIndex((c) => c.call_id === rec.call_id);
  const other = [...g.llmStart.values()].find((c) => c.role !== rec.role && c.step === rec.step);
  return { prev: i > 0 ? list[i - 1].call_id : null, next: i >= 0 && i < list.length - 1 ? list[i + 1].call_id : null,
    other: other?.call_id ?? null };
}

export function leave() { nav = null; }

export function onKey(e) {
  if (!nav) return;
  const id = e.key === "ArrowLeft" ? nav.prev : e.key === "ArrowRight" ? nav.next : null;
  if (id) { e.preventDefault(); nav.ctx.go(callLink(nav.g, id)); }
}

/** User text with heads and object lines. */
function sectionsHtml(text) {
  const secs = promptSections(text);
  const toc = secs.filter((s) => s.name !== "start")
    .map((s, i) => `<a href="javascript:void 0" data-sec="${i}">${esc(s.name)}</a>`).join("");
  let k = 0;
  const body = secs.map((s) => {
    const lines = s.lines.map((line, j) => {
      const box = objBox(line);
      const cls = j === 0 && s.name !== "start" ? "sec-head" : "";
      if (box) {
        const on = ui.box && ui.box.x0 === box.x0 && ui.box.y0 === box.y0 && ui.box.id === box.id ? " on" : "";
        return `<span class="obj-line${on} ${cls}" data-box="${esc(JSON.stringify(box))}">${esc(line)}</span>`;
      }
      return cls ? `<span class="${cls}">${esc(line)}</span>` : esc(line);
    }).join("\n");
    const id = s.name === "start" ? "" : ` id="sec-${k++}"`;
    return `<div${id}>${lines}</div>`;
  }).join("");
  return `${toc ? `<div class="toc">${toc}</div>` : ""}<pre class="usertext">${body}</pre>`;
}

function diffTab(rec, prev) {
  if (!prev) return '<p class="muted">No earlier call of this role.</p>';
  const ops = foldSame(diffLines(prev.user, rec.user), 2);
  const changed = ops.filter((o) => o.op === "add" || o.op === "del").length;
  return `<p class="muted">User text vs <span class="mono">${esc(prev.call_id)}</span>: ${changed} changed lines.</p>
    <div class="difftext">${diffHtml(ops)}</div>`;
}

async function drawSide(ctx, g, rec, el) {
  const canvas = el.querySelector("#llmgrid");
  if (!canvas) return;
  const frames = await ctx.need(g.id, "frames.jsonl");
  const step = rec.role === "player" ? rec.step - 1 : rec.step;
  const line = frames.get(step) ?? frames.get(Math.max(0, step));
  const note = el.querySelector("#gridnote");
  if (!line) { note.textContent = "No grid for this step."; return; }
  drawGrid(canvas, { w: line.w, h: line.h, hex: line.frames[line.frames.length - 1] }, { size: 360, box: ui.box });
  note.textContent = `Grid after step ${step}${rec.role === "player" ? " (what the Player saw)" : ""}.`
    + (ui.box ? ` Box: obj#${ui.box.id}.` : " Click an obj# line to outline it.");
}

export async function render(ctx, route, el, g) {
  const file = await ctx.need(g.id, "llm.jsonl");
  let rec = file.get(route.callId);
  if (!rec) { await file.refresh(); rec = file.get(route.callId); }
  if (!rec) {
    const open = g.llmStart.get(route.callId);
    el.innerHTML = open
      ? `<p>Waiting for ${esc(open.role)} call ${esc(route.callId)} (started ${esc(open.ts)}).</p>`
      : `<p>No call ${esc(route.callId)}.</p>`;
    return;
  }
  if (ui.call !== rec.call_id) { ui.call = rec.call_id; ui.box = null; }
  const near = neighbours(g, rec);
  nav = { ctx, g, ...near };
  const prevRec = near.prev ? file.get(near.prev) : null;
  const update = rec.role === "scorer" ? g.models.find((u) => u.step === rec.step) : null;
  const tabs = {
    system: () => `<pre>${esc(rec.system)}</pre>`,
    user: () => sectionsHtml(rec.user),
    diff: () => diffTab(rec, prevRec),
    reply: () => `<pre>${esc(rec.reply)}</pre>`,
    parsed: () => `<pre>${esc(rec.parsed ? JSON.stringify(rec.parsed, null, 2) : "(none)")}</pre>`,
  };
  const names = { system: "System", user: "User", diff: "Diff vs previous", reply: "Reply", parsed: "Parsed" };
  if (!tabs[ui.tab]) ui.tab = "user";
  const stepLink = g.byStep.has(rec.step)
    ? `<a href="#/game/${encodeURIComponent(g.id)}/round/${rec.round}/step/${rec.step}">step ${rec.step}</a>` : `step ${rec.step}`;
  const links = [
    near.prev ? `<a href="${callLink(g, near.prev)}">◀ ${esc(near.prev)}</a>` : "",
    near.next ? `<a href="${callLink(g, near.next)}">${esc(near.next)} ▶</a>` : "",
    near.other ? `<a href="${callLink(g, near.other)}">${rec.role === "player" ? "scorer" : "player"} call ${esc(near.other)}</a>` : "",
    update ? `<a href="#/game/${encodeURIComponent(g.id)}/model/${update.version}">Model diff v${update.parent ?? 0} → v${update.version}</a>` : "",
  ].filter(Boolean).join("");
  el.innerHTML = `<div class="flex"><h1 class="mono">${esc(rec.call_id)}</h1><span>${esc(rec.role)}</span>${stepLink}
      <button id="copy">Copy as JSON</button><span class="nav-links">${links}</span>
      <span class="muted">← → prev / next call</span></div>
    <div class="tiles" style="margin-top:10px">
      <div class="tile"><div class="v mono" style="font-size:13px">${esc(rec.provider)} / ${esc(rec.model)}</div><div class="k">model</div></div>
      <div class="tile"><div class="v">${rec.in_tokens}</div><div class="k">tokens in</div></div>
      <div class="tile"><div class="v">${rec.out_tokens}</div><div class="k">tokens out</div></div>
      <div class="tile"><div class="v">${rec.cache_tokens}</div><div class="k">cache tokens</div></div>
      <div class="tile"><div class="v">${secs(rec.latency_ms)}</div><div class="k">latency</div></div>
      <div class="tile"><div class="v">${money(rec.cost_usd)}</div><div class="k">cost</div></div>
      <div class="tile"><div class="v">${rec.retries}</div><div class="k">retries</div></div>
      <div class="tile"><div class="v">${rec.ok ? "ok" : "failed"}</div><div class="k">result</div></div>
      <div class="tile"><div class="v mono" style="font-size:13px">${esc(rec.prompt_hash)}</div><div class="k">prompt hash</div></div>
    </div>
    ${rec.error ? `<div class="banner" style="margin-top:10px">${esc(rec.error)}</div>` : ""}
    <div class="tabs">${Object.keys(tabs).map((t) => `<button data-tab="${t}" class="${t === ui.tab ? "on" : ""}">${names[t]}</button>`).join("")}</div>
    <div class="llm-layout"><div id="tabbody">${tabs[ui.tab]()}</div>
      <div class="side panel"><canvas class="grid" id="llmgrid"></canvas><div class="muted" id="gridnote"></div></div></div>`;
  for (const b of el.querySelectorAll("button[data-tab]")) {
    b.onclick = () => { ui.tab = b.dataset.tab; ctx.rerender(); };
  }
  for (const a of el.querySelectorAll(".toc a[data-sec]")) {
    a.onclick = (e) => { e.preventDefault(); el.querySelector(`#sec-${a.dataset.sec}`)?.scrollIntoView({ block: "start" }); };
  }
  for (const span of el.querySelectorAll(".obj-line")) {
    span.onclick = () => {
      const box = JSON.parse(span.dataset.box);
      const same = ui.box && ui.box.id === box.id && ui.box.x0 === box.x0 && ui.box.y0 === box.y0;
      ui.box = same ? null : box;
      for (const s of el.querySelectorAll(".obj-line.on")) s.classList.remove("on");
      if (ui.box) span.classList.add("on");
      drawSide(ctx, g, rec, el).catch(() => {});
    };
  }
  el.querySelector("#copy").onclick = async () => {
    await navigator.clipboard.writeText(JSON.stringify(rec, null, 2));
    el.querySelector("#copy").textContent = "Copied";
  };
  drawSide(ctx, g, rec, el).catch((err) => { el.querySelector("#gridnote").textContent = `Could not load frames: ${err.message}`; });
}
