#!/usr/bin/env bash
# End-to-end checks for `avo run` (S7b), against the real bin/avo, a real git repo, a real
# .avo/score and the real attempt log avo writes for ITSELF — but a stub agent, never a real agent
# CLI: CI has none, and a real one would make this suite non-deterministic and expensive.
# Writes evidence/s7b-e2e.txt.
set -uo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 1

evidence="$root/evidence/s7b-e2e.txt"
mkdir -p "$root/evidence"
: > "$evidence"

fails=0
say() { printf '%s\n' "$*" | tee -a "$evidence"; }
ok()   { say "PASS  $*"; }
bad()  { say "FAIL  $*"; fails=$((fails + 1)); }
yes_no() { if [[ $1 == 0 ]]; then ok "$2"; else bad "$3"; fi; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

avo() { "$root/bin/avo" "$@"; }

say "# avo S7b e2e — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "# node $(node --version), $(git --version), jq $(jq --version)"
say ""

# ------------------------------------------------- 0. a fixture repo with a stub agent and an f
# `scorer` picks which f the repo gets: 'improving' commits every turn, 'failing' never does.
make_repo() {
  local repo="$1" scorer="${2:-improving}"
  git init -q -b main "$repo"
  git -C "$repo" config user.email avo@example.com
  git -C "$repo" config user.name avo
  mkdir -p "$repo/.avo" "$repo/knowledge"
  printf '.avo/runs/\n.avo/worktrees/\n.avo/attempts.jsonl\nlast-prompt.txt\n' > "$repo/.gitignore"
  printf 'baseline\n' > "$repo/kernel.txt"
  printf -- '---\ntitle: warp specialization\n---\n\nA pingpong schedule across two warpgroups.\n' \
    > "$repo/knowledge/warp-specialization.md"

  cat > "$repo/stub.sh" <<'STUB'
#!/usr/bin/env bash
# A stand-in for a headless coding agent: it edits a file and exits, which is all `avo run` needs.
# Its behaviour is chosen by the prompt, so one stub covers every case.
prompt="$1"
printf '%s' "$prompt" > "$PWD/last-prompt.txt"
case "$prompt" in
  *noop*) echo "I considered it and changed nothing"; exit 0 ;;
  *slow*) sleep 30; exit 0 ;;
  # One second per turn, so a test that kills the loop mid-flight has something to interrupt.
  *paced*) sleep 1 ;;
esac
echo "line at iteration ${AVO_FAN_PROBE:-?}" >> kernel.txt
echo "appended one line at depth ${AVO_FAN_LEVEL:-?} of ${AVO_FAN_DEPTH:-?}"
STUB
  chmod +x "$repo/stub.sh"

  if [[ $scorer == failing ]]; then
    cat > "$repo/.avo/score" <<'SCORE'
#!/usr/bin/env bash
printf '{"ok":true,"correct":false,"primary":null,"unit":"lines","higher_is_better":true,"log":"assertion failed at kernel.txt:3"}\n'
SCORE
  else
    cat > "$repo/.avo/score" <<'SCORE'
#!/usr/bin/env bash
n=$(wc -l < kernel.txt | tr -d ' ')
printf '{"ok":true,"correct":true,"primary":%s,"unit":"lines","higher_is_better":true}\n' "$n"
SCORE
  fi
  chmod +x "$repo/.avo/score"

  jq -n --arg cmd "$repo/stub.sh" \
    '{agent:{name:"stub",command:$cmd,args:["{prompt}"],format:"text"}}' > "$repo/.avo/config.json"
  git -C "$repo" add -A
  git -C "$repo" commit -qm baseline
}

repo="$work/repo"
make_repo "$repo"
baseline="$(git -C "$repo" rev-parse HEAD)"
say "## 0. fixture"
ok "repo at HEAD $(echo "$baseline" | cut -c1-8), a stub agent and an f that counts lines"
say ""

# ------------------------------------------------- 1. --dry-run resolves everything, writes nothing
say "## 1. --dry-run"
before="$(git -C "$repo" status --porcelain)"
out="$(avo run --cwd "$repo" --agent stub --prompt "make kernel.txt longer" --max-iters 3 --dry-run 2>&1)"; code=$?
if [[ $code == 0 ]]; then ok "--dry-run exits 0"; else bad "--dry-run exit $code"; fi
printf '%s' "$out" | grep -q 'nothing is spawned, nothing is committed'
yes_no $? "it says plainly that it did nothing" "it does not say it is a dry run"
printf '%s' "$out" | grep -q 'up to 3'
yes_no $? "--max-iters 3 is reflected in the plan" "the iteration budget is not in the plan"
printf '%s' "$out" | grep -q 'stub.sh <prompt>'
yes_no $? "the resolved command line is shown with the prompt elided" "the command line is not shown"
printf '%s' "$out" | grep -q 'turn prompt (iteration 1)'
yes_no $? "the first turn prompt is shown verbatim" "the turn prompt is not shown"
printf '%s' "$out" | grep -q 'avo supervise'
yes_no $? "the plan names the supervise step and its thresholds" "the plan does not mention steering"
if [[ ! -e "$repo/.avo/runs" ]]; then ok 'no run directory was created'; else bad '.avo/runs exists after a dry run'; fi
if [[ ! -e "$repo/last-prompt.txt" ]]; then ok 'no agent was spawned'; else bad 'the agent ran during a dry run'; fi
# The gitignore is a write too. Dry-run must return before every write, not just the loud ones.
if [[ ! -e "$repo/.avo/.gitignore" ]]; then ok 'not even .avo/.gitignore was written'; else bad '--dry-run wrote .avo/.gitignore'; fi
if [[ "$(git -C "$repo" status --porcelain)" == "$before" ]]; then ok 'the working tree is byte-identical afterwards'; else bad '--dry-run changed the working tree'; fi
say ""

# ------------------------------------------------- 2. the loop
say "## 2. the loop: turn -> commit -> supervise -> repeat"
json="$(avo run --cwd "$repo" --agent stub --prompt "make kernel.txt longer" --max-iters 3 --json 2>/dev/null)"; code=$?
if [[ $code == 0 ]]; then ok "a productive loop exits 0"; else bad "exit $code on a loop that committed"; fi
printf '%s' "$json" | jq -e '.iterations | length == 3' >/dev/null
yes_no $? "three iterations ran" "the loop did not run three iterations"
printf '%s' "$json" | jq -e '.committed == [1,2,3]' >/dev/null
yes_no $? "each turn committed a version: v1, v2, v3" "the versions committed are not v1..v3"
printf '%s' "$json" | jq -e '.stopped == "max-iters"' >/dev/null
yes_no $? "it stopped because the budget ran out, not for another reason" "it stopped for the wrong reason"
printf '%s' "$json" | jq -e '.interventions == 0' >/dev/null
yes_no $? "a loop that is making progress is never steered" "a progressing loop was steered"

# The versions are real: written by avo commit, the only writer of a version (invariant 1).
avo lineage --cwd "$repo" --json | jq -e '[.[].version] == [1,2,3]' >/dev/null
yes_no $? "avo lineage reads back the three versions the loop committed" "the lineage does not hold the loop's versions"
git -C "$repo" log -1 --format=%B | grep -q 'Avo-Version: 3'
yes_no $? "v3's commit carries the Avo-Version trailer" "the commit has no version trailer"
git -C "$repo" log -1 --format=%B | grep -q 'appended one line at depth'
yes_no $? "the agent's own final message became the commit rationale" "the commit body has no rationale"
avo best --cwd "$repo" --json | jq -e '.version == 3 and .score.primary == 4' >/dev/null
yes_no $? "avo best names v3 at 4 lines" "avo best does not agree with the loop"
say ""

# ------------------------------------------------- 3. trajectory, not lineage
say "## 3. the run log is trajectory"
# The S3/S6/S7b self-perturbation trap: avo's own writes must never read as a variation, or the
# second run scores a change the agent never made.
! git -C "$repo" status --porcelain | grep -q '\.avo/runs'
yes_no $? ".avo/runs/ never shows up in git status" ".avo/runs/ dirties the working tree"
! git -C "$repo" log --stat --format= | grep -q '\.avo/runs'
yes_no $? "and it is in no commit the loop made" ".avo/runs was committed into a version"
grep -qx 'runs/' "$repo/.avo/.gitignore"
yes_no $? ".avo/.gitignore carries the entry" "runs/ is not ignored"

run_id="$(printf '%s' "$json" | jq -r .run_id)"
if [[ -f "$repo/.avo/runs/$run_id/manifest.json" ]]; then ok 'the run manifest is on disk'; else bad "no manifest at .avo/runs/$run_id/manifest.json"; fi
if [[ -f "$repo/.avo/runs/$run_id/logs/1.log" && -f "$repo/.avo/runs/$run_id/logs/3.log" ]]; then ok 'each turn'"'"'s raw agent output is on disk'; else bad 'the per-turn logs are missing'; fi
jq -e '.iterations | length == 3' "$repo/.avo/runs/$run_id/manifest.json" >/dev/null
yes_no $? "the manifest holds every iteration" "the manifest does not match the run"

# A pre-S7b repo: the gitignore avo wrote before .avo/runs/ existed must GAIN the entry, not be
# skipped because the file is already there.
old="$work/oldrepo"
make_repo "$old"
printf '# written by avo commit: trajectory, not lineage\nattempts.jsonl\nworktrees/\n' > "$old/.avo/.gitignore"
avo run --cwd "$old" --agent stub --prompt "make kernel.txt longer" --max-iters 1 >/dev/null 2>&1
grep -qx 'runs/' "$old/.avo/.gitignore"
yes_no $? "a repo that predates .avo/runs/ receives the entry on the next run" "an existing .avo/.gitignore never gains a new path"
grep -qx '# written by avo commit: trajectory, not lineage' "$old/.avo/.gitignore"
yes_no $? "and its original header is left exactly as it was" "the existing header was rewritten"
say ""

# ------------------------------------------------- 4. steering
say "## 4. the supervisor steers, and the directive reaches the agent"
steer="$work/steer"
make_repo "$steer" failing
json="$(avo run --cwd "$steer" --agent stub --prompt "fix the kernel" --max-iters 3 --stall 2 --thrash 2 --json 2>/dev/null)"
printf '%s' "$json" | jq -e '.committed == []' >/dev/null
yes_no $? "a failing f never yields a commit (invariant 2)" "a failing candidate was committed"
printf '%s' "$json" | jq -e '.interventions >= 1' >/dev/null
yes_no $? "past the threshold, the loop is steered" "the loop stalled without being steered"
printf '%s' "$json" | jq -e '[.iterations[].supervision.signals[].kind] | (index("stall") != null) and (index("thrash") != null)' >/dev/null
yes_no $? "both signals fire: not progressing AND failing the same way" "only one signal fired"

last="$(cat "$steer/last-prompt.txt")"
printf '%s' "$last" | grep -q 'fix the kernel'
yes_no $? "the operator's task survives every turn" "the task was lost when the directive was injected"
printf '%s' "$last" | grep -q 'STEERING (avo supervise)'
yes_no $? "the directive is INJECTED into the next turn, not merely reported" "the agent never saw the directive"
printf '%s' "$last" | grep -q 'Read the failure before editing again'
yes_no $? "a thrashing agent is told to re-diagnose, not to explore" "the thrash directive reads like the stall one"
if [[ "$(grep -c 'STEERING (avo supervise)' "$steer/last-prompt.txt")" == 1 ]]; then ok 'exactly one directive: a directive never quotes the previous directive'; else bad 'directives nest — the supervisor is quoting itself'; fi
! printf '%s' "$last" | grep -q 'avo-intervention-'
yes_no $? "and it never cites an intervention as if it were knowledge" "the directive cites the supervisor's own record"
printf '%s' "$last" | grep -q 'knowledge/warp-specialization.md'
yes_no $? "an unexplored doc in K is still cited on the LAST turn, not buried after the first" "the doc the supervisor recommended reads as explored"

# Every intervention is written down: the paper's long runs are only interpretable because they are.
key="$(printf '%s' "$json" | jq -r 'first(.iterations[] | select(.intervention != null) | .intervention.key)')"
grep -q "\"key\":\"$key\"" "$steer/lineage/memory.jsonl"
yes_no $? "the injected directive is recorded ($key)" "the intervention was never written down"
grep -q "\"kind\":\"intervention\"" "$steer/lineage/memory.jsonl"
yes_no $? "recorded as an intervention, not as an insight" "the intervention reads back as an insight"
avo mem --cwd "$steer" --json | jq -e '[.memories[] | select(.kind == "intervention")] | length >= 1' >/dev/null
yes_no $? "avo mem lists it, so a finished run can be audited" "avo mem cannot see the intervention"
# An insight would be injected at prime time; every future session would open with a stale directive.
! avo mem prime --cwd "$steer" | grep -q 'STEERING'
yes_no $? "but it does not prime a future session with a stale directive" "avo mem prime replays an old steering directive"
say ""

# ------------------------------------------------- 5. the stop conditions
say "## 5. stopping"
noop="$work/noop"
make_repo "$noop"
json="$(avo run --cwd "$noop" --agent stub --prompt "noop please" --max-iters 8 --json 2>/dev/null)"
printf '%s' "$json" | jq -e '.stopped == "no-progress" and (.iterations | length) == 3' >/dev/null
yes_no $? "an agent that changes nothing stops the loop after 3 turns, not after 8" "the loop spun on an idle agent"
if [[ ! -e "$noop/.avo/attempts.jsonl" ]]; then ok 'an unchanged tree is never scored, which is why the supervisor cannot see this case'; else bad 'an unchanged tree was scored'; fi

stop="$work/stop"
make_repo "$stop"
touch "$stop/.avo/STOP"
json="$(avo run --cwd "$stop" --agent stub --prompt "make kernel.txt longer" --max-iters 5 --json 2>/dev/null)"; code=$?
printf '%s' "$json" | jq -e '.stopped == "stop-file" and (.iterations | length) == 0' >/dev/null
yes_no $? ".avo/STOP halts the loop before the first turn is spawned" ".avo/STOP did not stop the loop"
if [[ $code == 1 ]]; then ok "a loop that never ran a turn exits 1"; else bad "exit $code for a loop that did nothing"; fi
if [[ "$(git -C "$stop" log --format=%s | wc -l)" == 1 ]]; then ok 'and nothing was committed'; else bad 'a stopped loop still committed'; fi

# Mid-flight: the sentinel an agent (or an operator) drops between turns.
rm "$stop/.avo/STOP"
( sleep 1; touch "$stop/.avo/STOP" ) &
json="$(avo run --cwd "$stop" --agent stub --prompt "make kernel.txt longer" --max-iters 50 --json 2>/dev/null)"
wait
n="$(printf '%s' "$json" | jq -r '.iterations | length')"
if [[ "$(printf '%s' "$json" | jq -r .stopped)" == "stop-file" && $n -lt 50 ]]; then
  ok "a STOP file dropped mid-run halts it after $n of 50 iterations"
else
  bad "a mid-run STOP file did not halt the loop (stopped=$(printf '%s' "$json" | jq -r .stopped), $n iterations)"
fi

missing="$work/missing"
make_repo "$missing"
jq -n --arg cmd "$missing/not-a-binary" \
  '{agent:{name:"stub",command:$cmd,args:["{prompt}"],format:"text"}}' > "$missing/.avo/config.json"
json="$(avo run --cwd "$missing" --agent stub --prompt "go" --max-iters 5 --json 2>/dev/null)"; code=$?
printf '%s' "$json" | jq -e '.stopped == "agent-unavailable" and (.iterations | length) == 1' >/dev/null
yes_no $? "an agent binary that cannot be started stops the loop after one try, not five" "a missing binary was retried"
if [[ $code == 1 ]]; then ok "and it exits 1"; else bad "exit $code for a loop that could not start its agent"; fi

slow="$work/slow"
make_repo "$slow"
start=$(date +%s)
json="$(avo run --cwd "$slow" --agent stub --prompt "slow" --max-iters 1 --timeout 2 --json 2>/dev/null)"
elapsed=$(( $(date +%s) - start ))
printf '%s' "$json" | jq -e '.iterations[0].agent.timed_out == true' >/dev/null
yes_no $? "a turn past its --timeout is killed" "the slow turn was not timed out"
if [[ $elapsed -lt 20 ]]; then ok "a 30s turn under --timeout 2 returned in ${elapsed}s"; else bad "the timeout did not take effect (${elapsed}s)"; fi
say ""

# ------------------------------------------------- 6. crash safety
say "## 6. crash safety: the manifest is rewritten after EVERY iteration"
crash="$work/crash"
make_repo "$crash"
avo run --cwd "$crash" --agent stub --prompt "make kernel.txt longer, paced" --max-iters 30 >/dev/null 2>&1 &
loop_pid=$!
sleep 4
kill -9 "$loop_pid" 2>/dev/null
wait "$loop_pid" 2>/dev/null
mf="$(find "$crash/.avo/runs" -name manifest.json | head -1)"
if [[ -n $mf ]]; then ok 'a killed run left a manifest behind'; else bad 'the kill lost the whole run'; fi
done_iters="$(jq -r '.iterations | length' "$mf")"
if [[ ${done_iters:-0} -ge 1 ]]; then
  ok "it holds the $done_iters iteration(s) that finished before the kill"
else
  bad "the manifest holds no finished iterations"
fi
jq -e '.finished_at == null' "$mf" >/dev/null
yes_no $? "and it is still open, so a reader can tell the run did not end" "a killed run reads as finished"
committed="$(git -C "$crash" log --format=%s | grep -c '^avo v' || true)"
if [[ ${committed:-0} == "${done_iters:-0}" ]]; then
  ok "every finished iteration's version survived the kill ($committed committed)"
else
  bad "the manifest claims $done_iters iterations but git holds $committed versions"
fi
say ""

# ------------------------------------------------- 7. guards
say "## 7. the guards, since a turn is an agent that can call avo run"
guard="$work/guard"
make_repo "$guard"
out="$(AVO_FAN_LEVEL=3 AVO_FAN_DEPTH=3 avo run --cwd "$guard" --agent stub --prompt "go" --max-iters 1 2>&1)"; code=$?
if [[ $code == 1 ]]; then ok "a run at the depth limit is refused (exit 1)"; else bad "exit $code at the depth limit"; fi
printf '%s' "$out" | grep -q 'depth limit reached'
yes_no $? "and it says which limit and how to raise it" "the refusal does not name the limit"
if [[ ! -e "$guard/.avo/runs" ]]; then ok 'a refused run creates nothing'; else bad 'a refused run left a run directory'; fi

sha="$(avo run --cwd "$guard" --agent stub --prompt "go" --max-iters 1 --dry-run --json 2>/dev/null | jq -r .prompt_sha)"
out="$(AVO_FAN_CHAIN="$sha" avo run --cwd "$guard" --agent stub --prompt "go" --max-iters 1 2>&1)"; code=$?
if [[ $code == 1 ]]; then ok "the same prompt already running higher up is refused as a cycle"; else bad "exit $code on a cycle"; fi
printf '%s' "$out" | grep -q 'cycle'
yes_no $? "and the refusal says so" "the cycle refusal does not say cycle"

# The guard state has to reach the agent itself, or a nested run would not know how deep it is.
avo run --cwd "$guard" --agent stub --prompt "make kernel.txt longer" --max-iters 1 >/dev/null 2>&1
git -C "$guard" log -1 --format=%B | grep -q 'at depth 1 of 3'
yes_no $? "the turn runs one level deeper than its parent, and knows the cap" "the guard environment did not reach the agent"
say ""

# ------------------------------------------------- 8. idempotency and the agent contract
say "## 8. --json, and re-running"
head_before="$(git -C "$repo" rev-parse HEAD)"
avo run --cwd "$repo" --agent stub --prompt "make kernel.txt longer" --max-iters 2 --json >/dev/null 2>&1
! git -C "$repo" status --porcelain | grep -v 'lineage/memory.jsonl' | grep -q .
yes_no $? "a second run leaves no stray change behind" "a second run dirtied the tree"
if [[ "$(git -C "$repo" rev-parse HEAD)" != "$head_before" ]]; then ok 'it kept evolving from where the first run stopped'; else bad 'the second run committed nothing'; fi
if [[ "$(find "$repo/.avo/runs" -maxdepth 1 -mindepth 1 -type d | wc -l)" == 2 ]]; then ok 'each run gets its own directory; the first one is not overwritten'; else bad 'the second run reused the first run'"'"'s directory'; fi

json="$(avo run --cwd "$repo" --agent stub --prompt "make kernel.txt longer" --max-iters 1 --json 2>/dev/null)"
printf '%s' "$json" | jq -e '
  (.ok | type) == "boolean"
  and (.run_id | type) == "string"
  and (.stopped | type) == "string"
  and (.committed | type) == "array"
  and (.thresholds.stall | type) == "number"
  and (.iterations[0] | has("agent") and has("decision") and has("supervision") and has("head_before") and has("head_after") and has("agent_versions"))
  and (.iterations[0].agent | has("wall_s") and has("ok") and has("error"))
' >/dev/null
yes_no $? "one JSON object, every field typed as documented" "the --json shape is not what an agent is told to expect"
printf '%s' "$json" | head -c 1 | grep -q '{'
yes_no $? "it is a single JSON object on stdout" "stdout is not JSON"
say ""

# ------------------------------------------------- 9. the cost of the inner loop (#8)
say "## 9. #8 measured: readLineage runs once per iteration now"
bench="$work/bench"
git init -q -b main "$bench"
git -C "$bench" config user.email avo@example.com
git -C "$bench" config user.name avo
printf 'x\n' > "$bench/f.txt"
git -C "$bench" add -A
for i in $(seq 1 2000); do git -C "$bench" commit -q --allow-empty -m "c$i"; done
start=$(date +%s%N)
git -C "$bench" log --format='%H%x1f%aI%x1f%B%x1e' HEAD > /dev/null
ms=$(( ($(date +%s%N) - start) / 1000000 ))
say "      2000 commits: the git log readLineage runs took ${ms}ms"
if [[ $ms -lt 500 ]]; then
  ok "#8 is not a problem for the inner loop: an agent turn costs seconds to minutes, this costs ${ms}ms"
else
  bad "readLineage costs ${ms}ms at 2000 commits — too much to call every iteration"
fi
say ""

# --------------------------------------- 10. the agent commits for itself (#42), against real avo
say "## 10. #42: an agent that runs avo commit itself"
# This is what the avo-vary skill tells an agent to do, so it is the normal case in a real run: by
# the time the loop's own step 2 looks, the tree is clean and every iteration decides `noop`. The
# manifest has to say the run produced a curve anyway, or a working loop reads as a flat one.
self="$work/selfcommit"
make_repo "$self"
cat > "$self/stub.sh" <<STUB
#!/usr/bin/env bash
printf '%s' "\$1" > "\$PWD/last-prompt.txt"
echo "line at iteration \${AVO_FAN_PROBE:-?}" >> kernel.txt
"$root/bin/avo" commit --why "I measured it and committed this myself" >/dev/null 2>&1
echo "I ran avo commit myself"
STUB
chmod +x "$self/stub.sh"

json="$(avo run --cwd "$self" --agent stub --prompt "make kernel.txt longer" --max-iters 3 --json 2>/dev/null)"
printf '%s' "$json" | jq -e '[.iterations[].decision.action] == ["noop","noop","noop"]' >/dev/null
yes_no $? "every iteration decides noop — the tree really was clean" "the harness committed; this is not the case #42 is about"
printf '%s' "$json" | jq -e '.committed == [1,2,3]' >/dev/null
yes_no $? "and the run still reports v1, v2, v3 as its output" "the manifest under-reports an agent that commits for itself (#42)"
printf '%s' "$json" | jq -e '[.iterations[].agent_versions | length] == [1,1,1]' >/dev/null
yes_no $? "each iteration is credited with the version it committed" "agent_versions does not attribute the versions to their turns"
printf '%s' "$json" | jq -e '[.iterations[].agent_versions[0].why] | all(test("committed this myself"))' >/dev/null
yes_no $? "the rationale recorded is the agent's own --why, not the harness's" "the agent's --why is not in the manifest"
printf '%s' "$json" | jq -e '[.iterations[] | .agent_versions[0].sha == .head_after] | all' >/dev/null
yes_no $? "each version is the head its turn left behind" "a version is attributed to the wrong iteration"
avo lineage --cwd "$self" --json | jq -e '[.[].version] == [1,2,3]' >/dev/null
yes_no $? "git agrees: three versions, written by the one writer that may write them" "the lineage does not hold three versions"
printf '%s' "$json" | jq -e '.stopped == "max-iters"' >/dev/null
yes_no $? "three self-committing turns never look like three idle ones (#29)" "a working loop was stopped for no progress"
avo run --cwd "$self" --agent stub --prompt "make kernel.txt longer" --max-iters 1 2>/dev/null | grep -q 'by the agent itself'
yes_no $? "the human rendering says so too" "renderRun does not distinguish an agent's own commits"
say ""

say "## summary"
if [[ $fails == 0 ]]; then
  say "all checks passed ($(grep -c '^PASS' "$evidence") of them)"
else
  say "$fails check(s) FAILED"
fi
exit "$((fails > 0))"
