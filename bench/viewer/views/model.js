// Model history: versions, diffs, failed rounds.
import { churnByRound, hypothesisGroups } from "../metrics.js";
import { bars } from "../charts.js";
import { esc } from "../html.js";

const FIELDS = ["prompt", "element_breakdown", "allowable_actions", "level_notes", "open_questions", "failed_rounds"];

function show(v) { return typeof v === "string" ? v : JSON.stringify(v); }

/** Field-by-field diff lines. */
function fieldDiff(field, a, b) {
  const lines = [];
  const add = (t) => lines.push(`<div class="diff-line diff-add">+ ${esc(t)}</div>`);
  const del = (t) => lines.push(`<div class="diff-line diff-del">− ${esc(t)}</div>`);
  if (a && b && typeof a === "object" && !Array.isArray(a)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (show(a[k]) === show(b[k])) continue;
      if (k in a) del(`${k}: ${show(a[k])}`);
      if (k in b) add(`${k}: ${show(b[k])}`);
    }
  } else if (Array.isArray(a) || Array.isArray(b)) {
    const sa = new Set((a ?? []).map(show)), sb = new Set((b ?? []).map(show));
    for (const x of sa) if (!sb.has(x)) del(x);
    for (const x of sb) if (!sa.has(x)) add(x);
  } else if (show(a) !== show(b)) {
    if (a) del(show(a));
    if (b) add(show(b));
  }
  return lines.length ? `<h3 style="font-size:13px;margin:12px 0 4px">${esc(field)}</h3>${lines.join("")}` : "";
}

export function render(ctx, route, el, g) {
  const versions = g.models;
  if (!versions.length) { el.innerHTML = "<p>No Model updates yet.</p>"; return; }
  const sel = route.version !== null && route.version !== undefined && g.modelByVersion.has(route.version)
    ? g.modelByVersion.get(route.version) : versions[versions.length - 1];
  const parent = sel.parent !== null ? g.modelByVersion.get(sel.parent)?.model ?? {} : {};
  const list = versions.map((u) => {
    const round = g.byStep.get(u.step)?.round ?? 1;
    return `<div class="row ${u === sel ? "sel" : ""}" data-v="${u.version}">
      <b>v${u.version}</b> <span class="muted">step ${u.step}, round ${round}</span><br>${esc(u.summary || u.changes.join(", "))}</div>`;
  }).join("");
  const diff = FIELDS.map((f) => fieldDiff(f, parent[f], sel.model[f])).join("") || '<p class="muted">No change.</p>';
  const groups = hypothesisGroups(sel.model).map((h) =>
    `<tr><td class="num">${h.rounds.length}</td><td class="mono">${h.rounds.join(", ")}</td><td>${esc(h.hypothesis)}</td></tr>`).join("");
  const churn = churnByRound(g).map((c) => ({ label: `r${c.round}`, value: c.count }));
  el.innerHTML = `<h1>Model history</h1>
    <div class="grid2" style="grid-template-columns: minmax(240px, 320px) 1fr; margin-top:12px">
      <div class="panel versions">${list}</div>
      <div><div class="panel"><div class="flex"><b>v${sel.version}</b><span class="muted">parent ${sel.parent ?? "none"} · step ${sel.step}</span>
        <span class="muted">changed: ${esc(sel.changes.join(", "))}</span></div>${diff}</div>
        <h2>Full Model v${sel.version}</h2><pre>${esc(JSON.stringify(sel.model, null, 2))}</pre></div>
    </div>
    <div class="grid2"><div><h2>Failed rounds (grouped by hypothesis)</h2>
      ${groups ? `<table><tr><th class="num">count</th><th>rounds</th><th>hypothesis</th></tr>${groups}</table>` : '<p class="muted">None.</p>'}</div>
      <div><h2>Model versions per round</h2><div class="panel">${bars(churn, { cls: "scorer" })}</div></div></div>`;
  for (const row of el.querySelectorAll(".row[data-v]")) {
    row.onclick = () => ctx.go(`#/game/${encodeURIComponent(g.id)}/model/${row.dataset.v}`);
  }
}
