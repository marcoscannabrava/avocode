#!/usr/bin/env python3
# PROTECTED -- this file is part of `f`. Editing it makes `bench/init.sh --verify` fail.
#
# The ARC-AGI-3 episode harness. It owns the environment; `src/policy.py` only ever sees frames.
#
#   bench/run.py --list                 config names, one per line
#   bench/run.py --config <game>        one JSON line for that game
#   bench/run.py --games-dir <dir> --config <g>
#                                       the same, against a different corpus (the holdout)
#
# One JSON line per config, always exit 0 -- `.avo/score` reads it and decides. The metric is built
# from the only progress signal the engine actually exposes: `FrameDataRaw` carries
# `levels_completed` and `win_levels` and nothing finer -- there is no per-step reward and no
# `score` field, whatever the toolkit docs say. So a config's score is
#
#     max levels_completed reached over the episode / win_levels
#
# `max` rather than the final value because a GAME_OVER resets the run, and progress already made
# was still made. Episodes are capped at BUDGET actions.
#
# Determinism is what makes this a usable `f`, and it is why .avo/config.json can set floor 0: the
# engine is deterministic, the policy's Random is seeded from a constant, and nothing here reads the
# clock. The whole score vector has been measured bit-identical across repeated runs.

import argparse
import json
import os
import random
import statistics
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

# The training corpus: ten games spanning movement, collection, coverage, keys and doors, floor
# switches, teleporters, arrow tiles, memory, flood fill and sequencing. Chosen by measurement, not
# taste. Every one of them has a solidly non-zero baseline and none is saturated, so each config
# has room to move in both directions.
#
# Two games were tried here and removed, both for reasons worth not rediscovering:
#
#   sq01  a near-zero config (baseline 0.025). `avo commit` compares configs by RELATIVE delta, so a
#         config sitting at 0.025 swings +/-100% when it moves by one level on one rollout, and one
#         such config vetoes every commit no matter what floor is set. A hard game is not free
#         headroom.
#   wm01  NOT DETERMINISTIC. Whack-a-Mole is a real-time game -- it scored 0.483, 0.533, 0.483 on
#         three consecutive runs of identical code. Every other game in this corpus, including the
#         other survival/timing ones, is frame-counted and exact. A config that moves on its own
#         makes `floor` meaningless and would let the loop commit noise, so anything timing-based is
#         disqualified here however good a task it is.
TRAIN = ["ez02", "tt01", "va01", "ul01", "fs01", "tp01", "nw01", "mm01", "ff01", "ff03"]

BUDGET = 250

# Rollouts per game. Both halves of this number are measured, and both matter.
#
# `arc.make(game_id, seed=...)` is a NO-OP for this corpus: the level layouts are fixed, and N
# different `seed` values produce N byte-identical episodes. So the rollout index is fed to the
# POLICY's Random instead (see POLICY_SEED), and that is where the spread lives.
#
# Why not one rollout: with a single stream, a stochastic policy's score is a measurement of one
# lucky draw rather than of the policy. Measured -- two behaviourally identical policies that merely
# consume the rng differently scored 0.234 and 0.262, a 12% swing from a change that does nothing.
# That is noise wearing the costume of signal, and with floor 0 it would both refuse real
# improvements and commit lucky reshuffles.
#
# 24 is chosen from the noise measurement, not from taste. Two policies with identical behaviour but
# different rng consumption disagree by a median of 18% per config at 8 rollouts and 6% at 24; that
# median is what .avo/config.json's `floor` has to absorb, so it is worth paying to shrink it.
#
# A fully deterministic policy pays 24x for one number. That is the price of the guarantee, and at
# ~40ms an episode the whole vector is still under half a minute.
ROLLOUTS = 24

# The policy's Random is seeded from this constant, so the score vector is a pure function of src/
# even when the policy is stochastic. It is deliberately not derived from anything the policy can
# observe: a policy handed its own seed could index a lookup table by it.
POLICY_SEED = 1000003


class Cheated(BaseException):
    """The policy reached for something a policy does not get to see.

    Deliberately a BaseException and not an Exception: the first version of this was an Exception,
    and a policy whose act() body was wrapped in `except Exception: pass` swallowed its own
    violation and scored a clean 0.26. Anything a bare `except Exception` can catch is not a gate.
    """


# ---------------------------------------------------------------------------- the sandbox
# A policy has two cheap routes to a high score that have nothing to do with playing well: read the
# game's source (it is right there in bench/games/) or phone out. The audit hook is armed only for
# the duration of policy.act, so the engine's own file access during make/step is untouched.

_armed = False
_games_dir = None

# Raising is not enough on its own -- `except BaseException` is still a thing a determined candidate
# can write. So every violation is also recorded here, and the harness checks it after act() returns.
# A cheat that swallows the exception still trips the flag.
_violation = None


def _caught(why):
    global _violation
    if _violation is None:
        _violation = why
    raise Cheated(why)


def _hook(event, args):
    if not _armed:
        return
    if event in ("socket.connect", "socket.getaddrinfo", "socket.bind", "urllib.Request"):
        _caught(f"the policy attempted network access ({event})")
    if event == "open" and _games_dir is not None:
        try:
            target = Path(os.fsdecode(args[0])).resolve()
        except (TypeError, ValueError):
            return
        if str(target).startswith(str(_games_dir)):
            _caught(f"the policy attempted to read a game source file ({target.name})")


sys.addaudithook(_hook)


def _emit(payload):
    print(json.dumps(payload, separators=(",", ":")))
    sys.exit(0)


def _fail(config, log, ok=True, correct=False):
    _emit({"ok": ok, "correct": correct, "config": config, "log": log})


# ---------------------------------------------------------------------------- one episode
def episode(arc, game_id, rollout, policy_cls, action_state):
    global _armed

    from arcengine import GameState

    env = arc.make(game_id, seed=rollout)
    if env is None:
        raise RuntimeError(f"the engine returned no environment for '{game_id}'")

    # The policy is given the action space and the frames. It is NOT given the game id: ARC-AGI-3 is
    # a benchmark about games you have never seen, so a policy keyed on the id is a lookup table,
    # and withholding it is what makes the holdout mean anything.
    policy = policy_cls(action_space=list(env.action_space), rng=random.Random(POLICY_SEED + rollout))

    frame = env.reset()
    best = 0
    actions = 0
    for _ in range(BUDGET):
        _armed = True
        try:
            choice = policy.act(frame)
        finally:
            _armed = False
        if _violation is not None:
            raise Cheated(f"{_violation} (and swallowed the error it raised)")
        action, data = _unpack(choice, env.action_space)
        frame = env.step(action, data=data)
        actions += 1
        if frame is None:
            break
        best = max(best, frame.levels_completed)
        if frame.state == GameState.WIN:
            break
        if frame.state == GameState.GAME_OVER:
            frame = env.reset()
    total = (frame.win_levels if frame else 0) or 1
    action_state["actions"] += actions
    return best / total


def _unpack(choice, action_space):
    """A policy returns an action, or an (action, data) pair. Anything else is a contract failure."""
    data = {}
    action = choice
    if isinstance(choice, tuple):
        if len(choice) != 2:
            raise Cheated(f"act() returned a {len(choice)}-tuple; expected (action, data)")
        action, data = choice
    if action not in action_space:
        raise Cheated(f"act() returned {action!r}, which is not in this game's action space")
    if data is None:
        data = {}
    if not isinstance(data, dict):
        raise Cheated(f"act() returned action data of type {type(data).__name__}; expected a dict")
    if action.is_complex() and not {"x", "y"} <= set(data):
        raise Cheated(f"{action!r} is a complex action and needs x and y in its data; got {data!r}")
    return action, data


# ---------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--config")
    ap.add_argument("--games-dir")
    ap.add_argument("--games", help="comma-separated ids, for scoring a corpus other than TRAIN")
    args, unknown = ap.parse_known_args()
    if unknown:
        _fail(None, f"unknown argument(s): {' '.join(unknown)}", ok=False)

    if args.list:
        for name in TRAIN:
            print(name)
        return

    known = args.games.split(",") if args.games else TRAIN
    if args.config is None:
        _fail(None, "need --config <game> or --list", ok=False)
    if args.config not in known:
        _fail(args.config, f"no such config '{args.config}' (have: {', '.join(known)})", ok=False)

    global _games_dir
    games_dir = Path(args.games_dir).resolve() if args.games_dir else (HERE / "games")
    _games_dir = games_dir
    if not games_dir.is_dir():
        _fail(args.config, f"no game corpus at {games_dir} -- run bench/setup.sh", ok=False)

    try:
        from arc_agi import Arcade, OperationMode
    except ImportError as exc:
        _fail(args.config, f"the arc-agi toolkit is not importable ({exc}) -- run bench/setup.sh", ok=False)

    sys.path.insert(0, str(ROOT))
    try:
        from src.policy import Policy
    except Exception as exc:  # a broken candidate is a candidate failure, not a harness failure
        _fail(args.config, f"src/policy.py does not import: {type(exc).__name__}: {exc}")

    # A policy that imported the engine could read game state straight out of it.
    for banned in ("arcengine", "arc_agi"):
        mod = sys.modules.get("src.policy")
        if mod is not None and getattr(mod, banned.split(".")[0], None) is not None:
            _fail(args.config, f"src/policy.py imported {banned}; a policy sees frames, nothing else")

    import logging

    logging.disable(logging.CRITICAL)  # the toolkit logs per-step at INFO
    arc = Arcade(
        operation_mode=OperationMode.OFFLINE,
        environments_dir=str(games_dir),
        logger=logging.getLogger("arcagi3-bench"),
    )

    started = time.perf_counter()
    action_state = {"actions": 0}
    per_rollout = []
    try:
        for rollout in range(ROLLOUTS):
            per_rollout.append(episode(arc, args.config, rollout, Policy, action_state))
    except Cheated as exc:
        _fail(args.config, f"the candidate broke the policy contract: {exc}")
    except Exception as exc:
        _fail(args.config, f"the candidate raised during play: {type(exc).__name__}: {exc}")

    score = statistics.mean(per_rollout)
    _emit(
        {
            "ok": True,
            "correct": True,
            "config": args.config,
            "score": round(score, 6),
            "per_rollout": [round(v, 4) for v in per_rollout],
            "rollouts": ROLLOUTS,
            "budget": BUDGET,
            "actions": action_state["actions"],
            "duration_s": round(time.perf_counter() - started, 3),
        }
    )


if __name__ == "__main__":
    main()
