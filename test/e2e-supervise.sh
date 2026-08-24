#!/usr/bin/env bash
# End-to-end checks for `avo supervise` (S7a), against the real bin/avo, a real git repo, a real
# `.avo/score` and the real attempt log the harness writes for itself — the supervisor's whole claim
# is that it reads what avo already records, so nothing here is hand-written into the log.
# Writes evidence/s7-e2e.txt.
set -uo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 1

evidence="$root/evidence/s7-e2e.txt"
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

say "# avo S7a e2e — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "# node $(node --version), $(git --version), jq $(jq --version)"
say ""

# ------------------------------------------------- 0. a fixture repo whose f is a real scorer
git init -q -b main "$repo"
git -C "$repo" config user.email avo@example.com
git -C "$repo" config user.name avo
mkdir -p "$repo/.avo" "$repo/knowledge"
printf 'baseline\n' > "$repo/kernel.txt"

# The metric is line count, and `broken` makes f fail the same way every time — which is exactly
# what a thrashing agent produces.
cat > "$repo/.avo/score" <<'SCORE'
#!/usr/bin/env bash
if [[ -f broken ]]; then
  printf '{"ok":true,"correct":false,"primary":null,"unit":"lines","higher_is_better":true,"log":"kernel.txt:12: undefined symbol foo"}\n'
  exit 0
fi
n=$(wc -l < kernel.txt | tr -d ' ')
printf '{"ok":true,"correct":true,"primary":%s,"unit":"lines","higher_is_better":true}\n' "$n"
SCORE
chmod +x "$repo/.avo/score"

cat > "$repo/knowledge/tma-descriptors.md" <<'DOC'
# Bulk asynchronous copy with TMA descriptors

A direction no version has taken yet.
DOC
cat > "$repo/knowledge/unrolling-the-inner-loop.md" <<'DOC'
# Unrolling the inner loop

DOC

git -C "$repo" add -A
git -C "$repo" commit -qm baseline
say "## 0. fixture"
ok "repo at HEAD $(git -C "$repo" rev-parse --short HEAD), an f that can fail on demand, 2 docs in K"
say ""

# ------------------------------------------------- 1. a repo that has not started is not stuck
say "## 1. nothing to steer"
out="$(avo supervise --cwd "$repo" 2>&1)"; code=$?
if [[ $code == 0 ]]; then ok "exit 0 with no attempts and no versions"; else bad "exit $code, expected 0"; fi
printf '%s' "$out" | grep -q 'no intervention'
yes_no $? "it says so in words" "it does not say 'no intervention'"
if printf '%s' "$out" | grep -q 'STEERING'; then
  bad "it emitted a directive with nothing to steer"
else
  ok "no directive with nothing to steer"
fi
say ""

# ------------------------------------------------- 2. the first version, then attempts against it
say "## 2. a real lineage and a real attempt log"
# A change first: `avo commit` on a clean tree is a no-op by design — there is no candidate to
# measure — and it records no attempt either.
printf 'the first variation\n' >> "$repo/kernel.txt"
avo commit --cwd "$repo" --why "the baseline: one more line" >/dev/null 2>&1
v1="$(avo best --cwd "$repo" --json 2>/dev/null | jq -r '.version')"
if [[ $v1 == 1 ]]; then ok "avo commit wrote v1"; else bad "avo best reports version '$v1', expected 1"; fi

# Four scoring runs that measure the same tree: the shape of an agent that keeps not improving.
for _ in 1 2 3 4; do avo score --cwd "$repo" >/dev/null 2>&1; done
n="$(wc -l < "$repo/.avo/attempts.jsonl" | tr -d ' ')"
if [[ $n == 5 ]]; then ok "the attempt log has 5 records (1 from avo commit + 4 from avo score)"; else bad "the attempt log has $n records, expected 5"; fi

json="$(avo supervise --cwd "$repo" --json 2>/dev/null)"
since="$(printf '%s' "$json" | jq -r '.state.since_best')"
if [[ $since == 4 ]]; then
  ok "since_best is 4: the attempt that became v1 is not counted as one made since v1"
else
  bad "since_best is $since, expected 4 (the committing attempt must not count)"
fi
printf '%s' "$json" | jq -e '.triggered == false' >/dev/null
yes_no $? "4 < the default stall of 5, so nothing fired" "it fired below the threshold"
say ""

# ------------------------------------------------- 3. the stall fires at exactly N
say "## 3. the stall"
avo score --cwd "$repo" >/dev/null 2>&1
json="$(avo supervise --cwd "$repo" --json 2>/dev/null)"; code=$?
if [[ $code == 1 ]]; then ok "exit 1 once a signal fires, so a shell loop can branch on it"; else bad "exit $code, expected 1"; fi
printf '%s' "$json" | jq -e '.state.since_best == 5 and .triggered == true' >/dev/null
yes_no $? "it fires at exactly 5, the fifth attempt since v1" "it did not fire at 5"
printf '%s' "$json" | jq -e '[.signals[].kind] == ["stall"]' >/dev/null
yes_no $? "one signal, and it is the stall" "the signals are $(printf '%s' "$json" | jq -c '[.signals[].kind]')"

directive="$(printf '%s' "$json" | jq -r '.directive')"
printf '%s' "$directive" | grep -q 'since v1'
yes_no $? "the directive names the version it stalled against" "the directive never mentions v1"
printf '%s' "$directive" | grep -q 'avo lineage show 1'
yes_no $? "it points at the version to read, by number" "it does not point at 'avo lineage show 1'"
printf '%s' "$directive" | grep -q 'lineage/v001.md'
yes_no $? "it cites the lineage file avo commit wrote" "it does not cite lineage/v001.md"
printf '%s' "$directive" | grep -q 'the baseline: one more line'
yes_no $? "it quotes the rationale the agent gave for v1" "it does not quote v1's --why"
printf '%s' "$directive" | grep -q 'knowledge/tma-descriptors.md'
yes_no $? "it cites a doc in K that no version has mentioned" "it does not cite the unexplored doc"
printf '%s' "$directive" | grep -q 'avo fan --n 4'
yes_no $? "it says how to explore, not just that it should" "it does not name a command to explore with"
say ""

# ------------------------------------------------- 4. a committed improvement resets it
say "## 4. progress resets the counter"
printf 'a line the agent added\n' >> "$repo/kernel.txt"
avo commit --cwd "$repo" --why "appended a line: warp specialization" >/dev/null 2>&1
json="$(avo supervise --cwd "$repo" --json 2>/dev/null)"; code=$?
if [[ $code == 0 ]]; then ok "exit 0 again: an improvement is not a stall"; else bad "exit $code after a commit, expected 0"; fi
printf '%s' "$json" | jq -e '.state.since_best == 0 and .state.best.version == 2 and .directive == null' >/dev/null
yes_no $? "since_best is back to 0 and v2 is the version to beat" "the counter did not reset: $(printf '%s' "$json" | jq -c '.state')"
say ""

# ------------------------------------------------- 5. the thrash
say "## 5. the thrash"
touch "$repo/broken"
for _ in 1 2 3; do avo score --cwd "$repo" >/dev/null 2>&1; done
json="$(avo supervise --cwd "$repo" --json --stall 99 2>/dev/null)"; code=$?
if [[ $code == 1 ]]; then ok "exit 1 on a thrash with the stall well out of reach"; else bad "exit $code, expected 1"; fi
printf '%s' "$json" | jq -e '[.signals[].kind] == ["thrash"]' >/dev/null
yes_no $? "the thrash fired on its own, with no stall to help it" "the signals are $(printf '%s' "$json" | jq -c '[.signals[].kind]')"
printf '%s' "$json" | jq -e '.state.repeat == 3 and .state.failing_streak == 3' >/dev/null
yes_no $? "3 consecutive failures, all 3 the same failure" "repeat/streak are $(printf '%s' "$json" | jq -c '{repeat:.state.repeat,streak:.state.failing_streak}')"
sig="$(printf '%s' "$json" | jq -r '.state.signature')"
printf '%s' "$sig" | grep -q 'undefined symbol foo'
yes_no $? "the signature is the scorer's own error line ($sig)" "the signature does not carry the error: $sig"
printf '%s' "$json" | jq -r '.directive' | grep -q 'Read the failure before editing again'
yes_no $? "a thrash directive says to read the failure, not to try harder" "the thrash directive reads like the stall one"
say ""

# ------------------------------------------------- 6. one pass clears it
say "## 6. a pass clears the thrash"
rm -f "$repo/broken"
avo score --cwd "$repo" >/dev/null 2>&1
json="$(avo supervise --cwd "$repo" --json --stall 99 2>/dev/null)"
printf '%s' "$json" | jq -e '.triggered == false and .state.failing_streak == 0 and .state.signature == null' >/dev/null
yes_no $? "one passing attempt ends the streak" "the streak survived a pass: $(printf '%s' "$json" | jq -c '.state')"
say ""

# ------------------------------------------------- 7. repo policy, and the tree it must not dirty
say "## 7. thresholds and the working tree"
jq -n '{supervise:{stall:1,thrash:2}}' > "$repo/.avo/config.json"
json="$(avo supervise --cwd "$repo" --json 2>/dev/null)"
printf '%s' "$json" | jq -e '.thresholds == {stall:1,thrash:2} and .triggered == true' >/dev/null
yes_no $? "a threshold in .avo/config.json is repo policy and applies with no flag" "the config thresholds were ignored"
json="$(avo supervise --cwd "$repo" --json --stall 50 2>/dev/null)"
printf '%s' "$json" | jq -e '.thresholds.stall == 50 and .triggered == false' >/dev/null
yes_no $? "a flag beats the config" "--stall did not override the config"
rm -f "$repo/.avo/config.json"

# The supervisor is a reader. If it wrote anything into the tree, the next candidate's diff would
# contain the harness's own output — the self-perturbation bug S3 and S6 both shipped a fix for.
before="$(git -C "$repo" status --porcelain | sort)"
avo supervise --cwd "$repo" >/dev/null 2>&1
avo supervise --cwd "$repo" --json >/dev/null 2>&1
after="$(git -C "$repo" status --porcelain | sort)"
if [[ $before == "$after" ]]; then ok "two runs leave the working tree byte-identical: the supervisor only reads"; else bad "the supervisor changed the tree: $(diff <(printf '%s' "$before") <(printf '%s' "$after") | head -5)"; fi
head_before="$(git -C "$repo" rev-parse HEAD)"
avo supervise --cwd "$repo" >/dev/null 2>&1
if [[ $head_before == "$(git -C "$repo" rev-parse HEAD)" ]]; then ok "HEAD is untouched: avo commit is still the only writer of a version"; else bad "avo supervise moved HEAD"; fi
say ""

# ------------------------------------------------- 8. degradation
say "## 8. degradation"
bare="$work/bare"
mkdir -p "$bare/.avo"
out="$(avo supervise --cwd "$bare" 2>&1)"; code=$?
if [[ $code == 0 ]]; then ok "a directory that is not a git repo is exit 0, not a crash"; else bad "exit $code outside a git repo"; fi
printf '%s' "$out" | grep -q 'not a git repository'
yes_no $? "and it says which half of the input it could not read" "it does not name the missing lineage"

# A killed `avo score` can leave a half-written line. Losing that line is acceptable; losing the
# rest of the log is not.
cp "$repo/.avo/attempts.jsonl" "$bare/.avo/attempts.jsonl"
printf '{"ts":"2026-08-24T10:00:00.000Z","pa' >> "$bare/.avo/attempts.jsonl"
json="$(avo supervise --cwd "$bare" --json --stall 2 2>/dev/null)"; code=$?
if [[ $code == 1 ]]; then ok "a truncated last line still leaves a usable log"; else bad "exit $code on a truncated log, expected 1"; fi
printf '%s' "$json" | jq -e '[.warnings[] | select(test("unreadable"))] | length == 1' >/dev/null
yes_no $? "the unreadable line is reported, not hidden" "the truncated line produced no warning"

avo supervise --cwd "$repo" --stall 0 >/dev/null 2>&1; code=$?
if [[ $code == 2 ]]; then ok "a threshold that could never fire is a usage error (exit 2)"; else bad "--stall 0 accepted, exit $code"; fi
say ""

# ------------------------------------------------- 9. the agent-facing contract
say "## 9. --json is the agent's interface"
json="$(avo supervise --cwd "$repo" --json --stall 1 2>/dev/null)"
printf '%s' "$json" | jq -e '
  (.triggered | type) == "boolean"
  and (.directive | type) == "string"
  and (.thresholds.stall | type) == "number"
  and (.state.attempts | type) == "number"
  and ([.citations[].kind] | length) > 0
  and ([.citations[] | select(has("ref") and has("text"))] | length) == ([.citations[]] | length)
' >/dev/null
yes_no $? "one JSON object, every field typed as documented, every citation has a ref" "the --json shape is not what an agent is told to expect"
printf '%s' "$json" | head -c 1 | grep -q '{'
yes_no $? "it is a single line of JSON on stdout" "stdout is not JSON"
say ""

say "## summary"
if [[ $fails == 0 ]]; then
  say "all checks passed ($(grep -c '^PASS' "$evidence") of them)"
else
  say "$fails check(s) FAILED"
fi
exit "$((fails > 0))"
