// Small SVG charts. Return SVG strings.
import { esc } from "./html.js";

const PAD = { l: 36, r: 10, t: 10, b: 24 };

function scale(d0, d1, r0, r1) {
  const span = d1 - d0 || 1;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** Round tick values: 1, 2, 5 × 10^k. */
export function ticks(max, count = 5) {
  if (max <= 0) return [0];
  const raw = Math.max(1, max / count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * mag).find((v) => v >= raw);
  const out = [];
  for (let v = 0; v <= max; v += step) out.push(v);
  return out;
}

function axes(x, y, xMax, yMax, W, H, yInt = true) {
  let s = `<line class="axis" x1="${PAD.l}" y1="${H - PAD.b}" x2="${W - PAD.r}" y2="${H - PAD.b}"/>`;
  s += `<line class="axis" x1="${PAD.l}" y1="${PAD.t}" x2="${PAD.l}" y2="${H - PAD.b}"/>`;
  for (const t of ticks(xMax, 8)) s += `<text x="${x(t)}" y="${H - 8}" text-anchor="middle">${t}</text>`;
  const yt = yInt ? ticks(yMax, 4) : [0, yMax / 2, yMax];
  for (const t of yt) {
    const label = yInt ? t : Math.round(t);
    s += `<text x="${PAD.l - 5}" y="${y(t) + 4}" text-anchor="end">${label}</text>`;
  }
  return s;
}

const LANE = 14;

/** Step lines, bands, and mark lanes. */
export function stepLine({ series, bands = [], lanes = [], xMax, yMax, width = 700, height = 200 }) {
  const W = width, H = height, full = H + lanes.length * LANE;
  const xm = Math.max(1, xMax), ym = Math.max(1, yMax);
  const x = scale(0, xm, PAD.l, W - PAD.r), y = scale(0, ym, H - PAD.b, PAD.t);
  let s = `<svg viewBox="0 0 ${W} ${full}" width="100%" role="img" style="overflow:visible">`;
  for (const b of bands) {
    const rect = `<rect class="fill-${b.cls}" opacity="0.13" x="${x(b.x0)}" y="${PAD.t}" width="${Math.max(1, x(b.x1) - x(b.x0))}" height="${H - PAD.b - PAD.t}"><title>${esc(b.title)}</title></rect>`;
    s += b.href ? `<a href="${b.href}">${rect}</a>` : rect;
  }
  s += axes(x, y, xm, ym, W, H);
  for (const ser of series) {
    let d = "";
    let prevY = null;
    for (const [px, py] of ser.pts) {
      d += d ? ` H${x(px)} V${y(py)}` : `M${x(px)} ${y(py)}`;
      prevY = py;
    }
    if (ser.pts.length && prevY !== null && ser.xEnd) d += ` H${x(ser.xEnd)}`;
    s += `<path d="${d}" fill="none" stroke="${ser.color}" stroke-width="2"><title>${esc(ser.name)}</title></path>`;
  }
  const w = Math.max(2, (x(1) - x(0)) * 0.8);
  lanes.forEach((lane, i) => {
    const ly = H + i * LANE;
    s += `<text x="${PAD.l - 5}" y="${ly + 9}" text-anchor="end">${esc(lane.label)}</text>`;
    s += `<line class="axis" x1="${PAD.l}" y1="${ly + 5}" x2="${W - PAD.r}" y2="${ly + 5}"/>`;
    for (const it of lane.items) {
      const r = `<rect class="fill-${it.cls}" x="${x(it.x) - w / 2}" y="${ly}" width="${w}" height="10"><title>${esc(it.title)}</title></rect>`;
      s += it.href ? `<a href="${it.href}">${r}</a>` : r;
    }
  });
  return s + "</svg>";
}

/** Horizontal stacked bars with part values. */
export function stackedBars(rows, { width = 700, fmt = (v) => v.toFixed(2) } = {}) {
  const rowH = 22, W = width, H = rows.length * rowH + 8;
  const max = Math.max(1e-9, ...rows.map((r) => r.parts.reduce((a, p) => a + (p.value || 0), 0)));
  const x = scale(0, max, 110, W - 230);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">`;
  rows.forEach((r, i) => {
    const yy = 4 + i * rowH;
    s += `<text x="104" y="${yy + 14}" text-anchor="end">${esc(r.label)}</text>`;
    let at = 0;
    for (const p of r.parts) {
      const v = p.value || 0;
      s += `<rect class="fill-${p.cls}" x="${x(at)}" y="${yy + 3}" width="${Math.max(0, x(at + v) - x(at))}" height="${rowH - 8}"><title>${esc(p.name ?? p.cls)}: ${esc(fmt(v))}</title></rect>`;
      at += v;
    }
    const parts = r.parts.map((p) => `${esc(p.name ?? p.cls)} ${esc(fmt(p.value || 0))}`).join(" · ");
    s += `<text x="${x(at) + 5}" y="${yy + 14}"><tspan font-weight="600">${esc(fmt(at))}</tspan> (${parts})</text>`;
  });
  return s + "</svg>";
}

/** Scatter plot. */
export function scatter(points, { xMax, yMax, width = 700, height = 200, yLabel = "" } = {}) {
  const W = width, H = height;
  const xm = Math.max(1, xMax ?? Math.max(0, ...points.map((p) => p.x)));
  const ym = Math.max(1, yMax ?? Math.max(0, ...points.map((p) => p.y)));
  const x = scale(0, xm, PAD.l, W - PAD.r), y = scale(0, ym, H - PAD.b, PAD.t);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">` + axes(x, y, xm, ym, W, H, false);
  if (yLabel) s += `<text x="${PAD.l + 4}" y="${PAD.t + 10}">${esc(yLabel)}</text>`;
  for (const p of points) {
    const dot = `<circle class="fill-${p.cls}" cx="${x(p.x)}" cy="${y(p.y)}" r="3.5" opacity="0.8"><title>${esc(p.title)}</title></circle>`;
    s += p.href ? `<a href="${p.href}">${dot}</a>` : dot;
  }
  return s + "</svg>";
}

/** Vertical bars. */
export function bars(rows, { width = 700, height = 160, cls = "player" } = {}) {
  const W = width, H = height;
  const max = Math.max(1, ...rows.map((r) => r.value));
  const n = Math.max(1, rows.length);
  const bw = (W - PAD.l - PAD.r) / n;
  const y = scale(0, max, H - PAD.b, PAD.t);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">`;
  s += `<line class="axis" x1="${PAD.l}" y1="${H - PAD.b}" x2="${W - PAD.r}" y2="${H - PAD.b}"/>`;
  for (const t of ticks(max, 4)) s += `<text x="${PAD.l - 5}" y="${y(t) + 4}" text-anchor="end">${t}</text>`;
  rows.forEach((r, i) => {
    const bx = PAD.l + i * bw + bw * 0.15;
    s += `<rect class="fill-${r.cls || cls}" x="${bx}" y="${y(r.value)}" width="${bw * 0.7}" height="${H - PAD.b - y(r.value)}"><title>${esc(r.label)}: ${r.value}</title></rect>`;
    if (n <= 40) s += `<text x="${bx + bw * 0.35}" y="${H - 8}" text-anchor="middle">${esc(r.label)}</text>`;
  });
  return s + "</svg>";
}
