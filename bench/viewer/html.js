// Small text helpers.

export function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function money(v) {
  if (v === null || v === undefined) return "$?";
  if (v === 0) return "$0";
  if (v < 0.0001) return "<$0.0001";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(v < 1 ? 3 : 2)}`;
}

export function pct(v) {
  return v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`;
}

export function secs(ms) {
  if (ms === null || ms === undefined) return "—";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function age(s) {
  if (s === null || s === undefined) return "—";
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} m`;
  return `${(s / 3600).toFixed(1)} h`;
}

export function duration(s) {
  if (s === null || s === undefined) return "—";
  const t = Math.round(s);
  const m = Math.floor(t / 60);
  return m ? `${m}m ${t % 60}s` : `${t}s`;
}

export function shortAction(a) {
  if (!a) return "";
  if (a.name === "RESET") return "RESET";
  const n = "A" + a.name.slice(-1);
  return a.x !== null && a.x !== undefined ? `${n}@${a.x},${a.y}` : n;
}

/** Tooltip text for one step cell. */
export function stepTip(s, words = []) {
  const parts = [`${s.step}: ${shortAction(s.action)}`, `diff ${s.diff.cells}`];
  if (s.after.levels_completed > s.before.levels_completed) parts.push("level complete");
  if (words.length) parts.push(words.join(", "));
  return parts.join(" · ") + (s.reason ? `\n${s.reason}` : "");
}

export function tokens(n) {
  if (n === null || n === undefined) return "—";
  if (n < 1000) return String(n);
  return n < 1e6 ? `${(n / 1e3).toFixed(1)}k` : `${(n / 1e6).toFixed(2)}M`;
}

export function tile(k, v) {
  return `<div class="tile"><div class="v">${v}</div><div class="k">${esc(k)}</div></div>`;
}
