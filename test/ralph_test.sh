#!/usr/bin/env bash
# Exercises ralph.sh's control flow against a stub `claude`, so the loop can be verified
# without spending API calls.  usage: ./test/ralph_test.sh
set -uo pipefail

src="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

pass=0; fail=0
check() { # <name> <expected-substring> <actual>
  if [[ "$3" == *"$2"* ]]; then printf 'ok   %s\n' "$1"; (( pass++ ))
  else printf 'FAIL %s\n       want substring: %s\n       got: %s\n' "$1" "$2" "$3"; (( fail++ )); fi
}

# A throwaway repo so tests never write logs or RALPH_STOP into the real one.
repo="$work/repo"; mkdir -p "$repo/test"
cp "$src/ralph.sh" "$src/ralph-render.jq" "$repo/"
cp "$src/test/stream.jsonl" "$repo/test/"
printf 'do one unit of work\n' >"$repo/PROMPT.md"
git -C "$repo" init -q && git -C "$repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

# Stub claude: replays the fixture a line at a time, honouring STUB_EXIT / STUB_SLEEP.
bin="$work/bin"; mkdir -p "$bin"
cat >"$bin/claude" <<'STUB'
#!/usr/bin/env bash
cat >/dev/null                      # drain the prompt on stdin, as `claude -p` does
echo "⚠ a warning on stderr" >&2
[[ -n "${STUB_ECHO_ARGV:-}" ]] && echo "argv: $*" >&2
if [[ -n "${STUB_AUTH_FAIL:-}" ]]; then
  echo '{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"error_status":401,"error":"authentication_failed"}'
  exit "${STUB_EXIT:-1}"
fi
while IFS= read -r line; do [[ "$line" == '{'* ]] && printf '%s\n' "$line"; done <test/stream.jsonl
sleep "${STUB_SLEEP:-0}"
exit "${STUB_EXIT:-0}"
STUB
chmod +x "$bin/claude"
export PATH="$bin:$PATH"

cd "$repo" || exit 1
run() { RALPH_SLEEP=0 RALPH_PULL=0 "$@" ./ralph.sh "${ITER:-1}" 2>&1; }

out="$(run env)"
check "happy path reports success"   "1 iterations, 1 ok, 0 failed" "$out"
check "streams tool calls"           "→ Bash"                       "$out"
check "surfaces tool failures"       "recipe \`test\` not found"    "$out"
check "accumulates cost"             "0.4173"                       "$out"
check "passes stderr through"        "a warning on stderr"          "$out"

out="$(ITER=3 run env)"
check "runs N iterations"            "3 iterations, 3 ok"           "$out"
check "writes per-iteration logs"    "iter-003"                     "$(ls logs/latest)"

out="$(ITER=10 run env STUB_EXIT=1 RALPH_MAX_FAILURES=3)"
check "stops after max failures"     "3 consecutive failures"       "$out"
check "does not spin past the cap"   "3 iterations, 0 ok, 3 failed" "$out"
check "failure exit code is 1"       "1"                            "$(ITER=10 run env STUB_EXIT=1 RALPH_MAX_FAILURES=2 >/dev/null; echo $?)"

out="$(ITER=10 run env RALPH_MAX_COST_USD=0.5)"
check "honours cost cap"             "cost cap reached"             "$out"

# The auth hint prints next to a live credential; it must never interpolate it.
out="$(ITER=1 run env STUB_EXIT=1 STUB_AUTH_FAIL=1 ANTHROPIC_API_KEY=sk-ant-SENTINEL-do-not-print)"
check "explains auth failure"        "overrides your claude.ai login" "$out"
if [[ "$out" != *SENTINEL* ]]; then printf 'ok   %s\n' "never echoes the API key"; (( pass++ ))
else printf 'FAIL %s — key leaked to output\n' "never echoes the API key"; (( fail++ )); fi
out="$(ITER=1 run env STUB_EXIT=1 STUB_AUTH_FAIL=1 ANTHROPIC_API_KEY=)"
check "auth hint without a key set"  "no ANTHROPIC_API_KEY is set"  "$out"

: >RALPH_STOP; printf 'no work left\n' >RALPH_STOP
out="$(run env)"
check "honours RALPH_STOP"           "RALPH_STOP present"           "$out"
check "reports the stop reason"      "no work left"                 "$out"
check "leaves RALPH_STOP in place"   "no work left"                 "$(cat RALPH_STOP)"
rm -f RALPH_STOP

out="$(ITER=1 run env STUB_SLEEP=5 RALPH_TIMEOUT=1)"
check "enforces per-iteration timeout" "timed out after 1s"         "$out"

out="$(RALPH_PROMPT=nope.md run env)"
check "preflight catches missing prompt" "prompt file not found"    "$out"

out="$(run env RALPH_ARGS='--add-dir /tmp --effort low' STUB_ECHO_ARGV=1)"
check "threads RALPH_ARGS through"   "--add-dir /tmp --effort low"   "$out"

out="$(./ralph.sh --help 2>&1)"
check "--help prints usage"          "max_iterations"               "$out"

# Runs from any cwd: paths anchor to the script's directory, not $PWD.
out="$(cd / && RALPH_SLEEP=0 RALPH_PULL=0 "$repo/ralph.sh" 1 2>&1)"
check "runs from another cwd"        "1 ok, 0 failed"               "$out"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
(( fail == 0 ))
