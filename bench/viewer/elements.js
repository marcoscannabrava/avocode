// Model elements with grid boxes.

const XS = /x=(\d+)(?:\.\.(\d+))?/;
const YS = /y=(\d+)(?:\.\.(\d+))?/;

/** Key text without coordinates. */
export function elementName(key) {
  return key
    .replace(/,?\s*(at\s+)?x=\d+(\.\.\d+)?/g, "")
    .replace(/,?\s*y=\d+(\.\.\d+)?/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+(at|and)\s*$/g, "")
    .replace(/[\s,]+$/g, "")
    .trim();
}

/** Elements whose key gives x and y. */
export function elementBoxes(model) {
  const out = [];
  for (const [key, text] of Object.entries(model?.element_breakdown ?? {})) {
    const x = key.match(XS), y = key.match(YS);
    if (!x || !y) continue;
    const x0 = Number(x[1]), y0 = Number(y[1]);
    out.push({
      key, text, name: elementName(key) || key,
      x0, x1: Number(x[2] ?? x[1]), y0, y1: Number(y[2] ?? y[1]),
    });
  }
  return out;
}

/** Elements that hold one cell. */
export function elementsAt(boxes, x, y) {
  return boxes.filter((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
}

/** Model element keys that name a color. */
export function colorElements(model, color) {
  const digit = color.toString(16);
  return Object.keys(model?.element_breakdown ?? {}).filter((key) => {
    const bare = key.replace(/obj#[\d,#.]+/g, "").replace(/[xy]=[\d.]+/g, "");
    return bare.toLowerCase().split(/[^0-9a-z]+/).some((t) => t === digit && !(t === "a" && /\ba\s+[a-z]/i.test(bare)));
  });
}
