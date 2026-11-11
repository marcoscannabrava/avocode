// Draw grids on a canvas.
import { ARC_COLORS } from "./palette.js";

/** Parse one hex frame string. */
export function cellsOf(hex) {
  const out = new Uint8Array(hex.length);
  for (let i = 0; i < hex.length; i++) out[i] = parseInt(hex[i], 16);
  return out;
}

/** Cell count per color, most first. */
export function colorCounts(frame) {
  const n = new Map();
  for (const c of cellsOf(frame.hex)) n.set(c, (n.get(c) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]);
}

/** Draw a frame, with diff and click marks. */
export function drawGrid(canvas, frame, opts = {}) {
  const { w, h } = frame;
  const size = opts.size ?? 512;
  const cell = Math.max(1, Math.floor(size / Math.max(w, h, 1)));
  canvas.width = w * cell;
  canvas.height = h * cell;
  const ctx = canvas.getContext("2d");
  const cells = cellsOf(frame.hex);
  for (let i = 0; i < cells.length; i++) {
    ctx.fillStyle = ARC_COLORS[cells[i]] ?? "#000";
    ctx.fillRect((i % w) * cell, Math.floor(i / w) * cell, cell, cell);
  }
  if (opts.fade) {
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  if (opts.prev && opts.prev.w === w && opts.prev.h === h) {
    const old = cellsOf(opts.prev.hex);
    ctx.lineWidth = Math.max(1, cell / 6);
    for (let i = 0; i < cells.length; i++) {
      if (old[i] === cells[i]) continue;
      const x = (i % w) * cell, y = Math.floor(i / w) * cell;
      ctx.strokeStyle = "#000";
      ctx.strokeRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
      ctx.strokeStyle = "#fff";
      ctx.strokeRect(x + ctx.lineWidth + 0.5, y + ctx.lineWidth + 0.5,
        cell - 2 * ctx.lineWidth - 1, cell - 2 * ctx.lineWidth - 1);
    }
  }
  if (opts.click) {
    const cx = (opts.click.x + 0.5) * cell, cy = (opts.click.y + 0.5) * cell;
    ctx.strokeStyle = "#ff00ff";
    ctx.lineWidth = Math.max(2, cell / 4);
    ctx.beginPath();
    ctx.moveTo(cx - cell * 1.5, cy); ctx.lineTo(cx + cell * 1.5, cy);
    ctx.moveTo(cx, cy - cell * 1.5); ctx.lineTo(cx, cy + cell * 1.5);
    ctx.stroke();
    ctx.strokeRect(opts.click.x * cell, opts.click.y * cell, cell, cell);
  }
  if (opts.heat) drawHeat(ctx, opts.heat, w, cell);
  if (opts.box) drawBox(ctx, opts.box, cell);
  if (opts.labels) drawLabels(ctx, opts.labels, cell);
  return cell;
}

/** Dashed box and name per element. */
function drawLabels(ctx, boxes, cell) {
  ctx.font = "11px system-ui, sans-serif";
  ctx.textBaseline = "top";
  for (const b of boxes) {
    const x = b.x0 * cell, y = b.y0 * cell;
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#ff00ff";
    ctx.strokeRect(x + 0.5, y + 0.5, (b.x1 - b.x0 + 1) * cell - 1, (b.y1 - b.y0 + 1) * cell - 1);
    ctx.setLineDash([]);
    const tw = ctx.measureText(b.name).width + 6;
    const ty = y >= 14 ? y - 14 : y;
    const tx = Math.min(x, ctx.canvas.width - tw);
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(tx, ty, tw, 14);
    ctx.fillStyle = "#fff";
    ctx.fillText(b.name, tx + 3, ty + 1);
  }
}

function drawHeat(ctx, counts, w, cell) {
  let max = 0;
  for (const n of counts.values()) max = Math.max(max, n);
  if (!max) return;
  for (const [i, n] of counts) {
    ctx.fillStyle = `rgba(220, 38, 38, ${0.15 + 0.75 * (n / max)})`;
    ctx.fillRect((i % w) * cell, Math.floor(i / w) * cell, cell, cell);
  }
}

function drawBox(ctx, b, cell) {
  const x = b.x0 * cell, y = b.y0 * cell;
  const w = (b.x1 - b.x0 + 1) * cell, h = (b.y1 - b.y0 + 1) * cell;
  ctx.lineWidth = Math.max(2, cell / 3);
  ctx.strokeStyle = "#ff00ff";
  ctx.strokeRect(x - ctx.lineWidth / 2, y - ctx.lineWidth / 2, w + ctx.lineWidth, h + ctx.lineWidth);
}
