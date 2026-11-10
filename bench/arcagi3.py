#!/usr/bin/env -S uv run python
"""Benchmark: play ARC-AGI-3 games, write a run folder.

Commands: run (default), view, list, schema.
"""

from __future__ import annotations

import argparse
import json
import signal
import sys
import threading
from collections.abc import Callable
from pathlib import Path
from types import FrameType
from typing import IO, Any

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv

from avocode.config import Settings
from avocode.core.events import all_schemas
from avocode.llm.factory import make_client
from avocode.ports import LLMClient, Role
from avocode.session import GameResult
from bench.games import filter_games
from bench.runner import Runner, RunSummary

COMMANDS = ("run", "view", "list", "schema")


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    load_dotenv(ROOT / ".env")
    command = argv.pop(0) if argv and argv[0] in COMMANDS else "run"
    handlers: dict[str, Callable[[list[str]], int]] = {
        "run": cmd_run, "view": cmd_view, "list": cmd_list, "schema": cmd_schema,
    }
    return handlers[command](argv)


# run


def run_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="arcagi3.py", description="Play ARC-AGI-3 games.")
    p.add_argument("--games", default=None, help="comma-separated game ids or prefixes")
    p.add_argument("--workers", type=int, default=None)
    p.add_argument("--max-actions", type=int, default=None)
    p.add_argument("--max-rounds", type=int, default=None)
    p.add_argument("--llm", default=None, choices=["anthropic", "openai", "openrouter"])
    p.add_argument("--player-model", default=None)
    p.add_argument("--scorer-model", default=None)
    p.add_argument("--player-effort", default=None, help="reasoning effort, OpenAI and OpenRouter")
    p.add_argument("--scorer-effort", default=None,
                   help="reasoning effort, OpenAI and OpenRouter")
    p.add_argument("--no-carry-rules", dest="carry_rules", action="store_false", default=None,
                   help="do not pass rules between games")
    p.add_argument("--out", default=None, help="parent folder for run folders")
    p.add_argument("--tag", action="append", default=[], help="run label, can repeat")
    p.add_argument("--serve", action="store_true", help="start the viewer")
    p.add_argument("--port", type=int, default=8765)
    return p


def make_llm_factory(settings: Settings) -> Callable[[Role], LLMClient]:
    clients = {
        "player": make_client(settings.llm, settings.player_effort),
        "scorer": make_client(settings.llm, settings.scorer_effort),
    }
    return lambda role: clients[role]


def cmd_run(argv: list[str]) -> int:
    args = run_parser().parse_args(argv)
    settings = Settings.load(
        llm=args.llm, player_model=args.player_model, scorer_model=args.scorer_model,
        player_effort=args.player_effort, scorer_effort=args.scorer_effort,
        max_actions=args.max_actions, max_rounds=args.max_rounds, workers=args.workers,
        runs_dir=args.out, tags=args.tag, carry_rules=args.carry_rules,
    )
    from avocode.engine.arc import ArcArcade

    arcade = ArcArcade()
    games = filter_games(arcade.list_games(), args.games)
    if not games:
        print(f"No games match: {args.games or 'all'}", file=sys.stderr)
        return 2
    stop = threading.Event()
    runner = Runner(settings, arcade.make_engine, make_llm_factory(settings),
                    argv=argv, stop=stop)
    card = arcade.open_scorecard(["avocode", *settings.tags])
    log = runner.start(games, scorecard=card)
    out = Tee(log.dir / "stdout.log")
    runner.on_game_end = lambda r: out.say(game_line(r))
    out.say(f"run {runner.run_id}: {len(games)} games, scorecard {card}")
    out.say(f"folder {log.dir}")
    if args.serve:
        url = start_viewer(Path(settings.runs_dir), args.port, runner.run_id)
        out.say(f"viewer {url}")
    install_stop(stop, out)
    try:
        summary = runner.run(games)
    finally:
        try:
            scorecard = arcade.close_scorecard()
            if scorecard is not None:
                out.say(f"scorecard {card} closed")
        except Exception as exc:  # noqa: BLE001 - report and go on
            out.say(f"Could not close scorecard: {exc}")
    out.say(summary_table(summary))
    out.close()
    return 0 if summary.outcome == "done" else 130


def install_stop(stop: threading.Event, out: Tee) -> None:
    """First Ctrl+C stops new steps. Second exits."""

    def handle(signum: int, frame: FrameType | None) -> None:
        if stop.is_set():
            raise KeyboardInterrupt
        stop.set()
        out.say("Stopping after current steps. Press Ctrl+C again to quit.")

    signal.signal(signal.SIGINT, handle)


class Tee:
    """Print to stdout and stdout.log."""

    def __init__(self, path: Path) -> None:
        self._file: IO[str] = path.open("a", encoding="utf-8")
        self._lock = threading.Lock()

    def say(self, text: str) -> None:
        with self._lock:
            print(text, flush=True)
            self._file.write(text + "\n")
            self._file.flush()

    def close(self) -> None:
        self._file.close()


def game_line(r: GameResult) -> str:
    return (f"{r.game}: {r.outcome.value}, levels {r.levels_completed}/{r.win_levels}, "
            f"{r.steps} steps, {r.rounds} rounds, {money(r.cost_usd)}")


def money(cost: float | None) -> str:
    return "$?" if cost is None else f"${cost:.2f}"


def summary_table(summary: RunSummary) -> str:
    rows = [["game", "outcome", "levels", "steps", "rounds", "cost"]]
    for r in summary.results:
        rows.append([r.game, r.outcome.value, f"{r.levels_completed}/{r.win_levels}",
                     str(r.steps), str(r.rounds), money(r.cost_usd)])
    won = sum(r.outcome.value == "won" for r in summary.results)
    levels = sum(r.levels_completed for r in summary.results)
    total = sum(r.win_levels for r in summary.results)
    rows.append(["total", f"{won} won", f"{levels}/{total}",
                 str(sum(r.steps for r in summary.results)),
                 str(sum(r.rounds for r in summary.results)), money(summary.cost_usd)])
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
    lines = ["  ".join(cell.ljust(w) for cell, w in zip(row, widths, strict=True))
             for row in rows]
    lines.insert(1, "  ".join("-" * w for w in widths))
    lines.insert(-1, lines[1])
    return "\n".join(lines)


# view, list, schema


def start_viewer(runs_dir: Path, port: int, run_id: str | None = None) -> str:
    from bench.viewer.server import serve_in_thread

    return serve_in_thread(runs_dir, port, run_id)


def cmd_view(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="arcagi3.py view", description="Open the run viewer.")
    p.add_argument("run", nargs="?", default=None, help="run folder (default runs/latest)")
    p.add_argument("--port", type=int, default=8765)
    args = p.parse_args(argv)
    from bench.viewer.server import serve_forever

    run_path = Path(args.run) if args.run else Path(Settings.load().runs_dir) / "latest"
    if not run_path.exists():
        print(f"Run folder not found: {run_path}", file=sys.stderr)
        return 2
    run_path = run_path.resolve() if run_path.is_symlink() else run_path
    serve_forever(run_path.parent, args.port, run_path.name)
    return 0


def cmd_list(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="arcagi3.py list", description="List past runs.")
    p.add_argument("--out", default=None)
    args = p.parse_args(argv)
    runs_dir = Path(args.out or Settings.load().runs_dir)
    rows = [["run", "games", "won", "levels", "steps", "steps/lvl", "cost", "prompts", "tags"]]
    for manifest in sorted(runs_dir.glob("*/manifest.json")):
        if manifest.parent.is_symlink():
            continue
        data: dict[str, Any] = json.loads(manifest.read_text())
        s = data.get("summary") or {}
        status = "" if data.get("ended") else " (live or crashed)"
        rows.append([data["run_id"] + status, str(len(data.get("games", []))),
                     str(s.get("games_won", "-")),
                     f"{s.get('levels_total', '-')}/{s.get('win_levels_total', '-')}",
                     str(s.get("steps", "-")), steps_per_level(manifest.parent),
                     money(s.get("cost_usd")) if s else "-", prompt_hashes(data),
                     ",".join(data.get("tags", []))])
    if len(rows) == 1:
        print(f"No runs in {runs_dir}")
        return 0
    widths = [max(len(r[i]) for r in rows) for i in range(len(rows[0]))]
    for row in rows:
        print("  ".join(c.ljust(w) for c, w in zip(row, widths, strict=True)).rstrip())
    return 0


def steps_per_level(run_dir: Path) -> str:
    """Mean steps per completed level."""
    steps = []
    for events in run_dir.glob("games/*/events.jsonl"):
        for line in events.read_text().splitlines():
            if '"level_complete"' in line:
                steps.append(json.loads(line)["steps_in_level"])
    return f"{sum(steps) / len(steps):.0f}" if steps else "-"


def prompt_hashes(manifest: dict[str, Any]) -> str:
    """Player and Scorer hashes, short."""
    p = manifest.get("prompts") or {}
    return f"{p.get('player', '?')[:6]}/{p.get('scorer', '?')[:6]}"


def cmd_schema(argv: list[str]) -> int:
    print(json.dumps(all_schemas(), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
