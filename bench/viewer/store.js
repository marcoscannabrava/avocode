// Parsed events and indexes.

export const SCHEMA_VERSION = 1;

export function safeName(game) {
  return game.replace(/[^A-Za-z0-9\-_.]/g, "_");
}

/** All events of one game. */
export class GameStore {
  constructor(id) {
    this.id = id;
    this.events = [];
    this.start = null;
    this.end = null;
    this.steps = [];
    this.byStep = new Map();
    this.rounds = new Map();      // round -> {start, end, steps}
    this.models = [];             // model_update events
    this.modelByVersion = new Map();
    this.llmStart = new Map();    // call_id -> event
    this.llmEnd = new Map();
    this.warnings = [];
    this.errors = [];
    this.levels = [];             // level_complete events
    this.lastTs = null;
    this.badVersion = null;
    this.changed = 0;             // bump on each add
  }

  add(events) {
    for (const e of events) this.addOne(e);
    if (events.length) this.changed++;
  }

  addOne(e) {
    if (e.v !== SCHEMA_VERSION) { this.badVersion = e.v; return; }
    this.events.push(e);
    if (e.ts) this.lastTs = e.ts;
    switch (e.type) {
      case "game_start": this.start = e; break;
      case "game_end": this.end = e; break;
      case "round_start":
        this.rounds.set(e.round, { round: e.round, start: e, end: null, steps: [] });
        break;
      case "round_end": {
        const r = this.rounds.get(e.round);
        if (r) r.end = e;
        break;
      }
      case "step": {
        this.steps.push(e);
        this.byStep.set(e.step, e);
        const r = this.rounds.get(e.round);
        if (r) r.steps.push(e);
        break;
      }
      case "model_update":
        this.models.push(e);
        this.modelByVersion.set(e.version, e);
        break;
      case "llm_start": this.llmStart.set(e.call_id, e); break;
      case "llm_end": this.llmEnd.set(e.call_id, e); break;
      case "warning": this.warnings.push(e); break;
      case "error": this.errors.push(e); break;
      case "level_complete": this.levels.push(e); break;
      default: break;
    }
  }

  /** Calls with llm_start and no llm_end. */
  openCalls() {
    return [...this.llmStart.values()].filter((s) => !this.llmEnd.has(s.call_id));
  }

  roundList() {
    return [...this.rounds.values()].sort((a, b) => a.round - b.round);
  }

  /** The Model a step used. */
  modelAt(version) {
    return this.modelByVersion.get(version)?.model ?? null;
  }
}

/** All games of one run. */
export class RunStore {
  constructor(runId) {
    this.runId = runId;
    this.runEvents = [];
    this.start = null;
    this.end = null;
    this.games = new Map();       // id -> GameStore
    this.gameRun = new Map();     // id -> {start, end} from run.jsonl
    this.manifest = null;
    this.badVersion = null;
  }

  addRun(events) {
    for (const e of events) {
      if (e.v !== SCHEMA_VERSION) { this.badVersion = e.v; continue; }
      this.runEvents.push(e);
      if (e.type === "run_start") {
        this.start = e;
        for (const g of e.games) this.game(g);
      } else if (e.type === "run_end") {
        this.end = e;
      } else if (e.game) {
        this.game(e.game);
        const info = this.gameRun.get(e.game);
        if (e.type === "game_start") info.start = e;
        if (e.type === "game_end") info.end = e;
      }
    }
  }

  game(id) {
    if (!this.games.has(id)) {
      this.games.set(id, new GameStore(id));
      this.gameRun.set(id, { start: null, end: null });
    }
    return this.games.get(id);
  }

  /** Find a game by id or prefix. */
  findGame(key) {
    if (this.games.has(key)) return this.games.get(key);
    for (const [id, g] of this.games) if (id.startsWith(key)) return g;
    return null;
  }
}

/** Build stores from file text, for tests. */
export function parseLines(text) {
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}
