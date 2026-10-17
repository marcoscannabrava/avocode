#!/usr/bin/env python3
# PROTECTED -- this file is part of `f`. Editing it makes `bench/init.sh --verify` fail.
#
# The ARC-AGI-3 episode harness. It owns the environment; `src/policy.py` only ever sees frames,
# from its own process (bench/child.py).
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
import random
import statistics
import sys
import time
import types
from pathlib import Path

from child import Cheated, PolicyFailed, PolicyProcess

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


# ---------------------------------------------------------------------------- the child's adapter
# bench/child.py calls these in the child.

# A policy holding these could build an engine.
BANNED = ("arcengine", "arc_agi")


def policy_args(spec):
    """Policy(...) keyword arguments, from plain data."""
    from arcengine import GameAction

    return {
        "action_space": [GameAction[name] for name in spec["actions"]],
        "rng": random.Random(spec["seed"]),
    }


def frame_view(obs):
    """What act() is handed."""
    return types.SimpleNamespace(**obs)


def encode(choice):
    """act()'s return value as plain data."""
    action, data = choice, {}
    if isinstance(choice, tuple):
        if len(choice) != 2:
            return {"bad": f"act() returned a {len(choice)}-tuple; expected (action, data)"}
        action, data = choice
    if data is None:
        data = {}
    if not isinstance(data, dict):
        return {"bad": f"act() returned action data of type {type(data).__name__}; expected a dict"}
    name = getattr(action, "name", None)
    return {"action": name if isinstance(name, str) else None, "repr": repr(action), "data": data}


def _emit(payload):
    print(json.dumps(payload, separators=(",", ":")))
    sys.exit(0)


def _fail(config, log, ok=True, correct=False):
    _emit({"ok": ok, "correct": correct, "config": config, "log": log})


# ---------------------------------------------------------------------------- one episode
def episode(arc, game_id, rollout, child, action_state):
    from arcengine import GameState

    env = arc.make(game_id, seed=rollout)
    if env is None:
        raise RuntimeError(f"the engine returned no environment for '{game_id}'")

    # The policy is given the action space and the frames. It is NOT given the game id: ARC-AGI-3 is
    # a benchmark about games you have never seen, so a policy keyed on the id is a lookup table,
    # and withholding it is what makes the holdout mean anything.
    child.call("reset", {"actions": [a.name for a in env.action_space], "seed": POLICY_SEED + rollout})

    frame = env.reset()
    best = 0
    actions = 0
    for _ in range(BUDGET):
        action, data = _unpack(child.call("act", _observe(frame)), env.action_space)
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


def _observe(frame):
    """The documented fields. Not game_id."""
    return {
        "frame": frame.frame,
        "state": frame.state,
        "levels_completed": frame.levels_completed,
        "win_levels": frame.win_levels,
        "available_actions": list(frame.available_actions),
    }


def _unpack(reply, action_space):
    """Check the child's reply; trust none of it."""
    if not isinstance(reply, dict):
        raise Cheated("the policy process sent a malformed reply")
    if "bad" in reply:
        raise Cheated(str(reply["bad"]))
    action = next((a for a in action_space if a.name == reply.get("action")), None)
    if action is None:
        raise Cheated(f"act() returned {reply.get('repr')}, which is not in this game's action space")
    data = reply.get("data")
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

    games_dir = Path(args.games_dir).resolve() if args.games_dir else (HERE / "games")
    if not games_dir.is_dir():
        _fail(args.config, f"no game corpus at {games_dir} -- run bench/setup.sh", ok=False)

    # Started first, so both imports overlap.
    child = PolicyProcess("run", guard=[games_dir])

    try:
        from arc_agi import Arcade, OperationMode
    except ImportError as exc:
        _fail(args.config, f"the arc-agi toolkit is not importable ({exc}) -- run bench/setup.sh", ok=False)

    try:
        child.ready()
    except Cheated as exc:
        _fail(args.config, f"the candidate broke the policy contract: {exc}")
    except PolicyFailed as exc:  # a broken candidate is a candidate failure, not a harness failure
        _fail(args.config, str(exc))

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
            per_rollout.append(episode(arc, args.config, rollout, child, action_state))
    except Cheated as exc:
        _fail(args.config, f"the candidate broke the policy contract: {exc}")
    except PolicyFailed as exc:
        _fail(args.config, f"the candidate raised during play: {exc}")
    except Exception as exc:
        _fail(args.config, f"the candidate raised during play: {type(exc).__name__}: {exc}")

    child.close()
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
