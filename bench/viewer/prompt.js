// Read structure from prompt text. Pure.

const HEADS = [
  [/^Old Model \(version \d+\):/, "Old Model"],
  [/^Model \(version \d+\):/, "Model"],
  [/^Failed rounds:/, "Failed rounds"],
  [/^Round \d+, step/, "Round"],
  [/^Current State:/, "Current State"],
  [/^New State:/, "New State"],
  [/^history:/, "history"],
  [/^around /, "around"],
  [/^Changes from the previous State:/, "Changes"],
  [/^(Pick the next action|Return the updated Model)/, "Task"],
];

/** Heading name of a line, or null. */
export function headingOf(line) {
  for (const [re, name] of HEADS) if (re.test(line)) return name;
  return null;
}

/** Split text into named sections. */
export function promptSections(text) {
  const out = [{ name: "start", lines: [] }];
  for (const line of String(text ?? "").split("\n")) {
    const name = headingOf(line);
    if (name) out.push({ name, lines: [line] });
    else out[out.length - 1].lines.push(line);
  }
  if (!out[0].lines.length) out.shift();
  return out;
}

/** Object box from one prompt line. */
export function objBox(line) {
  const m = /obj#(\d+)\b.*?\bx=(\d+)(?:\.\.(\d+))? y=(\d+)(?:\.\.(\d+))?/.exec(line);
  if (!m) return null;
  const x0 = Number(m[2]), y0 = Number(m[4]);
  return { id: Number(m[1]), x0, x1: m[3] ? Number(m[3]) : x0, y0, y1: m[5] ? Number(m[5]) : y0 };
}
