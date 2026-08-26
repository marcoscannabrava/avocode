#!/usr/bin/env bash
# Run an arcagi3 target's policy against the OFFICIAL ARC-AGI-3 games, over the network, and print
# the scorecard it earned.
#
#   test/fixtures/arcagi3/score-api.sh <target-repo> [--games ls20,ft09] [--json]
#
# This is the only thing in the arcagi3 tooling that touches the network, and it is never part of
# `f`: it is slow, rate-limited, and its games can change under you, none of which a fitness function
# can tolerate. Its job is the one question the offline corpus cannot answer -- whether any of what
# the loop learned transfers to the real benchmark.
#
# Needs ARC_API_KEY. Without it the toolkit falls back to an anonymous key with limited game access,
# so this refuses rather than quietly measuring something else.
#
# The key is never printed. evidence/ is committed to git.
set -uo pipefail

die() { printf 'score-api.sh: %s\n' "$*" >&2; exit 2; }

json=false
dest=""
games="ls20,ft09"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --games) [[ -n "${2-}" ]] || die "--games needs a value"; games="$2"; shift 2 ;;
    --json) json=true; shift ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option '$1'" ;;
    *) [[ -z "$dest" ]] || die "one target at a time"; dest="$1"; shift ;;
  esac
done
[[ -n "$dest" ]] || die "need a target repo"
dest="$(cd -- "$dest" 2>/dev/null && pwd)" || die "no such directory"
[[ -f "$dest/src/policy.py" ]] || die "$dest is not an arcagi3 target (no src/policy.py)"
[[ -x "$dest/.venv/bin/python" ]] || die "$dest has no .venv -- run its bench/setup.sh first"
[[ -n "${ARC_API_KEY:-}" ]] || die "ARC_API_KEY is not set; refusing to measure against an anonymous key"

# The driver lives here rather than in the target: playing the official games is not part of `f`, and
# a script in the target repo is a script the agent can edit.
driver="$(mktemp)"
trap 'rm -f "$driver"' EXIT
cat > "$driver" <<'PY'
import json as _json
import logging
import os
import random
import sys

sys.path.insert(0, os.getcwd())

import arc_agi
from arc_agi import OperationMode
from arcengine import GameState

from src.policy import Policy

logging.disable(logging.CRITICAL)

games = sys.argv[1].split(",")
budget = int(os.environ.get("ARC_API_BUDGET", "250"))

arc = arc_agi.Arcade(operation_mode=OperationMode.ONLINE)
card = arc.create_scorecard(tags=["avocode", "arcagi3"])

out = {}
for game in games:
    env = arc.make(game, scorecard_id=card)
    if env is None:
        out[game] = {"error": "the API returned no environment (is this game available to your key?)"}
        continue
    policy = Policy(action_space=list(env.action_space), rng=random.Random(1000003))
    frame = env.reset()
    best = 0
    for _ in range(budget):
        choice = policy.act(frame)
        action, data = choice if isinstance(choice, tuple) else (choice, {})
        frame = env.step(action, data=data or {})
        if frame is None:
            break
        best = max(best, frame.levels_completed)
        if frame.state == GameState.WIN:
            break
        if frame.state == GameState.GAME_OVER:
            frame = env.reset()
    out[game] = {
        "levels_completed": best,
        "win_levels": (frame.win_levels if frame else 0),
    }

scorecard = arc.close_scorecard(card)
print(_json.dumps({
    "card_id": card,
    "url": f"https://arcprize.org/scorecards/{card}",
    "official_score": getattr(scorecard, "score", None),
    "total_levels_completed": getattr(scorecard, "total_levels_completed", None),
    "total_actions": getattr(scorecard, "total_actions", None),
    "per_game": out,
}, separators=(",", ":")))
PY

result="$(cd "$dest" && .venv/bin/python "$driver" "$games" 2>&1)"
code=$?
line="$(printf '%s' "$result" | tail -n 1)"
if (( code != 0 )) || ! jq -e 'has("card_id")' >/dev/null 2>&1 <<<"$line"; then
  # Print the diagnosis, but never the environment: a traceback can carry a URL with a key in it.
  printf 'score-api.sh: the API run failed (exit %d):\n%s\n' "$code" \
    "$(printf '%s' "$result" | tail -n 20 | sed "s/${ARC_API_KEY}/<ARC_API_KEY>/g")" >&2
  exit 1
fi

if [[ "$json" == true ]]; then
  printf '%s\n' "$line"
else
  jq -r '"scorecard       \(.card_id)",
         "url             \(.url)",
         "official score  \(.official_score // "not reported")",
         "levels          \(.total_levels_completed // "?") in \(.total_actions // "?") actions",
         (.per_game | to_entries[] | "  \(.key)  \(.value | tojson)")' <<<"$line"
fi
