// Read growing JSONL files by byte offset.

/** Split decoded text into full lines. Keep the rest. */
export function splitLines(partial, text) {
  const all = partial + text;
  const end = all.lastIndexOf("\n");
  if (end < 0) return { lines: [], partial: all };
  const lines = all.slice(0, end).split("\n").filter((l) => l.trim() !== "");
  return { lines, partial: all.slice(end + 1) };
}

/** Tail one JSONL file over HTTP Range. */
export class Tail {
  constructor(url, fetchFn = (...a) => fetch(...a)) {
    this.url = url;
    this.fetch = fetchFn;
    this.offset = 0;
    this.partial = "";
    this.decoder = new TextDecoder();
    this.missing = false;
  }

  /** Return new parsed objects since last poll. */
  async poll() {
    const headers = this.offset > 0 ? { Range: `bytes=${this.offset}-` } : {};
    const resp = await this.fetch(this.url, { headers, cache: "no-store" });
    if (resp.status === 416) return [];
    if (resp.status === 404) { this.missing = true; return []; }
    if (!resp.ok) throw new Error(`${this.url}: HTTP ${resp.status}`);
    this.missing = false;
    if (this.offset > 0 && resp.status === 200) {
      // Server ignored Range. Start again.
      this.offset = 0;
      this.partial = "";
      this.decoder = new TextDecoder();
    }
    const bytes = new Uint8Array(await resp.arrayBuffer());
    this.offset += bytes.length;
    const text = this.decoder.decode(bytes, { stream: true });
    const { lines, partial } = splitLines(this.partial, text);
    this.partial = partial;
    const out = [];
    for (const line of lines) {
      try { out.push(JSON.parse(line)); } catch { /* skip bad line */ }
    }
    return out;
  }
}
