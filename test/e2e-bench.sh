#!/usr/bin/env bash
# End-to-end checks for the S9 optimization target: bench/init.sh, the fuzzysearch `f`, its
# anti-gaming gates, and the headroom the target has to offer. Writes evidence/s9a-e2e.txt.
#
# The thing this suite proves that no unit test can: that a *scripted* optimizer walking a known
# path produces exactly the curve S9 asks for -- five or more committed versions, best score
# monotonically non-decreasing, every recorded score reproducible from its own commit. S9b spends an
# agent on the same target; this establishes that when the curve is flat there, the target is not
# what is wrong.
set -uo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 1

evidence="$root/evidence/s9a-e2e.txt"
mkdir -p "$root/evidence"
: > "$evidence"

fails=0
say() { printf '%s\n' "$*" | tee -a "$evidence"; }
ok()  { say "PASS  $*"; }
bad() { say "FAIL  $*"; fails=$((fails + 1)); }

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
repo="$scratch/fuzzysearch"

avo() { "$root/bin/avo" "$@"; }
score() { (cd "$repo" && .avo/score); }
# The scorer's own exit is always 0; `correct` is the verdict.
correct_of() { jq -r '.correct' <<<"$1"; }
log_of() { jq -r '.log // ""' <<<"$1"; }

say "# avo S9a e2e -- $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "# node $(node --version), $(git --version), jq $(jq --version)"
say "# target: bench/fuzzysearch -- thresholded edit-distance retrieval, median ms, lower is better"
say ""

# ================================================================ 1. materializing the target
say "## 1. bench/init.sh"

out="$(./bench/init.sh "$repo" 2>&1)"
code=$?
say "\$ bench/init.sh \$scratch/fuzzysearch -> exit $code"
if [[ $code -eq 0 && -d "$repo/.git" ]]; then ok "materializes into a fresh git repo"; else bad "did not materialize: $out"; fi
if [[ -x "$repo/.avo/score" ]]; then ok ".avo/score is executable"; else bad ".avo/score is not executable"; fi
if [[ -f "$repo/.avo/gate.sha256" ]]; then
  n="$(wc -l < "$repo/.avo/gate.sha256")"
  ok "the gate records $n protected file(s)"
else
  bad "no .avo/gate.sha256 -- f would have no gate"
fi
if [[ "$(git -C "$repo" rev-list --count HEAD 2>/dev/null)" == 1 ]]; then
  ok "the baseline is one commit: $(git -C "$repo" log --oneline -1)"
else
  bad "expected exactly one baseline commit"
fi
if [[ ! -e "$repo/ladder" && ! -e "$repo/test/fixtures" ]]; then
  ok "the ladder fixtures are NOT materialized -- the optimizer is not handed the answer"
else
  bad "a ladder leaked into the target repo"
fi

# The self-perturbation guard. S3, S6 and S8 each shipped a version of this bug; the target repo is
# where it would be worst, because `avo commit` would write the loop's whole lineage into avocode.
out="$(./bench/init.sh "$root/bench/scratch-target" 2>&1)"
code=$?
if [[ $code -ne 0 ]] && grep -q "inside avocode" <<<"$out"; then
  ok "refuses a destination inside avocode's own checkout"
else
  bad "materialized inside avocode (exit $code): $out"
fi
if [[ ! -e "$root/bench/scratch-target" ]]; then ok "and wrote nothing there"; else bad "left $root/bench/scratch-target behind"; fi

if out="$(./bench/init.sh "$repo" 2>&1)"; then
  bad "clobbered a non-empty destination"
elif grep -q "not empty" <<<"$out"; then
  ok "refuses a non-empty destination without --force"
else
  bad "refused a non-empty destination for the wrong reason: $out"
fi

before="$(cd "$repo" && find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum)"
./bench/init.sh "$repo" --force >/dev/null 2>&1
after="$(cd "$repo" && find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum)"
if [[ "$before" == "$after" ]]; then ok "--force is byte-identical on an unchanged target (invariant 5)"; else bad "--force changed the tree"; fi

if ./bench/init.sh --verify "$repo" >/dev/null 2>&1; then ok "--verify passes on an intact target"; else bad "--verify failed on an intact target"; fi
say ""

# ================================================================ 2. f on the baseline
say "## 2. f on the baseline"
base="$(score)"
say "\$ .avo/score -> $(jq -c '{ok,correct,primary,unit,scores}' <<<"$base")"
if [[ "$(jq -r '.ok' <<<"$base")" == true && "$(correct_of "$base")" == true ]]; then
  ok "the baseline is ok and correct"
else
  bad "the baseline does not score: $(log_of "$base")"
fi
if [[ "$(jq -r '.unit' <<<"$base")" == ms && "$(jq -r '.higher_is_better' <<<"$base")" == false ]]; then
  ok "the metric is ms, lower is better"
else
  bad "wrong metric declaration"
fi
if [[ "$(jq -r '.scores | keys | join(",")' <<<"$base")" == "large,small" ]]; then
  ok "two configs are scored, so the commit rule compares a vector"
else
  bad "expected configs small+large, got $(jq -c '.scores|keys' <<<"$base")"
fi
if [[ "$(cd "$repo" && .avo/score --configs | sort | tr '\n' ',')" == "large,small," ]]; then
  ok "--configs lists them, so avo score --parallel works"
else
  bad "--configs did not list both configs"
fi
one="$(cd "$repo" && .avo/score --config small)"
if [[ "$(jq -r '.scores | keys | join(",")' <<<"$one")" == "small" ]]; then
  ok "--config small scores only that config"
else
  bad "--config did not narrow the run"
fi
if [[ "$(cd "$repo" && .avo/score --config nope | jq -r '.correct')" == false ]]; then
  ok "an unknown config is a result, not a crash"
else
  bad "an unknown config was not reported"
fi

# The floor has to sit above the measurement noise or it protects nothing.
worst="$(log_of "$base" | grep -o 'spread [0-9.]*' | awk '{if ($2+0 > m) m = $2+0} END {print m+0}')"
floor_pct="$(jq -r '.floor * 100' "$repo/.avo/config.json")"
if awk -v w="$worst" -v f="$floor_pct" 'BEGIN {exit !(w < f)}'; then
  ok "worst config spread ${worst}% is under the ${floor_pct}% floor"
else
  bad "spread ${worst}% exceeds the ${floor_pct}% floor -- noise could commit"
fi
say ""

# ================================================================ 3. the gate
say "## 3. f refuses to measure itself"
for p in bench/reference.js bench/corpus.js bench/run.js test/search.test.js .avo/score; do
  printf '\n// tampered\n' >> "$repo/$p"
  out="$(score)"
  if [[ "$(correct_of "$out")" == false ]] && grep -q "$p" <<<"$(log_of "$out")"; then
    ok "editing $p makes the score incorrect, and names the file"
  else
    bad "editing $p was not caught: $(log_of "$out" | head -2)"
  fi
  git -C "$repo" checkout -- "$p"
done

# A deleted gate file is not the same failure as an edited one, and neither may pass.
mv "$repo/test/search.test.js" "$scratch/held.js"
out="$(score)"
if [[ "$(correct_of "$out")" == false ]]; then ok "deleting the suite makes the score incorrect"; else bad "a deleted suite still scored"; fi
mv "$scratch/held.js" "$repo/test/search.test.js"

printf '\n// tampered\n' >> "$repo/bench/run.js"
if ! ./bench/init.sh --verify "$repo" >/dev/null 2>&1; then
  ok "bench/init.sh --verify detects the same tampering from outside the repo"
else
  bad "--verify missed a modified bench/run.js"
fi
git -C "$repo" checkout -- bench/run.js

mv "$repo/.avo/gate.sha256" "$scratch/gate"
out="$(score)"
if [[ "$(jq -r '.ok' <<<"$out")" == false ]]; then
  ok "a missing gate is a HARNESS error (ok:false), not a verdict on the candidate"
else
  bad "a missing gate was reported as a candidate failure"
fi
mv "$scratch/gate" "$repo/.avo/gate.sha256"
say ""

# ================================================================ 4. being fast and wrong
say "## 4. fast and wrong scores nothing"

cat > "$repo/src/search.js" <<'JS'
export function search() { return []; }
JS
out="$(score)"
if [[ "$(correct_of "$out")" == false ]]; then ok "returning nothing is instant and incorrect"; else bad "an empty result set passed"; fi
avo score --cwd "$repo" >/dev/null 2>&1
out="$(avo commit --cwd "$repo" --why "return nothing" --json 2>&1)"
if [[ "$(jq -r '.action' <<<"$out")" == refused ]]; then
  ok "and avo commit refuses it (invariant 2): $(jq -r '.reason' <<<"$out")"
else
  bad "a failing attempt was not refused: $out"
fi

# This is what gate 3 in .avo/score is for. Every case in test/search.test.js passes; the candidate
# is wrong only on the corpus it is timed on, which a unit suite cannot see.
cat > "$repo/src/search.js" <<'JS'
import { referenceSearch } from "../bench/reference.js";
export function search(queries, corpus, k) {
  if (corpus.length < 1000) return referenceSearch(queries, corpus, k); // the unit fixtures
  return []; // the scored workload
}
JS
suite_out="$(cd "$repo" && node --test test/*.test.js 2>&1)"
suite_code=$?
out="$(score)"
if [[ $suite_code -eq 0 && "$(correct_of "$out")" == false ]]; then
  ok "a candidate that passes the whole unit suite but is wrong at scale is still caught"
  say "      run.js said: $(log_of "$out" | head -1)"
else
  bad "scale-only cheating slipped through (suite exit $suite_code, correct $(correct_of "$out"))"
  say "      suite said: $(printf '%s' "$suite_out" | tail -n 3)"
fi

cat > "$repo/src/search.js" <<'JS'
export function search(queries, corpus) { corpus.length = 0; return []; }
JS
out="$(score)"
if [[ "$(correct_of "$out")" == false ]] && grep -qi "mutat" <<<"$(log_of "$out")"; then
  ok "mutating the caller's arrays is caught and named"
else
  bad "input mutation was not caught: $(log_of "$out" | head -1)"
fi

cat > "$repo/src/search.js" <<'JS'
export const search = "not a function";
JS
out="$(score)"
if [[ "$(correct_of "$out")" == false ]]; then ok "a candidate with the wrong export shape is a result, not a crash"; else bad "a non-function export passed"; fi

printf 'this is not javascript(\n' > "$repo/src/search.js"
out="$(score)"
if [[ "$(correct_of "$out")" == false ]]; then ok "a candidate that does not parse is a result, not a crash"; else bad "an unparseable candidate passed"; fi

git -C "$repo" checkout -- src/search.js
say ""

# ================================================================ 5. the headroom, as a curve
say "## 5. a scripted optimizer walks the known path"
say "# each step replaces src/search.js, then avo score + avo commit decide"
avo init --cwd "$repo" --json >/dev/null 2>&1   # K, memory, .avo/.gitignore; config and scorer already here

committed=0
refused=0
first_primary=""
last_primary=""
prev_best=""
monotonic=true
for v in v1 v2 v3 v4 v5 v6; do
  cp "$root/test/fixtures/fuzzysearch/$v.js" "$repo/src/search.js"
  s="$(score)"
  if [[ "$(correct_of "$s")" != true ]]; then
    bad "$v does not pass f: $(log_of "$s" | head -3)"
    continue
  fi
  p="$(jq -r '.primary' <<<"$s")"
  [[ -z "$first_primary" ]] && first_primary="$(jq -r '.primary' <<<"$base")"
  last_primary="$p"
  avo score --cwd "$repo" >/dev/null 2>&1
  c="$(avo commit --cwd "$repo" --why "$v: $(sed -n '2s|^// ||p' "$root/test/fixtures/fuzzysearch/$v.js")" --json 2>&1)"
  action="$(jq -r '.action' <<<"$c")"
  if [[ "$action" == committed ]]; then
    committed=$((committed + 1))
    say "  $v -> v$(printf '%03d' "$(jq -r '.version' <<<"$c")")  primary ${p}ms  $(jq -r '.comparison.improved | join("+")' <<<"$c") improved"
  else
    refused=$((refused + 1))
    say "  $v -> $action  primary ${p}ms  $(jq -r '.reason' <<<"$c")"
  fi
  b="$(avo best --cwd "$repo" --json 2>/dev/null | jq -r '.score.primary // empty')"
  if [[ -n "$prev_best" && -n "$b" ]] && awk -v a="$prev_best" -v c="$b" 'BEGIN {exit !(c > a)}'; then
    monotonic=false
    bad "best regressed after $v: ${prev_best}ms -> ${b}ms"
  fi
  [[ -n "$b" ]] && prev_best="$b"
done

say ""
say "  $committed committed, $refused refused, of 6 steps"
if [[ $committed -ge 5 ]]; then
  ok "at least 5 versions were committed (S9 acceptance: >=5)"
else
  bad "only $committed version(s) committed; S9 wants >=5"
fi
if [[ "$monotonic" == true ]]; then ok "best score is monotonically non-decreasing across the lineage"; fi

speedup="$(jq -n --argjson a "$first_primary" --argjson b "$last_primary" '($a / $b * 10 | round) / 10')"
say "  headroom walked: ${first_primary}ms -> ${last_primary}ms = ${speedup}x"
if awk -v s="$speedup" 'BEGIN {exit !(s >= 5)}'; then
  ok "the target has real headroom (${speedup}x >= 5x), so a flat curve in S9b is the agent, not f"
else
  bad "only ${speedup}x of headroom -- the curve would prove little"
fi

versions="$(avo lineage --cwd "$repo" --json | jq 'length')"
if [[ "$versions" -eq "$committed" ]]; then
  ok "avo lineage --json reports all $versions of them"
else
  bad "lineage has $versions versions, $committed were committed"
fi
say ""

# ================================================================ 6. every score reproduces
say "## 6. every committed version reproduces its recorded score"
say "# S9's second acceptance criterion: a score in the lineage is a measurement, not a claim"
# A pipeline would run this loop in a subshell, where `bad` increments a copy of $fails and every
# failure in this section is silently dropped. Process substitution keeps it in this shell.
while read -r n sha recorded; do
  wt="$scratch/replay-v$n"
  git -C "$repo" worktree add -q --detach "$wt" "$sha" 2>/dev/null || { bad "could not check out v$n"; continue; }
  fresh="$(cd "$wt" && .avo/score | jq -r '.primary // "null"')"
  git -C "$repo" worktree remove --force "$wt" 2>/dev/null
  if [[ "$fresh" == null ]]; then
    bad "v$n does not score at all from its own commit"
    continue
  fi
  drift="$(jq -n --argjson a "$recorded" --argjson b "$fresh" '(($b - $a) / $a * 1000 | round) / 10')"
  abs="${drift#-}"
  if awk -v d="$abs" 'BEGIN {exit !(d <= 50)}'; then
    ok "v$n: recorded ${recorded}ms, fresh ${fresh}ms (${drift}%)"
  else
    # 50% is deliberately loose: this checks that the commit CONTAINS the code that earned the
    # score, on a machine that may be doing something else. A gamed or empty version is off by
    # orders of magnitude, not by a scheduler hiccup.
    bad "v$n: recorded ${recorded}ms but re-scores at ${fresh}ms (${drift}%)"
  fi
done < <(avo lineage --cwd "$repo" --json | jq -r '.[] | "\(.version) \(.sha) \(.score.primary)"')
say ""

# ================================================================
say "## summary"
if [[ $fails -eq 0 ]]; then
  say "all checks passed ($(grep -c '^PASS' "$evidence") of them)"
else
  say "$fails FAILED"
fi
say ""
say "# f was still f at the end:"
./bench/init.sh --verify "$repo" 2>&1 | tee -a "$evidence"
exit $((fails > 0 ? 1 : 0))
