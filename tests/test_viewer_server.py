import json
import threading
import urllib.error
import urllib.request
from collections.abc import Iterator
from pathlib import Path

import pytest

from bench.viewer.server import _parse_range, make_server


@pytest.fixture
def base(tmp_path: Path) -> Iterator[str]:
    run = tmp_path / "runs" / "r1"
    run.mkdir(parents=True)
    (run / "run.jsonl").write_bytes(b'{"a":1}\n{"b":2}\n')
    (tmp_path / "secret.txt").write_text("no")
    server = make_server(tmp_path / "runs", 0, "r1")
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


def get(url: str, range_: str | None = None) -> tuple[int, bytes]:
    req = urllib.request.Request(url, headers={"Range": range_} if range_ else {})
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as err:
        return err.code, b""


def test_config_and_static(base: str) -> None:
    status, body = get(base + "/api/config")
    assert status == 200 and json.loads(body) == {"run": "r1", "runs": ["r1"]}
    status, body = get(base + "/")
    assert status == 200 and b"<html" in body


def test_range_reads(base: str) -> None:
    assert get(base + "/runs/r1/run.jsonl") == (200, b'{"a":1}\n{"b":2}\n')
    assert get(base + "/runs/r1/run.jsonl", "bytes=8-") == (206, b'{"b":2}\n')
    assert get(base + "/runs/r1/run.jsonl", "bytes=16-")[0] == 416


def test_rejects_escape(base: str) -> None:
    assert get(base + "/runs/../secret.txt")[0] in (403, 404)
    assert get(base + "/runs/%2e%2e/secret.txt")[0] in (403, 404)
    assert get(base + "/server.py")[0] == 404


def test_parse_range() -> None:
    assert _parse_range("bytes=0-", 10) == (0, 9)
    assert _parse_range("bytes=2-4", 10) == (2, 4)
    assert _parse_range("bytes=10-", 10) is None
    assert _parse_range("items=0-", 10) is None
