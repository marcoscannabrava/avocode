// Line and word diffs. Pure functions.

/** LCS diff of two token lists. */
export function diffTokens(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre
    && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const x = a.slice(pre, a.length - suf), y = b.slice(pre, b.length - suf);
  const out = a.slice(0, pre).map((text) => ({ op: "same", text }));
  if (x.length * y.length > 4e6) {
    for (const text of x) out.push({ op: "del", text });
    for (const text of y) out.push({ op: "add", text });
  } else {
    out.push(...lcs(x, y));
  }
  for (const text of a.slice(a.length - suf)) out.push({ op: "same", text });
  return out;
}

function lcs(a, b) {
  const n = a.length, m = b.length, w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1
        : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: "same", text: a[i] }); i++; j++; }
    else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) out.push({ op: "del", text: a[i++] });
    else out.push({ op: "add", text: b[j++] });
  }
  while (i < n) out.push({ op: "del", text: a[i++] });
  while (j < m) out.push({ op: "add", text: b[j++] });
  return out;
}

/** Diff two texts line by line. */
export function diffLines(a, b) {
  return diffTokens(String(a ?? "").split("\n"), String(b ?? "").split("\n"));
}

/** Diff two lines word by word. */
export function diffWords(a, b) {
  const split = (s) => String(s ?? "").split(/(\s+|[,;:()=])/).filter((t) => t !== "");
  return diffTokens(split(a), split(b));
}

/** Fold long same runs. Keep context lines. */
export function foldSame(ops, keep = 2) {
  const out = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].op !== "same") { out.push(ops[i++]); continue; }
    let j = i;
    while (j < ops.length && ops[j].op === "same") j++;
    const head = i === 0 ? 0 : keep, tail = j === ops.length ? 0 : keep;
    if (j - i > head + tail + 1) {
      out.push(...ops.slice(i, i + head));
      out.push({ op: "fold", count: j - i - head - tail, lines: ops.slice(i + head, j - tail).map((o) => o.text) });
      out.push(...ops.slice(j - tail, j));
    } else {
      out.push(...ops.slice(i, j));
    }
    i = j;
  }
  return out;
}

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Word marks for one line pair. */
export function wordPairHtml(a, b) {
  const ops = diffWords(a, b);
  const side = (keep) => ops.filter((o) => o.op === "same" || o.op === keep)
    .map((o) => (o.op === "same" ? esc(o.text) : `<mark>${esc(o.text)}</mark>`)).join("");
  return { del: side("del"), add: side("add") };
}

/** HTML for diff ops, with word marks. */
export function diffHtml(ops, { prefix = true } = {}) {
  const out = [];
  const line = (cls, sign, html) => out.push(`<div class="diff-line ${cls}">${prefix ? sign : ""}${html}</div>`);
  let i = 0;
  while (i < ops.length) {
    const o = ops[i];
    if (o.op === "same") { line("diff-same", "  ", esc(o.text)); i++; continue; }
    if (o.op === "fold") {
      out.push(`<details class="fold"><summary>${o.count} same lines</summary><div class="diff-same">${o.lines.map(esc).join("\n")}</div></details>`);
      i++;
      continue;
    }
    const dels = [], adds = [];
    while (i < ops.length && ops[i].op === "del") dels.push(ops[i++].text);
    while (i < ops.length && ops[i].op === "add") adds.push(ops[i++].text);
    const pairs = dels.length === adds.length;
    dels.forEach((t, k) => line("diff-del", "− ", pairs ? wordPairHtml(t, adds[k]).del : esc(t)));
    adds.forEach((t, k) => line("diff-add", "+ ", pairs ? wordPairHtml(dels[k], t).add : esc(t)));
  }
  return out.join("");
}

const objId = (k) => /obj#(\d+)/.exec(k)?.[1] ?? null;
const show = (v) => (typeof v === "string" ? v : JSON.stringify(v));

/** Diff ops for two maps. Pair keys by obj#N. */
export function keyedDiffOps(a = {}, b = {}) {
  const ops = [];
  const pair = (ka, kb) => {
    const ta = `${ka}: ${show(a[ka])}`, tb = `${kb}: ${show(b[kb])}`;
    if (ta !== tb) ops.push({ op: "del", text: ta }, { op: "add", text: tb });
  };
  const gone = Object.keys(a).filter((k) => !(k in b));
  const fresh = Object.keys(b).filter((k) => !(k in a));
  for (const k of Object.keys(b)) if (k in a) pair(k, k);
  const used = new Set();
  for (const ka of gone) {
    const id = objId(ka);
    const kb = id === null ? null : fresh.find((k) => !used.has(k) && objId(k) === id);
    if (kb) { used.add(kb); pair(ka, kb); } else ops.push({ op: "del", text: `${ka}: ${show(a[ka])}` });
  }
  for (const kb of fresh) if (!used.has(kb)) ops.push({ op: "add", text: `${kb}: ${show(b[kb])}` });
  return ops;
}
