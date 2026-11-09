"""run.jsonl, manifest.json, and runs/latest."""

from __future__ import annotations

import os
from datetime import UTC, datetime
from pathlib import Path

from avocode.core.events import Envelope, Manifest
from avocode.record.jsonl import LineWriter


def make_run_id(commit: str = "", when: datetime | None = None) -> str:
    """UTC date, UTC time, short commit."""
    moment = when or datetime.now(UTC)
    stamp = moment.strftime("%Y%m%d-%H%M%S")
    return f"{stamp}-{commit[:7]}" if commit else stamp


def safe_name(game: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in game)


class RunLog:
    """Owns the run folder."""

    def __init__(self, runs_dir: Path, run_id: str) -> None:
        self.runs_dir = runs_dir
        self.run_id = run_id
        self.dir = runs_dir / run_id
        self.dir.mkdir(parents=True, exist_ok=False)
        (self.dir / "games").mkdir()
        self._log = LineWriter(self.dir / "run.jsonl")

    def emit(self, event: Envelope, game: str | None = None) -> None:
        """Thread safe."""
        self._log.write_event(event, game)

    def game_dir(self, game: str) -> Path:
        return self.dir / "games" / safe_name(game)

    def write_manifest(self, manifest: Manifest) -> None:
        """Temp file, then rename."""
        tmp = self.dir / "manifest.json.tmp"
        tmp.write_text(manifest.model_dump_json(indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, self.dir / "manifest.json")

    def link_latest(self) -> None:
        link = self.runs_dir / "latest"
        tmp = self.runs_dir / f".latest-{os.getpid()}"
        if tmp.is_symlink() or tmp.exists():
            tmp.unlink()
        tmp.symlink_to(self.run_id, target_is_directory=True)
        os.replace(tmp, link)

    def close(self) -> None:
        self._log.close()
