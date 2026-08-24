#!/usr/bin/env bash
# End-to-end checks for `avo fan` (S6), against the real bin/avo, real git worktrees and a real
# child process — but a stub agent, never a real agent CLI: CI has none, and a real one would make
# this suite non-deterministic and expensive. Writes evidence/s6-e2e.txt.
set -uo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 1

evidence="$root/evidence/s6-e2e.txt"
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
repo="$work/repo"

say "# avo S6 e2e — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "# node $(node --version), $(git --version), jq $(jq --version)"
say ""

# ------------------------------------------------- 0. a fixture repo with a stub agent and an f
git init -q -b main "$repo"
git -C "$repo" config user.email avo@example.com
git -C "$repo" config user.name avo
mkdir -p "$repo/.avo"
printf '.avo/worktrees/\n.avo/attempts.jsonl\n' > "$repo/.gitignore"
printf 'baseline\n' > "$repo/kernel.txt"

cat > "$repo/stub.sh" <<'STUB'
#!/usr/bin/env bash
prompt="$1"
case "$prompt" in
  *noop*) echo "considered it, changed nothing"; exit 0 ;;
  *slow*) sleep 60; exit 0 ;;
esac
for ((k = 0; k < ${AVO_FAN_PROBE:-1}; k++)); do echo "probe ${AVO_FAN_PROBE} line $k" >> kernel.txt; done
echo "appended ${AVO_FAN_PROBE} line(s) at depth ${AVO_FAN_LEVEL} of ${AVO_FAN_DEPTH}"
STUB
chmod +x "$repo/stub.sh"

cat > "$repo/.avo/score" <<'SCORE'
#!/usr/bin/env bash
n=$(wc -l < kernel.txt | tr -d ' ')
printf '{"ok":true,"correct":true,"primary":%s,"unit":"lines","higher_is_better":true}\n' "$n"
SCORE
chmod +x "$repo/.avo/score"

jq -n --arg cmd "$repo/stub.sh" \
  '{agent:{name:"stub",command:$cmd,args:["{prompt}"],format:"text"}}' > "$repo/.avo/config.json"
git -C "$repo" add -A
git -C "$repo" commit -qm baseline
baseline="$(git -C "$repo" rev-parse HEAD)"
worktrees() { git -C "$repo" worktree list | wc -l | tr -d ' '; }
base_wt="$(worktrees)"

say "## 0. fixture"
ok "repo at HEAD $(echo "$baseline" | cut -c1-8), git worktree list has $base_wt entry"
say ""

# ------------------------------------------------- 1. the skill ships with the command
say "## 1. the avo-fanout skill"
skill="$root/.agents/skills/avo-fanout/SKILL.md"
if [[ -f $skill ]]; then ok "avo-fanout/SKILL.md exists"; else bad "avo-fanout/SKILL.md is missing"; fi
head -1 "$skill" | grep -qx -- '---'
yes_no $? "it opens with a frontmatter fence" "it does not open with '---'"
name="$(awk 'NR>1 && /^---/{exit} /^name:/{sub(/^name:[[:space:]]*/,""); print; exit}' "$skill")"
if [[ $name == avo-fanout ]]; then ok "name matches its directory"; else bad "name '$name' != avo-fanout"; fi
grep -q 'AVO_PROBE_MODEL' "$skill"
yes_no $? "it documents the small-model policy" "it never mentions AVO_PROBE_MODEL"
grep -q 'AVO_FAN_DEPTH' "$skill"
yes_no $? "it documents the depth guard" "it never mentions AVO_FAN_DEPTH"
# A skill must not instruct a command that does not exist — the reason this one waited for S6.
usage="$(avo help)"
for c in "--promote" "--resume" "--clean" "--list" "AVO_FAN_DEPTH" "AVO_PROBE_MODEL"; do
  printf '%s' "$usage" | grep -q -- "$c"
  yes_no $? "avo help documents $c" "avo help never mentions $c"
done
say ""

# ------------------------------------------------- 2. four parallel probes
say "## 2. four probes in parallel worktrees"
out="$(avo fan --n 4 --prompt 'vary the kernel' --json --cwd "$repo")"
rc=$?
yes_no $rc "avo fan exited 0" "avo fan exited $rc"
echo "$out" | jq -e '.results | length == 4' >/dev/null
yes_no $? "all four probes returned a result" "expected 4 results, got $(echo "$out" | jq '.results | length')"
run_id="$(echo "$out" | jq -r .run_id)"
ok "run id $run_id"
echo "$out" | jq -e 'all(.results[]; .ok)' >/dev/null
yes_no $? "every probe process finished ok" "a probe did not finish: $(echo "$out" | jq -c '[.results[] | select(.ok|not) | .error]')"
echo "$out" | jq -e 'all(.results[]; .score.pass)' >/dev/null
yes_no $? "every probe was scored by .avo/score and passed" "a probe did not score"
echo "$out" | jq -e '[.results[] | .score.primary] == [2,3,4,5]' >/dev/null
yes_no $? "each probe scored its own diff (2,3,4,5 lines)" "scores were $(echo "$out" | jq -c '[.results[].score.primary]')"
echo "$out" | jq -e '.best == 4' >/dev/null
yes_no $? "best names the highest-scoring passing probe" "best was $(echo "$out" | jq .best)"
echo "$out" | jq -e 'all(.results[]; .diffstat.changed == ["kernel.txt"])' >/dev/null
yes_no $? "every diffstat names the file that changed" "a diffstat is wrong"
echo "$out" | jq -e 'all(.results[]; .summary | test("at depth 1 of 3"))' >/dev/null
yes_no $? "the guard environment reached every agent process" "AVO_FAN_LEVEL/DEPTH did not reach the agent"
if [[ "$(worktrees)" == "$((base_wt + 4))" ]]; then ok "git worktree list has 4 new entries"; else bad "expected $((base_wt + 4)) worktrees, found $(worktrees)"; fi

# The candidate never touched the repo the operator is looking at (invariant 7).
if [[ "$(cat "$repo/kernel.txt")" == "baseline" ]]; then ok "the root working tree is untouched"; else bad "avo fan wrote outside its worktrees"; fi
if [[ "$(git -C "$repo" rev-parse HEAD)" == "$baseline" ]]; then ok "HEAD did not move"; else bad "HEAD moved"; fi

log="$(echo "$out" | jq -r '.results[0].log_path')"
grep -q 'appended 1 line' "$repo/$log"
yes_no $? "the full probe output is on disk at $log" "no probe log at $log"
jq -e '.version == 1 and (.probes | length == 4)' "$repo/.avo/worktrees/$run_id/manifest.json" >/dev/null
yes_no $? "the run manifest survived the run" "no usable manifest"
say ""

# ------------------------------------------------- 3. promote, then score, then commit
say "## 3. promote"
p="$(avo fan --promote 3 --run "$run_id" --json --cwd "$repo")"
echo "$p" | jq -e '.ok and .applied == "clean" and (.files == ["kernel.txt"])' >/dev/null
yes_no $? "probe 3 promoted cleanly" "promote said $(echo "$p" | jq -c '{ok,applied,error}')"
grep -q 'probe 3 line 2' "$repo/kernel.txt"
yes_no $? "probe 3's work is now in the working tree" "the promoted diff is not in kernel.txt"
if grep -q 'probe 1 line' "$repo/kernel.txt"; then bad "another probe's work came across too"; else ok "only the chosen probe's work came across"; fi
if [[ "$(git -C "$repo" rev-parse HEAD)" == "$baseline" ]]; then ok "promote did not commit — avo commit is the only writer of a version"; else bad "promote created a commit"; fi
patch="$(echo "$p" | jq -r .patch)"
if [[ -f "$repo/$patch" ]]; then ok "the patch is kept as evidence at $patch"; else bad "no patch at $patch"; fi
# The point of promoting: the promoted candidate is now scorable in the real tree.
s="$(avo score --json --no-record --cwd "$repo")"
echo "$s" | jq -e '.pass and .primary == 4' >/dev/null
yes_no $? "the promoted candidate scores 4 in the real tree" "avo score said $(echo "$s" | jq -c '{pass,primary}')"
git -C "$repo" checkout -q -- kernel.txt
say ""

# ------------------------------------------------- 4. cleanup returns git to baseline
say "## 4. cleanup"
avo fan --clean "$run_id" --json --cwd "$repo" >/dev/null
if [[ "$(worktrees)" == "$base_wt" ]]; then ok "git worktree list is back to baseline"; else bad "expected $base_wt worktrees, found $(worktrees)"; fi
if [[ -d "$repo/.avo/worktrees/$run_id" ]]; then bad "the run directory survived --clean"; else ok "the run directory is gone"; fi
avo fan --list --json --cwd "$repo" | jq -e '.runs | length == 0' >/dev/null
yes_no $? "avo fan --list reports no runs" "--list still reports a run"
say ""

# ------------------------------------------------- 5. an unchanged worktree cleans itself up
say "## 5. a probe that changed nothing"
out="$(avo fan --n 2 --prompt 'noop please' --json --cwd "$repo")"
echo "$out" | jq -e '(.removed | length) == 2 and (.kept | length) == 0' >/dev/null
yes_no $? "both empty worktrees were removed automatically" "removed=$(echo "$out" | jq -c .removed)"
if [[ "$(worktrees)" == "$base_wt" ]]; then ok "git worktree list never left baseline"; else bad "an empty probe left a worktree behind"; fi
avo fan --clean all --json --cwd "$repo" >/dev/null
say ""

# ------------------------------------------------- 6. the guards
say "## 6. the guards"
out="$(AVO_FAN_LEVEL=3 avo fan --n 2 --prompt 'vary it' --json --cwd "$repo")"
rc=$?
if [[ $rc == 1 ]]; then ok "a depth-limited fan-out is a refusal (exit 1), not a harness error"; else bad "expected exit 1, got $rc"; fi
echo "$out" | jq -e '.error | test("depth limit")' >/dev/null
yes_no $? "the refusal names the depth limit" "the error was $(echo "$out" | jq -r .error)"
if [[ "$(worktrees)" == "$base_wt" ]]; then ok "nothing was created before the refusal"; else bad "a refused fan-out still made worktrees"; fi

out="$(AVO_FAN_CHAIN="$(printf 'vary it' | sha256sum | cut -c1-12)" avo fan --n 1 --prompt 'vary it' --json --cwd "$repo")"
rc=$?
if [[ $rc == 1 ]]; then ok "a repeated prompt is refused as a cycle (exit 1)"; else bad "expected exit 1, got $rc"; fi
echo "$out" | jq -e '.error | test("cycle")' >/dev/null
yes_no $? "the refusal names the cycle" "the error was $(echo "$out" | jq -r .error)"

start=$SECONDS
out="$(avo fan --n 1 --prompt 'go slow' --timeout 2 --json --cwd "$repo")"
elapsed=$((SECONDS - start))
if [[ $elapsed -lt 30 ]]; then ok "a 60s probe under --timeout 2 returned in ${elapsed}s"; else bad "the timeout did not fire (${elapsed}s)"; fi
echo "$out" | jq -e '.results[0].timed_out and (.results[0].ok | not)' >/dev/null
yes_no $? "the timed-out probe is reported as such" "timed_out was not set"
avo fan --clean all --json --cwd "$repo" >/dev/null
say ""

# ------------------------------------------------- 7. crash safety
say "## 7. a killed run is resumable"
out="$(avo fan --n 2 --prompt 'vary it' --json --cwd "$repo")"
run_id="$(echo "$out" | jq -r .run_id)"
man="$repo/.avo/worktrees/$run_id/manifest.json"
# Exactly the state a kill between probes leaves: probe 2 pending, its worktree gone.
jq '.finished_at = null | .probes |= map(if .i == 2 then .status = "pending" | .result = null else . end)' "$man" > "$man.tmp"
mv "$man.tmp" "$man"
git -C "$repo" worktree remove --force ".avo/worktrees/$run_id/2"
out="$(avo fan --resume "$run_id" --json --cwd "$repo")"
rc=$?
yes_no $rc "avo fan --resume exited 0" "resume exited $rc"
echo "$out" | jq -e '.results | length == 2' >/dev/null
yes_no $? "both probes are present after the resume" "got $(echo "$out" | jq '.results|length') results"
echo "$out" | jq -e '.warnings | join(" ") | test("resuming 1 of 2")' >/dev/null
yes_no $? "only the unfinished probe was re-run" "warnings were $(echo "$out" | jq -c .warnings)"
echo "$out" | jq -e '[.results[] | .score.primary] == [2,3]' >/dev/null
yes_no $? "the resumed probe scored like the original" "scores were $(echo "$out" | jq -c '[.results[].score.primary]')"
avo fan --clean all --json --cwd "$repo" >/dev/null
if [[ "$(worktrees)" == "$base_wt" ]]; then ok "git worktree list is back to baseline after every suite"; else bad "worktrees leaked: $(worktrees)"; fi
say ""

# ------------------------------------------------- 8. usage
say "## 8. usage errors"
avo fan --cwd "$repo" >/dev/null 2>&1 && rc=0 || rc=$?
if [[ $rc == 2 ]]; then ok "a fan-out with no prompt exits 2"; else bad "expected exit 2 for a missing prompt, got $rc"; fi
# Captured first rather than piped: `set -o pipefail` would otherwise report avo's exit 2 for the
# whole pipeline and mask jq's verdict, which is the thing being asserted.
out="$(avo fan --prompt p --agent gpt --json --cwd "$repo" 2>/dev/null)"
echo "$out" | jq -e '.error | test("pi \\| claude \\| codex")' >/dev/null
yes_no $? "an unknown agent names the alternatives" "the error was: $out"
out="$(avo fan --promote 1 --run nope --json --cwd "$repo" 2>/dev/null)"
echo "$out" | jq -e '.error | test("no run")' >/dev/null
yes_no $? "promoting from a run that does not exist says so" "the error was: $out"
say ""

say "# $(grep -c '^PASS' "$evidence") checks passed, $fails failed"
exit $((fails > 0 ? 1 : 0))
