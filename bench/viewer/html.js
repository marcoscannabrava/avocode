// Small text helpers.

export function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function money(v) {
  return v === null || v === undefined ? "$?" : `$${v.toFixed(v < 1 ? 3 : 2)}`;
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
  const m = Math.floor(s / 60);
  return m ? `${m}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`;
}

export function shortAction(a) {
  if (!a) return "";
  if (a.name === "RESET") return "RESET";
  const n = "A" + a.name.slice(-1);
  return a.x !== null && a.x !== undefined ? `${n}@${a.x},${a.y}` : n;
}

export function tokens(n) {
  if (n === null || n === undefined) return "—";
  if (n < 1000) return String(n);
  return n < 1e6 ? `${(n / 1e3).toFixed(1)}k` : `${(n / 1e6).toFixed(2)}M`;
}

export function tile(k, v) {
  return `<div class="tile"><div class="v">${v}</div><div class="k">${esc(k)}</div></div>`;
}
