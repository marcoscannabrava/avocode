import json
import threading
from pathlib import Path

import jsonschema
import pytest
from pydantic import BaseModel

from avocode.core import Grid, State
from avocode.core.events import (
    GAME_EVENTS,
    RUN_EVENTS,
    After,
    Before,
    Budget,
    DiffSummary,
    GameStart,
    LLMRecord,
    Manifest,
    RunStart,
    Step,
    StepAction,
    all_schemas,
)
from avocode.llm.fake import FakeLLM
from avocode.llm.pricing import cost_usd
from avocode.llm.recording import RecordingLLM
from avocode.ports import LLMRequest, StepContext
from avocode.record.jsonl import JsonlRecorder, read_jsonl
from avocode.record.memory import MemoryRecorder
from avocode.record.run_log import RunLog, make_run_id


def step_event(n: int) -> Step:
    return Step(
        step=n, round=1, round_step=n, level=0, action=StepAction(name="ACTION6", x=1, y=2),
        reason="test", model_version=1,
        before=Before(game_state="NOT_FINISHED", levels_completed=0),
        after=After(game_state="NOT_FINISHED", levels_completed=0, available_actions=["ACTION6"]),
        status="ongoing", diff=DiffSummary(cells=1, noop=False, bbox=[1, 2, 1, 2]), frames=1,
    )


def write_game(tmp_path: Path) -> Path:
    rec = JsonlRecorder(tmp_path / "g", "ls20-abc")
    rec.emit(GameStart(win_levels=2, available_actions=["ACTION6"],
                       budget=Budget(max_actions=10, max_rounds=2)))
    rec.emit(step_event(1))
    grid = Grid.from_text("01\nfa")
    rec.frames(1, State((grid,), "NOT_FINISHED", 0, 2, ("ACTION6",)))
    ctx = StepContext()
    ctx.begin(1, 1)
    llm = RecordingLLM(FakeLLM([{"action": "A1"}]), rec, ctx)

    class Pick(BaseModel):
        action: str

    llm.complete(LLMRequest(role="player", system="s", user="u", schema=Pick, model="fake",
                            prompt_hash="h"))
    rec.close()
    return tmp_path / "g"


def test_write_and_read_back(tmp_path: Path) -> None:
    game_dir = write_game(tmp_path)
    events = [GAME_EVENTS.validate_python(e) for e in read_jsonl(game_dir / "events.jsonl")]
    assert [e.type for e in events] == ["game_start", "step", "llm_start", "llm_end"]
    assert [e.seq for e in events] == [0, 1, 2, 3]
    assert all(e.game == "ls20-abc" and e.v == 1 and e.ts.endswith("Z") for e in events)
    assert events[1].action.x == 1
    frames = list(read_jsonl(game_dir / "frames.jsonl"))
    assert frames == [{"step": 1, "w": 2, "h": 2, "frames": ["01fa"]}]
    llm = [LLMRecord.model_validate(r) for r in read_jsonl(game_dir / "llm.jsonl")]
    assert llm[0].call_id == "p-1" and llm[0].parsed == {"action": "A1"}
    assert llm[0].cost_usd == 0.0


def test_lines_match_json_schema(tmp_path: Path) -> None:
    game_dir = write_game(tmp_path)
    schemas = all_schemas()
    validators = {k: jsonschema.Draft202012Validator(v) for k, v in schemas.items()}
    for name in ("events.jsonl", "frames.jsonl", "llm.jsonl"):
        for line in read_jsonl(game_dir / name):
            validators[name].validate(line)
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({"type": "step", "step": "x"}, schemas["events.jsonl"])


def test_reader_skips_partial_line(tmp_path: Path) -> None:
    game_dir = write_game(tmp_path)
    path = game_dir / "events.jsonl"
    data = path.read_bytes()
    cut = data.rfind(b"\n", 0, len(data) - 1) + 10  # middle of last line
    path.write_bytes(data[:cut])
    assert [e["type"] for e in read_jsonl(path)] == ["game_start", "step", "llm_start"]
    path.write_bytes(b'{"partial":')
    assert list(read_jsonl(path)) == []


def test_run_log(tmp_path: Path) -> None:
    run_id = make_run_id("a1b2c3d4e5")
    log = RunLog(tmp_path, run_id)
    log.link_latest()
    log.write_manifest(Manifest(run_id=run_id, started="now", games=["ls20"]))

    def write(n: int) -> None:
        for _ in range(50):
            log.emit(RunStart(run_id=run_id, games=[str(n)]))

    threads = [threading.Thread(target=write, args=(i,)) for i in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    log.close()
    lines = list(read_jsonl(log.dir / "run.jsonl"))
    validators = {"run.jsonl": jsonschema.Draft202012Validator(all_schemas()["run.jsonl"])}
    assert [line["seq"] for line in lines] == list(range(200))
    for line in lines:
        RUN_EVENTS.validate_python(line)
        validators["run.jsonl"].validate(line)
    assert (tmp_path / "latest").resolve() == log.dir.resolve()
    manifest = json.loads((log.dir / "manifest.json").read_text())
    assert manifest["run_id"] == run_id and manifest["ended"] is None
    assert run_id.endswith("-a1b2c3d")


def test_recording_llm_ids_and_errors() -> None:
    rec = MemoryRecorder()
    ctx = StepContext()
    ctx.begin(2, 7)

    class Pick(BaseModel):
        action: str

    req = LLMRequest(role="scorer", system="s", user="u", schema=Pick, model="unknown-model")
    llm = RecordingLLM(FakeLLM([{"action": "x"}, {"action": "y"}]), rec, ctx)
    llm.complete(req)
    llm.complete(req)
    assert ctx.call_ids == ["s-7", "s-7.2"]
    ends = rec.of_type("llm_end")
    assert ends[0].cost_usd is None and ctx.cost_usd is None  # unknown model
    with pytest.raises(RuntimeError):
        llm.complete(req)  # no replies left
    assert rec.of_type("llm_end")[-1].ok is False
    assert rec.llm_records[-1].error.startswith("RuntimeError")


def test_pricing() -> None:
    assert cost_usd("claude-opus-5-5", 1_000_000, 0) == 4.0
    assert cost_usd("claude-sonnet-5-5", 0, 1_000_000, 1_000_000) == 10.2
    assert cost_usd("gpt-unknown", 10, 10) is None
    assert cost_usd("gpt-6-luna", 1_000_000, 1_000_000, 1_000_000) == 0.61
