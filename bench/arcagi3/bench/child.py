#!/usr/bin/env python3
# PROTECTED -- this file is part of `f`. Editing it makes `bench/init.sh --verify` fail.
#
# Runs src/policy.py in its own process.

import importlib
import json
import os
import pickle
import struct
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent


class Cheated(BaseException):
    """The policy reached for something a policy does not get to see.

    Deliberately a BaseException and not an Exception: the first version of this was an Exception,
    and a policy whose act() body was wrapped in `except Exception: pass` swallowed its own
    violation and scored a clean 0.26. Anything a bare `except Exception` can catch is not a gate.
    """


class PolicyFailed(Exception):
    """The policy raised, or its process died."""


def _send(stream, payload):
    stream.write(struct.pack(">I", len(payload)) + payload)
    stream.flush()


def _recv(stream):
    head = stream.read(4)
    if len(head) < 4:
        return None
    (size,) = struct.unpack(">I", head)
    body = stream.read(size)
    return body if len(body) == size else None


# ---------------------------------------------------------------------------- the parent side
def _no_ptrace():
    """Block /proc/<pid>/mem reads (Linux only)."""
    try:
        import ctypes

        ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0)  # PR_SET_DUMPABLE, 0
    except (OSError, AttributeError):
        pass


class PolicyProcess:
    """A policy behind a pipe, in a fresh interpreter."""

    def __init__(self, adapter, guard=()):
        _no_ptrace()
        # Not fork(): that copies the engine.
        self._proc = subprocess.Popen(
            [sys.executable, str(HERE / "child.py"), adapter, *(str(g) for g in guard)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )

    def ready(self):
        """Wait for the policy's import."""
        self._answer()

    def call(self, kind, body=None):
        """Send one request; return the child's answer."""
        try:
            _send(self._proc.stdin, pickle.dumps((kind, body), protocol=pickle.HIGHEST_PROTOCOL))
        except OSError:
            raise PolicyFailed("the policy process exited") from None
        return self._answer()

    def _answer(self):
        raw = _recv(self._proc.stdout)
        if raw is None:
            raise PolicyFailed("the policy process exited")
        try:  # JSON, never pickle: unpickling runs code.
            reply = json.loads(raw)
        except ValueError:
            raise PolicyFailed("the policy process sent a malformed reply") from None
        if not isinstance(reply, dict):
            raise PolicyFailed("the policy process sent a malformed reply")
        if "cheated" in reply:
            raise Cheated(str(reply["cheated"]))
        if "error" in reply:
            raise PolicyFailed(str(reply["error"]))
        return reply.get("ok")

    def close(self):
        try:
            self._proc.stdin.close()
        except OSError:
            pass
        try:
            self._proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self._proc.kill()
            self._proc.wait()


# ---------------------------------------------------------------------------- the sandbox
# A flag too, in case it is swallowed.

_guard = ()
_violation = None

_NETWORK = {"socket.connect", "socket.getaddrinfo", "socket.bind", "urllib.Request"}
# Spawn escapes the hook; kill stops f.
_PROCESS = {
    "subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.fork", "os.forkpty",
    "os.kill", "os.killpg", "signal.pthread_kill",
}


def _caught(why):
    global _violation
    if _violation is None:
        _violation = why
    raise Cheated(why)


def _hook(event, args):
    if event in _NETWORK:
        _caught(f"the policy attempted network access ({event})")
    if event in _PROCESS:
        _caught(f"the policy attempted to start or signal a process ({event})")
    if event == "open" and _guard:
        try:
            target = str(Path(os.fsdecode(args[0])).resolve())
        except (TypeError, ValueError):
            return
        if any(target.startswith(g) for g in _guard):
            _caught(f"the policy attempted to read a game source file ({Path(target).name})")


def _plain(value):
    """numpy scalars become plain numbers."""
    if hasattr(value, "item"):
        return value.item()
    raise TypeError(f"{type(value).__name__} is not JSON-serializable")


# ---------------------------------------------------------------------------- the child side
def child_main(argv):
    global _guard

    # A print() must not corrupt the pipe.
    inp = os.fdopen(os.dup(0), "rb")
    out = os.fdopen(os.dup(1), "wb")
    devnull = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull, 0)
    os.dup2(devnull, 1)

    def reply(**payload):
        try:
            data = json.dumps(payload, default=_plain).encode()
        except (TypeError, ValueError) as exc:
            data = json.dumps({"error": f"act() returned data that is not JSON: {exc}"}).encode()
        _send(out, data)

    sys.path.insert(0, str(HERE))
    adapter = importlib.import_module(argv[0])
    _guard = tuple(str(Path(g).resolve()) for g in argv[1:])
    sys.addaudithook(_hook)

    sys.path.insert(0, str(ROOT))
    try:
        from src.policy import Policy

        mod = sys.modules["src.policy"]
        for banned in adapter.BANNED:
            if getattr(mod, banned, None) is not None:
                return reply(error=f"src/policy.py imported {banned}; a policy sees frames, nothing else")
        if _violation is not None:
            raise Cheated(f"{_violation} (and swallowed the error it raised)")
    except Cheated as exc:
        return reply(cheated=str(exc))
    except BaseException as exc:  # a broken candidate is a candidate failure
        return reply(error=f"src/policy.py does not import: {type(exc).__name__}: {exc}")
    reply(ok=None)

    policy = None
    while True:
        raw = _recv(inp)
        if raw is None:
            return
        kind, body = pickle.loads(raw)
        try:
            if kind == "reset":
                policy = Policy(**adapter.policy_args(body))
                answer = None
            elif kind == "act":
                answer = adapter.encode(policy.act(adapter.frame_view(body)))
            else:
                raise ValueError(f"unknown request '{kind}'")
            if _violation is not None:
                raise Cheated(f"{_violation} (and swallowed the error it raised)")
        except Cheated as exc:
            return reply(cheated=str(exc))
        except BaseException as exc:
            return reply(error=f"{type(exc).__name__}: {exc}")
        reply(ok=answer)


if __name__ == "__main__":
    child_main(sys.argv[1:])
