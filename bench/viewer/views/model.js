// Model history: versions, diffs, failed rounds.
import { churnByRound, hypothesisGroups } from "../metrics.js";
import { bars } from "../charts.js";
import { esc } from "../html.js";
import { diffHtml, diffTokens, keyedDiffOps } from "../textdiff.js";

const FIELDS = ["prompt", "element_breakdown", "allowable_actions", "level_notes", "open_questions", "failed_rounds"];
const ui = { goalOnly: false };

function show(v) { return typeof v === "string" ? v : JSON.stringify(v); }

/** Diff ops for one field. */
function fieldOps(a, b) {
  const isMap = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (isMap(a) || isMap(b)) return keyedDiffOps(a ?? {}, b ?? {});
  if (Array.isArray(a) || Array.isArray(b)) {
    return diffTokens((a ?? []).map(show), (b ?? []).map(show)).filter((o) => o.op !== "same");
  }
  if (show(a ?? "") === show(b ?? "")) return [];
  const ops = [];
  if (a) ops.push({ op: "del", text: show(a) });
  if (b) ops.push({ op: "add", text: show(b) });
  return ops;
}

function fieldDiff(field, a, b) {
  const ops = fieldOps(a, b);
  return ops.length ? `<h3 style="font-size:13px;margin:12px 0 4px">${esc(field)}</h3>${diffHtml(ops)}` : "";
}

/** Short labels for big changes. */
function labels(u) {
  const out = [];
  if (u.changes.includes("prompt")) out.push("goal");
  if (u.changes.some((c) => c.startsWith("allowable_actions"))) out.push("actions");
  if (u.changes.includes("open_questions")) out.push("questions");
  return out;
}

export function render(ctx, route, el, g) {
  const versions = g.models;
  if (!versions.length) { el.innerHTML = "<p>No Model updates yet.</p>"; return; }
  const sel = route.version !== null && route.version !== undefined && g.modelByVersion.has(route.version)
    ? g.modelByVersion.get(route.version) : versions[versions.length - 1];
  const parent = sel.parent !== null ? g.modelByVersion.get(sel.parent)?.model ?? {} : {};
  const list = versions.filter((u) => u === sel || !ui.goalOnly || u.changes.includes("prompt")).map((u) => {
    const round = g.byStep.get(u.step)?.round ?? 1;
    const tags = labels(u).map((l) => `<span class="label">${l}</span>`).join("");
    return `<div class="row ${u === sel ? "sel" : ""}" data-v="${u.version}">
      <b>v${u.version}</b>${tags} <span class="muted">step ${u.step}, round ${round}</span><br>${esc(u.summary || u.changes.join(", "))}</div>`;
  }).join("");
  const diff = FIELDS.map((f) => fieldDiff(f, parent[f], sel.model[f])).join("") || '<p class="muted">No change.</p>';
  const groups = hypothesisGroups(sel.model).map((h) =>
    `<tr><td class="num">${h.rounds.length}</td><td class="mono">${h.rounds.join(", ")}</td><td>${esc(h.hypothesis)}</td></tr>`).join("");
  const churn = churnByRound(g).map((c) => ({ label: `r${c.round}`, value: c.count }));
  const failed = groups
    ? `<div><h2>Failed rounds (grouped by hypothesis)</h2><table><tr><th class="num">count</th><th>rounds</th><th>hypothesis</th></tr>${groups}</table></div>`
    : "";
  const churnChart = churn.length > 1
    ? `<div><h2>Model versions per round</h2><div class="panel">${bars(churn, { cls: "scorer" })}</div></div>` : "";
  el.innerHTML = `<div class="flex"><h1>Model history</h1>
      <label><input type="checkbox" id="goalonly" ${ui.goalOnly ? "checked" : ""}> goal changes only</label>
      ${!groups ? '<span class="muted">No failed rounds.</span>' : ""}</div>
    <div class="grid2" style="grid-template-columns: minmax(240px, 320px) 1fr; margin-top:12px">
      <div class="panel versions" id="versions">${list}</div>
      <div><div class="panel"><div class="flex"><b>v${sel.version}</b><span class="muted">parent ${sel.parent ?? "none"} · step ${sel.step}</span>
        ${sel.summary ? `<span>${esc(sel.summary)}</span>` : ""}</div><div class="difftext" style="border:0;padding:0">${diff}</div></div>
        <h2>Full Model v${sel.version}</h2><pre>${esc(JSON.stringify(sel.model, null, 2))}</pre></div>
    </div>
    ${failed || churnChart ? `<div class="grid2">${failed}${churnChart}</div>` : ""}`;
  for (const row of el.querySelectorAll(".row[data-v]")) {
    row.onclick = () => ctx.go(`#/game/${encodeURIComponent(g.id)}/model/${row.dataset.v}`);
  }
  el.querySelector("#goalonly").onchange = (e) => { ui.goalOnly = e.target.checked; ctx.rerender(); };
  const box = el.querySelector("#versions"), row = box.querySelector(".row.sel");
  if (row) box.scrollTop = row.offsetTop - box.clientHeight / 3;
}
