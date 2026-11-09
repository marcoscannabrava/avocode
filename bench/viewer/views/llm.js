// One LLM call: prompt, reply, parsed.
import { esc, money, secs } from "../html.js";

const ui = { tab: "user" };

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
  const tabs = { system: rec.system, user: rec.user, reply: rec.reply,
    parsed: rec.parsed ? JSON.stringify(rec.parsed, null, 2) : "(none)" };
  const stepLink = g.byStep.has(rec.step)
    ? `<a href="#/game/${encodeURIComponent(g.id)}/round/${rec.round}/step/${rec.step}">step ${rec.step}</a>` : `step ${rec.step}`;
  el.innerHTML = `<div class="flex"><h1 class="mono">${esc(rec.call_id)}</h1><span>${esc(rec.role)}</span>${stepLink}
      <button id="copy">Copy as JSON</button></div>
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
    <div class="tabs">${Object.keys(tabs).map((t) => `<button data-tab="${t}" class="${t === ui.tab ? "on" : ""}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</div>
    <pre>${esc(tabs[ui.tab])}</pre>`;
  for (const b of el.querySelectorAll("button[data-tab]")) {
    b.onclick = () => { ui.tab = b.dataset.tab; ctx.rerender(); };
  }
  el.querySelector("#copy").onclick = async () => {
    await navigator.clipboard.writeText(JSON.stringify(rec, null, 2));
    el.querySelector("#copy").textContent = "Copied";
  };
}
