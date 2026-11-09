// Routes, polling, and screens.
import { RunStore, safeName } from "./store.js";
import { Tail } from "./tail.js";
import { esc } from "./html.js";
import * as runView from "./views/run.js";
import * as gameView from "./views/game.js";
import * as roundView from "./views/round.js";
import * as modelView from "./views/model.js";
import * as llmView from "./views/llm.js";

const POLL_MS = 2000;
const app = document.getElementById("app");
const crumbs = document.getElementById("crumbs");
const status = document.getElementById("status");

/** A side file loaded on demand, keyed. */
class LineFile {
  constructor(url, keyOf) {
    this.tail = new Tail(url);
    this.keyOf = keyOf;
    this.map = new Map();
    this.loaded = false;
    this.pending = null;
  }

  async refresh() {
    if (this.pending) return this.pending;
    this.pending = this.tail.poll().then((rows) => {
      for (const r of rows) this.map.set(this.keyOf(r), r);
      this.loaded = true;
      this.pending = null;
      return rows.length;
    }).catch((err) => { this.pending = null; throw err; });
    return this.pending;
  }

  get(key) { return this.map.get(key); }
}

const ctx = {
  runId: null,
  run: null,
  manifest: null,
  tails: new Map(),
  side: new Map(),
  error: null,
  now: () => Date.now(),
  base() { return `/runs/${encodeURIComponent(this.runId)}`; },
  gameUrl(game, file) { return `${this.base()}/games/${encodeURIComponent(safeName(game))}/${file}`; },
  /** frames.jsonl or llm.jsonl, keyed. */
  sideFile(game, file) {
    const key = `${game}/${file}`;
    if (!this.side.has(key)) {
      const keyOf = file === "frames.jsonl" ? (r) => r.step : (r) => r.call_id;
      this.side.set(key, new LineFile(this.gameUrl(game, file), keyOf));
    }
    return this.side.get(key);
  },
  async need(game, file) {
    const f = this.sideFile(game, file);
    if (!f.loaded) { await f.refresh(); }
    return f;
  },
  go(hash) { if (location.hash !== hash) location.hash = hash; else render(true); },
  rerender: () => render(true),
};

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const route = { view: "run", parts };
  if (parts[0] === "game" && parts[1]) {
    route.game = parts[1];
    route.view = "game";
    if (parts[2] === "round") {
      route.view = "round";
      route.round = Number(parts[3]);
      if (parts[4] === "step") route.step = Number(parts[5]);
    } else if (parts[2] === "model") {
      route.view = "model";
      route.version = parts[3] !== undefined ? Number(parts[3]) : null;
    } else if (parts[2] === "llm") {
      route.view = "llm";
      route.callId = parts[3];
    }
  }
  return route;
}

const VIEWS = { run: runView, game: gameView, round: roundView, model: modelView, llm: llmView };
let lastKey = "";
let current = null;

function renderCrumbs(route, game) {
  const parts = [`<a href="#/"><b>avocode</b></a>`, `<span class="mono">${esc(ctx.runId ?? "")}</span>`];
  if (game) parts.push(`<a href="#/game/${encodeURIComponent(game.id)}">${esc(game.id)}</a>`);
  if (route.view === "round") parts.push(`round ${route.round}`);
  if (route.view === "model") parts.push("Model");
  if (route.view === "llm") parts.push(`call ${esc(route.callId)}`);
  crumbs.innerHTML = parts.join(" › ");
}

async function render(force = false) {
  if (!ctx.run) return;
  const route = parseRoute();
  const view = VIEWS[route.view];
  const game = route.game ? ctx.run.findGame(route.game) : null;
  const bad = ctx.run.badVersion ?? game?.badVersion;
  if (bad !== null && bad !== undefined) {
    app.innerHTML = `<div class="banner">Unknown schema version ${esc(bad)}. This viewer reads version 1.</div>`;
    return;
  }
  const changed = game ? game.changed : [...ctx.run.games.values()].reduce((a, g) => a + g.changed, 0);
  const key = `${location.hash}|${changed}|${ctx.run.runEvents.length}`;
  const live = view.liveRefresh?.(route) ?? false;
  if (!force && key === lastKey && !live) return;
  lastKey = key;
  renderCrumbs(route, game);
  if (route.game && !game) {
    app.innerHTML = `<p>No game ${esc(route.game)} in this run.</p>`;
    return;
  }
  if (current && current !== view) current.leave?.();
  current = view;
  try {
    await view.render(ctx, route, app, game);
  } catch (err) {
    console.error(err);
    app.innerHTML = `<div class="banner">Could not draw this screen: ${esc(err.message)}</div>`;
  }
}

async function poll() {
  try {
    const runTail = ctx.tails.get("run");
    ctx.run.addRun(await runTail.poll());
    for (const id of ctx.run.games.keys()) {
      if (!ctx.tails.has(id)) ctx.tails.set(id, new Tail(ctx.gameUrl(id, "events.jsonl")));
      ctx.run.games.get(id).add(await ctx.tails.get(id).poll());
    }
    if (!ctx.manifest?.ended) {
      const resp = await fetch(`${ctx.base()}/manifest.json`, { cache: "no-store" });
      if (resp.ok) ctx.manifest = await resp.json();
    }
    // Refresh loaded side files on live runs.
    if (!ctx.run.end) for (const f of ctx.side.values()) if (f.loaded) await f.refresh();
    status.textContent = ctx.run.end ? "finished" : "● live";
    ctx.error = null;
  } catch (err) {
    ctx.error = err;
    status.textContent = `poll failed: ${err.message}`;
  }
  await render();
}

async function pickRun(config) {
  const params = new URLSearchParams(location.search);
  return params.get("run") || config.run || config.runs[0] || null;
}

async function main() {
  const config = await (await fetch("/api/config", { cache: "no-store" })).json();
  ctx.runId = await pickRun(config);
  if (!ctx.runId) {
    app.innerHTML = "<p>No runs found.</p>";
    return;
  }
  if (config.runs.length > 1) {
    const opts = config.runs.map((r) => `<option ${r === ctx.runId ? "selected" : ""}>${esc(r)}</option>`).join("");
    status.insertAdjacentHTML("beforebegin", `<select id="runpick" class="mono">${opts}</select>`);
    document.getElementById("runpick").onchange = (e) => {
      location.href = `/?run=${encodeURIComponent(e.target.value)}`;
    };
  }
  ctx.run = new RunStore(ctx.runId);
  ctx.tails.set("run", new Tail(`${ctx.base()}/run.jsonl`));
  window.addEventListener("hashchange", () => render(true));
  window.addEventListener("keydown", (e) => {
    if (e.target.matches?.("input, textarea, select")) return;
    current?.onKey?.(e, ctx);
  });
  await poll();
  setInterval(poll, POLL_MS);
}

main().catch((err) => {
  app.innerHTML = `<div class="banner">Viewer failed to start: ${esc(err.message)}</div>`;
});
