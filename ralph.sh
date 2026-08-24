#!/usr/bin/env bash
# Ralph loop: feed PROMPT.md to `claude` over and over, streaming each session to the terminal.
#
# usage:  ./ralph.sh [max_iterations]      # omitted or 0 = run until stopped
#         ./ralph.sh --help
#
# stop:   Ctrl+C, or `touch RALPH_STOP` (the agent does this when it runs out of work).
#         RALPH_STOP is never removed automatically — delete it to resume.
#
# Every iteration runs `claude --print --output-format stream-json`, which emits one JSON
# event per turn as it happens. Default `--output-format text` prints nothing until the
# session ends, which is why an unrendered loop looks frozen for minutes at a time.
#
# env knobs (all optional):
#   RALPH_PROMPT=PROMPT.md    prompt fed to every iteration
#   RALPH_MODEL=              --model for claude (empty = account default)
#   RALPH_PERMISSION_MODE=    --permission-mode (empty = CLI default; the effective mode is
#                             printed at the start of each session). For genuinely unattended
#                             runs use `bypassPermissions` — otherwise tool calls needing
#                             approval are auto-denied, since -p cannot answer a prompt.
#   RALPH_TIMEOUT=3600        per-iteration wall clock in seconds (0 = no limit)
#   RALPH_SLEEP=5             breather between iterations, seconds
#   RALPH_MAX_FAILURES=3      consecutive failed iterations before giving up
#   RALPH_MAX_COST_USD=0      stop once cumulative session cost exceeds this (0 = no cap)
#   RALPH_PULL=1              git pull --rebase --autostash between iterations
#   RALPH_ARGS=               extra arguments appended to the claude invocation

set -uo pipefail

if (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4) )); then
  echo "ralph: needs bash >= 4.4 (found ${BASH_VERSION})" >&2
  exit 1
fi

if [[ "${1-}" == -h || "${1-}" == --help ]]; then
  sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi

# Anchor everything to the repo the script lives in, so `logs/`, `RALPH_STOP` and the prompt
# resolve identically no matter where the loop was launched from.
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd -- "$here" || exit 1

max="${1:-0}"
prompt="${RALPH_PROMPT:-PROMPT.md}"
model="${RALPH_MODEL:-}"
perm="${RALPH_PERMISSION_MODE:-}"
timeout_s="${RALPH_TIMEOUT:-3600}"
sleep_s="${RALPH_SLEEP:-5}"
max_failures="${RALPH_MAX_FAILURES:-3}"
max_cost="${RALPH_MAX_COST_USD:-0}"
pull_enabled="${RALPH_PULL:-1}"
renderer="$here/ralph-render.jq"

if [[ -t 1 ]]; then
  C_0=$'\033[0m'; C_D=$'\033[2m'; C_R=$'\033[31m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_B=$'\033[1m'
  jq_color=true
else
  C_0=''; C_D=''; C_R=''; C_G=''; C_Y=''; C_B=''
  jq_color=false
fi

run_id="$(date -u +%Y%m%dT%H%M%SZ)"
run_dir="logs/$run_id"
mkdir -p "$run_dir"
ln -sfn "$run_id" logs/latest 2>/dev/null || true
run_log="$run_dir/run.log"

# Terminal gets colour, the log gets plain text.
say() {
  local msg="$1" color="${2-}"
  printf '%s%s%s\n' "$color" "$msg" "${color:+$C_0}"
  printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$msg" >>"$run_log"
}
die() { say "ralph: $1" "$C_R"; exit 1; }

# ── preflight ────────────────────────────────────────────────────────────────────────────
command -v claude >/dev/null 2>&1 || die "\`claude\` not found on PATH"
[[ -f "$prompt" ]] || die "prompt file not found: $here/$prompt"
git rev-parse --git-dir >/dev/null 2>&1 || die "not a git repository: $here"

have_jq=1
if ! command -v jq >/dev/null 2>&1; then
  have_jq=0
  say "ralph: jq not found — showing raw JSON events (install jq for readable output)" "$C_Y"
elif [[ ! -f "$renderer" ]]; then
  have_jq=0
  say "ralph: renderer missing ($renderer) — showing raw JSON events" "$C_Y"
fi

claude_cmd=()
(( timeout_s > 0 )) && claude_cmd+=(timeout -k 10 "$timeout_s")
claude_cmd+=(claude --print --output-format stream-json --verbose)
[[ -n "$model" ]] && claude_cmd+=(--model "$model")
[[ -n "$perm" ]] && claude_cmd+=(--permission-mode "$perm")
extra_args=()   # declare first: `read -a` leaves it unset on empty input under `set -u`
read -r -a extra_args <<<"${RALPH_ARGS:-}"
(( ${#extra_args[@]} )) && claude_cmd+=("${extra_args[@]}")

# ── signals ──────────────────────────────────────────────────────────────────────────────
interrupted=0
on_signal() {
  if (( interrupted )); then say "ralph: forced exit" "$C_Y"; exit 130; fi
  interrupted=1
  say "ralph: interrupt received — stopping (Ctrl+C again to force)" "$C_Y"
}
trap on_signal INT TERM

# ── helpers ──────────────────────────────────────────────────────────────────────────────
# A stop file is an operator brake as much as an agent one, so it is left in place.
stop_requested() {
  [[ -e RALPH_STOP ]] || return 1
  local why; why="$(tr -d '\r' <RALPH_STOP 2>/dev/null | head -c 500)"
  say "ralph: RALPH_STOP present — stopping.${why:+ reason: $why}" "$C_G"
  say "ralph: remove it to resume — rm $here/RALPH_STOP"
  return 0
}

# `main` here has no upstream; an unguarded pull fails every iteration and hides real errors.
maybe_pull() {
  (( pull_enabled )) || return 0
  git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1 || return 0
  git pull --rebase --autostash --quiet || say "ralph: git pull failed (continuing)" "$C_Y"
}

# Last `result` event of a session carries is_error / num_turns / duration / cost.
result_field() { # <raw-log> <jq-path> <default>
  local out
  out="$(jq -R -r "fromjson? | select(.type == \"result\") | $2 // empty" "$1" 2>/dev/null | tail -1)"
  printf '%s' "${out:-$3}"
}

add_usd() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.4f", a + b }'; }
over_budget() { awk -v t="$1" -v m="$2" 'BEGIN { exit !(m > 0 && t >= m) }'; }

run_iteration() { # <raw-log>
  local raw="$1"
  if (( have_jq )); then
    "${claude_cmd[@]}" <"$prompt" 2>&1 \
      | tee "$raw" \
      | jq -R --unbuffered -r --argjson color "$jq_color" -f "$renderer"
  else
    "${claude_cmd[@]}" <"$prompt" 2>&1 | tee "$raw"
  fi
  return "${PIPESTATUS[0]}"
}

# ── loop ─────────────────────────────────────────────────────────────────────────────────
say "ralph: run $run_id — prompt $prompt, log $run_dir$( (( max )) && echo ", max $max iterations")" "$C_B"

ok=0; failed=0; fails_in_a_row=0; total_cost=0; last=0; exit_code=0

for (( i = 1; max == 0 || i <= max; i++ )); do
  stop_requested && break
  (( interrupted )) && break

  last=$i
  raw="$run_dir/$(printf 'iter-%03d.jsonl' "$i")"
  printf '\n%s━━ iteration %d ━━ %s ━━%s\n' "$C_B" "$i" "$(date -u +%H:%M:%SZ)" "$C_0"
  printf '[%s] --- iteration %d ---\n' "$(date -u +%H:%M:%S)" "$i" >>"$run_log"

  run_iteration "$raw"
  status=$?

  cost="$(result_field "$raw" '.total_cost_usd' 0)"
  total_cost="$(add_usd "$total_cost" "$cost")"

  if (( status == 0 )) && [[ "$(result_field "$raw" '.is_error' false)" != true ]]; then
    (( ok++, fails_in_a_row = 0 ))
    say "ralph: iteration $i ok (session \$$cost, total \$$total_cost)" "$C_D"
  else
    (( failed++, fails_in_a_row++ ))
    if (( status == 124 || status == 137 )); then
      say "ralph: iteration $i timed out after ${timeout_s}s" "$C_R"
    else
      say "ralph: iteration $i failed (exit $status) — see $raw" "$C_R"
    fi
    if grep -qE 'authentication_failed|API key is invalid|invalid_api_key' "$raw" 2>/dev/null; then
      # Never interpolate the key itself — this message goes to the terminal and the log.
      if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
        say "ralph: authentication failed. ANTHROPIC_API_KEY is set and overrides your claude.ai login;" "$C_Y"
        say "ralph: either \`unset ANTHROPIC_API_KEY\` and \`claude /login\`, or export a valid key." "$C_Y"
      else
        say "ralph: authentication failed and no ANTHROPIC_API_KEY is set — run \`claude /login\`." "$C_Y"
      fi
    fi
    if (( fails_in_a_row >= max_failures )); then
      say "ralph: $fails_in_a_row consecutive failures — giving up." "$C_R"
      exit_code=1
      break
    fi
  fi

  stop_requested && break
  (( interrupted )) && break

  if over_budget "$total_cost" "$max_cost"; then
    say "ralph: cost cap reached (\$$total_cost >= \$$max_cost) — stopping." "$C_Y"
    break
  fi

  maybe_pull
  (( max != 0 && i >= max )) && break

  # Back off after failures so a systemic problem does not become a hot loop.
  delay=$sleep_s
  if (( fails_in_a_row > 0 )); then
    delay=$(( sleep_s * (1 << (fails_in_a_row - 1)) ))
    (( delay > 300 )) && delay=300
  fi
  (( delay > 0 )) && sleep "$delay"
  (( interrupted )) && break
done

say ""
say "ralph: done — $last iterations, $ok ok, $failed failed, \$$total_cost total. Log: $run_dir" "$C_B"
exit "$exit_code"
