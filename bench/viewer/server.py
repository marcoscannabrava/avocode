"""Serve the viewer and run files.

Binds to 127.0.0.1. Supports Range reads.
"""

from __future__ import annotations

import json
import mimetypes
import threading
from functools import partial
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

STATIC = Path(__file__).resolve().parent
STATIC_TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css"}


class Handler(BaseHTTPRequestHandler):
    server_version = "avocode-viewer"

    def __init__(self, *args: object, runs_dir: Path, run_id: str | None, **kw: object) -> None:
        self.runs_dir = runs_dir.resolve()
        self.run_id = run_id
        super().__init__(*args, **kw)  # type: ignore[arg-type]

    def log_message(self, format: str, *args: object) -> None:
        """Stay quiet."""

    def do_GET(self) -> None:
        path = unquote(urlsplit(self.path).path)
        if ".." in path.split("/") or "\\" in path:
            self.send_error(HTTPStatus.FORBIDDEN, "Bad path")
            return
        if path == "/api/config":
            self._json({"run": self.run_id, "runs": self._runs()})
        elif path.startswith("/runs/"):
            self._file(self.runs_dir, path[len("/runs/"):], ranged=True)
        else:
            self._file(STATIC, path.lstrip("/") or "index.html", ranged=False)

    def _runs(self) -> list[str]:
        if not self.runs_dir.is_dir():
            return []
        found = [p.name for p in self.runs_dir.iterdir()
                 if (p / "run.jsonl").exists() and not p.is_symlink()]
        return sorted(found, reverse=True)

    def _file(self, root: Path, rel: str, ranged: bool) -> None:
        target = (root / rel).resolve()
        if not target.is_relative_to(root.resolve()) or not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return
        if not ranged and target.suffix not in STATIC_TYPES:
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return
        size = target.stat().st_size
        start, end = 0, size - 1
        status = HTTPStatus.OK
        header = self.headers.get("Range")
        if ranged and header:
            parsed = _parse_range(header, size)
            if parsed is None:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            start, end = parsed
            status = HTTPStatus.PARTIAL_CONTENT
        with target.open("rb") as handle:
            handle.seek(start)
            body = handle.read(max(0, end - start + 1))
        self.send_response(status)
        kind = STATIC_TYPES.get(target.suffix) or mimetypes.guess_type(target.name)[0]
        self.send_header("Content-Type", kind or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Accept-Ranges", "bytes")
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{start + len(body) - 1}/{size}")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, data: object) -> None:
        body = json.dumps(data).encode()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def _parse_range(header: str, size: int) -> tuple[int, int] | None:
    """Parse 'bytes=a-' or 'bytes=a-b'."""
    if not header.startswith("bytes=") or "," in header:
        return None
    first, _, last = header[len("bytes="):].partition("-")
    try:
        start = int(first)
        end = int(last) if last else size - 1
    except ValueError:
        return None
    if start >= size or start > end:
        return None
    return start, min(end, size - 1)


def make_server(runs_dir: Path, port: int, run_id: str | None = None) -> ThreadingHTTPServer:
    handler = partial(Handler, runs_dir=runs_dir, run_id=run_id)
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.daemon_threads = True
    return server


def serve_in_thread(runs_dir: Path, port: int, run_id: str | None = None) -> str:
    """Start in a thread. Return the URL."""
    server = make_server(runs_dir, port, run_id)
    threading.Thread(target=server.serve_forever, daemon=True, name="viewer").start()
    return f"http://127.0.0.1:{server.server_address[1]}/"


def serve_forever(runs_dir: Path, port: int, run_id: str | None = None) -> None:
    server = make_server(runs_dir, port, run_id)
    print(f"Viewer at http://127.0.0.1:{server.server_address[1]}/ (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
