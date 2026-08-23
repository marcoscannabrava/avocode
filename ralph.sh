#!/usr/bin/env bash
# Ralph loop: feed PROMPT.md to claude over and over.
# usage: ./ralph.sh [max_iterations]     (default: run forever)
# stop:  Ctrl+C, or the agent runs `touch RALPH_STOP`
set -uo pipefail

max="${1:-0}"   # 0 = forever
mkdir -p logs
log="logs/ralph-$(date +%Y%m%d).log"

for ((i = 1; max == 0 || i <= max; i++)); do
  if [[ -e RALPH_STOP ]]; then
    echo "ralph: RALPH_STOP found — exiting."
    rm -f RALPH_STOP
    break
  fi

  echo "ralph: iteration $i"
  claude -p < PROMPT.md 2>&1 | tee -a "$log"
  git pull --rebase --autostash || true
  sleep 5   # breather for rate limits and CI
done
