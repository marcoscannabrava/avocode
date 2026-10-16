#!/usr/bin/env bash
# Real-agent smoke test (#19, #23): one real turn per agent CLI on PATH, against a tiny throwaway
# target. It spends tokens, so it is opt-in and never part of `just e2e` or CI — run it nightly.
#
#   ./test/smoke-agents.sh                 # every agent on PATH
#   ./test/smoke-agents.sh claude          # only these agents
#
# Env: AVO_SMOKE_TIMEOUT (seconds per turn, default 180) and AVO_SMOKE_MODEL_<AGENT> (the model;
# claude defaults to haiku, pi and codex to their own default). An agent not on PATH is a SKIP.
# On a failure the temp targets are kept for a post-mortem. Writes evidence/smoke-agents.txt.
set -uo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 1

if [[ -n ${CI:-} && -z ${AVO_SMOKE_IN_CI:-} ]]; then
  echo "smoke-agents: CI detected, not run (set AVO_SMOKE_IN_CI=1)"
  exit 0
fi

evidence="$root/evidence/smoke-agents.txt"
mkdir -p "$root/evidence"
: > "$evidence"

fails=0
say() { printf '%s\n' "$*" | tee -a "$evidence"; }
ok()   { say "PASS  $*"; }
bad()  { say "FAIL  $*"; fails=$((fails + 1)); }
skip() { say "SKIP  $*"; }
yes_no() { if [[ $1 == 0 ]]; then ok "$2"; else bad "$3"; fi; }

timeout_s="${AVO_SMOKE_TIMEOUT:-180}"
agents=("$@")
[[ ${#agents[@]} -gt 0 ]] || agents=(pi claude codex)

work="$(mktemp -d)"
# Keep the evidence when something failed.
trap 'if [[ $fails == 0 ]]; then rm -rf "$work"; else say "# kept: $work"; fi' EXIT

# Logs every avo call the agent makes.
mkdir -p "$work/bin"
cat > "$work/bin/avo" <<SHIM
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "\$PWD/.avo/calls.log" 2>/dev/null
exec "$root/bin/avo" "\$@"
SHIM
chmod +x "$work/bin/avo"
export PATH="$work/bin:$PATH"
# A nightly run has no parent session.
unset CLAUDECODE CLAUDE_PID CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_CHILD_SESSION \
  CLAUDE_CODE_SESSION_ID CLAUDE_CODE_SESSION_ATTENDED CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN
# Our own calls bypass the shim.
avo() { "$root/bin/avo" "$@"; }

say "# avo real-agent smoke — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "# node $(node --version), $(git --version), timeout ${timeout_s}s per turn"
say ""

# A tiny target: f counts lines in notes.txt.
make_target() {
  local repo="$1"
  git init -q -b main "$repo"
  git -C "$repo" config user.email avo@example.com
  git -C "$repo" config user.name avo
  mkdir -p "$repo/.avo"
  printf '.avo/runs/\n.avo/worktrees/\n.avo/attempts.jsonl\n.avo/calls.log\n' > "$repo/.gitignore"
  printf 'one\n' > "$repo/notes.txt"
  cat > "$repo/.avo/score" <<'SCORE'
#!/usr/bin/env bash
n=$(grep -c . notes.txt)
printf '{"ok":true,"correct":true,"primary":%s,"unit":"lines","higher_is_better":true}\n' "$n"
SCORE
  chmod +x "$repo/.avo/score"
  git -C "$repo" add -A
  git -C "$repo" commit -qm baseline
}

# Model per agent, overridable by env.
model_for() {
  local var="AVO_SMOKE_MODEL_${1^^}"
  if [[ -n ${!var:-} ]]; then printf '%s' "${!var}"
  elif [[ $1 == claude ]]; then printf 'haiku'
  fi
}

# Names no avo command: the skills must.
prompt="Add one line to notes.txt to raise this repo's score. Record the result the way this repo's instructions and skills require, then stop."

for agent in "${agents[@]}"; do
  say "## $agent"
  if ! command -v "$agent" >/dev/null 2>&1; then skip "$agent is not on PATH"; say ""; continue; fi
  say "# $agent $("$agent" --version 2>/dev/null | head -1)"

  repo="$work/$agent"
  make_target "$repo"
  if avo install --cwd "$repo" --agent "$agent" >/dev/null 2>&1; then ok "avo install --agent $agent"; else bad "avo install --agent $agent failed"; say ""; continue; fi
  # Install output joins the baseline (#32).
  git -C "$repo" add -A && git -C "$repo" commit -qm "avo install"

  model="$(model_for "$agent")"
  margs=(); [[ -z $model ]] || margs=(--model "$model")
  say "# model: ${model:-agent default}"
  json="$(avo run --cwd "$repo" --agent "$agent" "${margs[@]}" --prompt "$prompt" \
    --max-iters 1 --timeout "$timeout_s" --json 2>"$work/$agent.err")"
  code=$?
  printf '%s' "$json" > "$work/$agent.json"
  if printf '%s' "$json" | jq -e '.iterations | length == 1' >/dev/null 2>&1; then
    ok "avo run finished one turn (exit $code)"
  else
    bad "avo run produced no turn (exit $code): $(tail -1 "$work/$agent.err")"
    say ""; continue
  fi
  err="$(jq -r '.iterations[0].agent.error // empty' <<<"$json")"
  if [[ -z $err ]]; then ok "the agent exited cleanly"; else bad "agent error: $err"; fi

  say "# summary: $(jq -r '.iterations[0].agent.summary // "none"' <<<"$json" | head -c 300 | tr '\n' ' ')"
  log="$(jq -r '.iterations[0].log_path' <<<"$json")"
  [[ $log == /* ]] || log="$repo/$log"
  # Claude lists the skills it found.
  listed="$(grep -m1 '"subtype":"init"' "$log" 2>/dev/null | jq -r '.skills // [] | map(select(startswith("avo"))) | join(" ")' 2>/dev/null)"
  [[ -z $listed ]] || say "# skills the agent listed: $listed"

  # Skills loaded: the agent called avo itself.
  calls="$(cut -d' ' -f1 "$repo/.avo/calls.log" 2>/dev/null | sort -u | sed 's/^/avo /' | tr '\n' ' ')"
  [[ -n $calls ]] || calls="$(grep -oE '"command":"[^"]*\bavo (score|commit|best|mem|lineage|know)|"(name|toolName)":"avo_[a-z_]+"' "$log" 2>/dev/null \
    | grep -oE 'avo[ _][a-z_]+' | sort -u | tr '\n' ' ')"
  if [[ -n $calls ]]; then ok "the agent called avo: $calls"; else bad "the agent never called avo; skills likely not loaded"; fi

  # A denied tool means the approval flag broke (#23).
  denied="$(grep -m1 '"type":"result"' "$log" 2>/dev/null | jq -r '.permission_denials // [] | map(.tool_name) | join(" ")' 2>/dev/null)"
  if [[ -z $denied ]]; then ok "no tool call was denied"; else bad "tool calls denied: $denied"; fi

  # A version or a refusal is on record.
  outcome="$(jq -r '[([(.committed | length), (.iterations[0].agent_versions | length)] | max), (.iterations[0].decision.action // "none")] | @tsv' <<<"$json")"
  read -r versions action <<<"$outcome"
  attempts=0; [[ -f $repo/.avo/attempts.jsonl ]] && attempts="$(wc -l < "$repo/.avo/attempts.jsonl" | tr -d ' ')"
  if (( versions > 0 )) || [[ $action == refused ]]; then
    ok "recorded: $versions version(s), decision $action, $attempts attempt(s)"
  else
    bad "no version or refusal recorded (decision $action)"
  fi

  # Tokens parsed from the agent's output.
  jq -e '(.tokens.input + .tokens.output + .tokens.cache_read) > 0' >/dev/null <<<"$json"
  yes_no $? "tokens parsed: $(jq -c '.tokens' <<<"$json"), cost $(jq -r '.cost_usd // "n/a"' <<<"$json")" \
    "no tokens parsed from $agent output"
  say ""
done

if [[ $fails == 0 ]]; then say "smoke: all passed"; else say "smoke: $fails failed"; fi
exit $((fails > 0))
