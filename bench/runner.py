"""Play games on workers. Write the run folder."""

from __future__ import annotations

import subprocess
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from avocode.budget import Budget
from avocode.config import Settings
from avocode.core.events import GameEnd, GameEndRun, GameStartRun, Manifest, RunEnd, RunStart
from avocode.core.state import Outcome
from avocode.llm.recording import RecordingLLM
from avocode.player import prompts as player_prompts
from avocode.player.player import Player
from avocode.ports import GameEngine, LLMClient, Role, StepContext
from avocode.record.jsonl import JsonlRecorder, utc_stamp
from avocode.record.run_log import RunLog, make_run_id
from avocode.scorer import prompts as scorer_prompts
from avocode.scorer.scorer import Scorer
from avocode.session import GameResult, GameSession, SharedRules

EngineFactory = Callable[[str], GameEngine]
LLMFactory = Callable[[Role], LLMClient]


@dataclass
class RunSummary:
    run_id: str
    run_dir: Path
    results: list[GameResult] = field(default_factory=list)
    outcome: str = "done"
    duration_s: float = 0.0

    @property
    def cost_usd(self) -> float | None:
        return _sum_cost(r.cost_usd for r in self.results)


def git_info(cwd: Path | None = None) -> dict[str, object]:
    """Commit and dirty flag, or empty."""
    try:
        commit = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True,
                                cwd=cwd, check=True).stdout.strip()
        dirty = subprocess.run(["git", "status", "--porcelain", "--untracked-files=no"],
                               capture_output=True, text=True, cwd=cwd, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return {}
    return {"commit": commit, "dirty": bool(dirty.strip())}


class Runner:
    """One run: many games, one folder."""

    def __init__(
        self, settings: Settings, make_engine: EngineFactory, make_llm: LLMFactory,
        run_id: str | None = None, argv: list[str] | None = None,
        stop: threading.Event | None = None, git: dict[str, object] | None = None,
        on_game_end: Callable[[GameResult], None] | None = None,
    ) -> None:
        self.on_game_end = on_game_end
        self.settings = settings
        self.make_engine = make_engine
        self.make_llm = make_llm
        self.stop = stop or threading.Event()
        self.git = git_info() if git is None else git
        commit = str(self.git.get("commit", ""))
        self.run_id = run_id or make_run_id(commit)
        self.argv = argv or []
        self.log: RunLog | None = None
        self.manifest: Manifest | None = None
        self.rules = SharedRules() if settings.carry_rules else None

    def start(self, games: list[str], scorecard: str | None = None) -> RunLog:
        log = RunLog(Path(self.settings.runs_dir), self.run_id)
        self.log = log
        log.link_latest()
        self.manifest = Manifest(
            run_id=self.run_id, started=utc_stamp(), git=self.git, argv=self.argv,
            config=self.settings.to_dict(), games=games, tags=self.settings.tags,
            prompts={"player": player_prompts.PROMPT_HASH, "scorer": scorer_prompts.PROMPT_HASH,
                     "rules": scorer_prompts.RULES_HASH},
            scorecard=scorecard,
        )
        log.write_manifest(self.manifest)
        log.emit(RunStart(run_id=self.run_id, games=games, config=self.settings.to_dict()))
        return log

    def run(self, games: list[str]) -> RunSummary:
        start = time.monotonic()
        log = self.log or self.start(games)
        summary = RunSummary(self.run_id, log.dir)
        workers = max(1, self.settings.workers)
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="game") as pool:
            futures = [pool.submit(self.play_game, game, i % workers)
                       for i, game in enumerate(games)]
            for future in futures:
                summary.results.append(future.result())
        summary.duration_s = round(time.monotonic() - start, 3)
        summary.outcome = "aborted" if self.stop.is_set() else "done"
        self.finish(summary)
        return summary

    def play_game(self, game: str, worker: int) -> GameResult:
        assert self.log is not None
        log = self.log
        log.emit(GameStartRun(worker=worker), game=game)
        recorder = JsonlRecorder(log.game_dir(game), game)
        try:
            if self.stop.is_set():
                result = GameResult(game=game, outcome=Outcome.ABORTED)
                recorder.emit(GameEnd(outcome="aborted", levels_completed=0, steps=0, rounds=0,
                                      in_tokens=0, out_tokens=0, cost_usd=0.0, duration_s=0.0))
            else:
                result = self._session(game, recorder).run()
        finally:
            recorder.close()
        log.emit(GameEndRun(
            outcome=result.outcome.value, levels_completed=result.levels_completed,
            win_levels=result.win_levels, steps=result.steps, rounds=result.rounds,
            cost_usd=result.cost_usd,
        ), game=game)
        if self.on_game_end:
            self.on_game_end(result)
        return result

    def _session(self, game: str, recorder: JsonlRecorder) -> GameSession:
        s = self.settings
        ctx = StepContext()
        player = Player(RecordingLLM(self.make_llm("player"), recorder, ctx), s.player_model)
        scorer = Scorer(RecordingLLM(self.make_llm("scorer"), recorder, ctx), s.scorer_model,
                        skip_noop=s.skip_noop_scorer)
        engine = self.make_engine(game)
        return GameSession(engine, player, scorer, recorder,
                           Budget(s.max_actions, s.max_rounds), ctx=ctx, stop=self.stop,
                           rules=self.rules)

    def finish(self, summary: RunSummary) -> None:
        assert self.log is not None and self.manifest is not None
        results = summary.results
        won = sum(r.outcome is Outcome.WON for r in results)
        levels = sum(r.levels_completed for r in results)
        self.log.emit(RunEnd(outcome=summary.outcome, duration_s=summary.duration_s,
                             games_won=won, levels_total=levels, cost_usd=summary.cost_usd))
        self.manifest.ended = utc_stamp()
        self.manifest.summary = {
            "outcome": summary.outcome, "duration_s": summary.duration_s, "games_won": won,
            "levels_total": levels,
            "win_levels_total": sum(r.win_levels for r in results),
            "steps": sum(r.steps for r in results), "cost_usd": summary.cost_usd,
            "rules": self.rules.text if self.rules else None,
            "games": {r.game: {"outcome": r.outcome.value, "levels": r.levels_completed,
                               "win_levels": r.win_levels, "steps": r.steps,
                               "rounds": r.rounds, "cost_usd": r.cost_usd} for r in results},
        }
        self.log.write_manifest(self.manifest)
        self.log.close()


def _sum_cost(costs: object) -> float | None:
    total = 0.0
    for cost in costs:  # type: ignore[attr-defined]
        if cost is None:
            return None
        total += cost
    return round(total, 6)
