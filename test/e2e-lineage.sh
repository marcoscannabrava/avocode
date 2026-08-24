#!/usr/bin/env bash
# End-to-end checks for `avo commit` / `avo lineage` / `avo best` (S2) against a real fixture repo.
# Writes evidence/s2-e2e.txt.
set -uo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 1

evidence="$root/evidence/s2-e2e.txt"
mkdir -p "$root/evidence"
: > "$evidence"

fails=0
say() { printf '%s\n' "$*" | tee -a "$evidence"; }
ok()   { say "PASS  $*"; }
bad()  { say "FAIL  $*"; fails=$((fails + 1)); }

fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT

avo() { "$root/bin/avo" "$@"; }
ingit() { git -C "$fixture" "$@"; }

say "# avo S2 e2e — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "# node $(node --version), $(git --version), jq $(jq --version)"
say "# fixture: candidate must print 42; metric = code size in bytes, lower is better"
say ""

ingit init -q
ingit config user.email avo@example.com
ingit config user.name avo
ingit config commit.gpgsign false
printf 'echo 42\n# padding padding padding\n' > "$fixture/impl.sh"
ingit add -A
ingit commit -qm "fixture baseline"

mkdir -p "$fixture/.avo"
cat > "$fixture/.avo/score" <<'SCORER'
#!/usr/bin/env bash
out=$(bash impl.sh 2>&1)
size=$(wc -c < impl.sh | tr -d ' ')
if [[ "$out" == "42" ]]; then
  printf '{"ok":true,"correct":true,"primary":%s,"unit":"bytes","higher_is_better":false}\n' "$size"
else
  printf '{"ok":true,"correct":false,"primary":null,"unit":"bytes","higher_is_better":false,"log":"printed %s"}\n' "$out"
fi
SCORER
chmod +x "$fixture/.avo/score"

# ---------------------------------------------------------------- 1. no lineage yet
out="$(avo lineage --cwd "$fixture" --json)"
say "\$ avo lineage --json (empty) -> $out"
if printf '%s' "$out" | jq -e 'length == 0' >/dev/null; then
  ok "an un-evolved repo has an empty lineage"
else
  bad "empty lineage was not an empty array"
fi

avo best --cwd "$fixture" --json >/dev/null 2>&1 && rc=0 || rc=$?
if [[ $rc -eq 1 ]]; then ok "avo best exits 1 when there is no best version"; else bad "avo best exited $rc, not 1"; fi

# ---------------------------------------------------------------- 2. v1
out="$(avo commit --cwd "$fixture" --why "baseline: adds the scorer" --json)"
code=$?
say "\$ avo commit (v1) -> exit $code"
say "  $(printf '%s' "$out" | jq -c '{action,version,reason}')"
if [[ $code -eq 0 ]] && printf '%s' "$out" | jq -e '.action == "committed" and .version == 1' >/dev/null; then
  ok "the first passing candidate becomes v1"
else
  bad "v1 was not committed"
fi

body="$(ingit log -1 --format=%B)"
if grep -qx 'Avo-Version: 1' <<<"$body"; then ok "the commit carries an Avo-Version trailer"; else bad "no Avo-Version trailer"; fi
if grep -q '^Avo-Score: {.*"primary":34' <<<"$body"; then ok "the commit carries an Avo-Score trailer"; else bad "no Avo-Score trailer"; fi
if grep -q 'baseline: adds the scorer' <<<"$body"; then ok "--why lands in the commit body"; else bad "--why was lost"; fi
if ingit notes --ref=avo show HEAD | jq -e '.attempt.pass == true' >/dev/null 2>&1; then
  ok "git notes --ref=avo carries the full attempt"
else
  bad "no readable avo note on the commit"
fi
if [[ -f "$fixture/lineage/v001.md" ]] && grep -q '^# v1' "$fixture/lineage/v001.md"; then
  ok "lineage/v001.md was rendered and committed"
else
  bad "lineage/v001.md missing"
fi

# ---------------------------------------------------------------- 3. idempotency
before="$(ingit rev-list --count HEAD)"
avo score --cwd "$fixture" >/dev/null 2>&1   # dirties .avo/attempts.jsonl on purpose
out="$(avo commit --cwd "$fixture" --json)"
code=$?
after="$(ingit rev-list --count HEAD)"
say "\$ avo commit (clean tree, after a score) -> exit $code $(printf '%s' "$out" | jq -c '.action')"
if [[ $code -eq 0 ]] && printf '%s' "$out" | jq -e '.action == "noop"' >/dev/null && [[ "$before" == "$after" ]]; then
  ok "re-running with no change is a no-op, not a duplicate (invariant 5)"
else
  bad "re-running produced $before -> $after commits"
fi
if ingit ls-files | grep -qx '.avo/attempts.jsonl'; then
  bad "the attempt log was committed into the lineage"
else
  ok "the attempt log stays out of the lineage (trajectory, not P_t)"
fi

# ---------------------------------------------------------------- 4. regression refused
printf 'echo 42\n# padding padding padding padding padding\n' > "$fixture/impl.sh"
out="$(avo commit --cwd "$fixture" --json)"
code=$?
say "\$ avo commit (bigger file) -> exit $code"
say "  $(printf '%s' "$out" | jq -c '{action,reason}')"
if [[ $code -eq 1 ]] && printf '%s' "$out" | jq -e '.action == "refused" and (.reason | test("regressed"))' >/dev/null; then
  ok "a regression is refused with a reason that names the config"
else
  bad "a regression was not refused"
fi
if [[ "$(ingit rev-list --count HEAD)" == "$after" ]]; then
  ok "a refused commit leaves no commit behind"
else
  bad "a refused commit still wrote to git"
fi
if [[ -f "$fixture/lineage/v002.md" ]]; then bad "a refused commit left a lineage file"; else ok "a refused commit leaves no lineage file"; fi

# ---------------------------------------------------------------- 5. correctness gate
printf 'echo 41\n' > "$fixture/impl.sh"
out="$(avo commit --cwd "$fixture" --json)"
code=$?
say "\$ avo commit (smaller but wrong) -> exit $code"
say "  $(printf '%s' "$out" | jq -c '{action,reason}')"
if [[ $code -eq 1 ]] && printf '%s' "$out" | jq -e '.reason | test("correctness")' >/dev/null; then
  ok "a failing f never yields a commit, however good the metric (invariant 2)"
else
  bad "the correctness gate did not refuse a wrong candidate"
fi

# ---------------------------------------------------------------- 6. dry run
printf 'echo 42\n' > "$fixture/impl.sh"
head_before="$(ingit rev-parse HEAD)"
out="$(avo commit --cwd "$fixture" --dry-run --json)"
code=$?
say "\$ avo commit --dry-run -> exit $code $(printf '%s' "$out" | jq -c '{action,version}')"
if [[ $code -eq 0 ]] && printf '%s' "$out" | jq -e '.action == "would-commit" and .sha == null' >/dev/null &&
  [[ "$head_before" == "$(ingit rev-parse HEAD)" ]]; then
  ok "--dry-run reports the decision and writes nothing"
else
  bad "--dry-run was not read-only"
fi

# ---------------------------------------------------------------- 7. v2
out="$(avo commit --cwd "$fixture" --why "dropped the padding comment" --json)"
code=$?
say "\$ avo commit (smaller and correct) -> exit $code"
say "  $(printf '%s' "$out" | jq -c '{action,version,lineage_file,reason}')"
if [[ $code -eq 0 ]] && printf '%s' "$out" | jq -e '.action == "committed" and .version == 2' >/dev/null; then
  ok "an improvement becomes v2"
else
  bad "the improvement was not committed"
fi

# ---------------------------------------------------------------- 8. the acceptance case
out="$(avo lineage --cwd "$fixture" --json)"
say "\$ avo lineage --json | jq 'length' -> $(printf '%s' "$out" | jq 'length')"
if printf '%s' "$out" | jq -e 'length == 2' >/dev/null; then
  ok "S2 acceptance: two committed versions after v1, a refused regression, and v2"
else
  bad "the lineage did not hold exactly two versions"
fi
if printf '%s' "$out" | jq -e '[.[].version] == [1,2] and (.[1].score.primary < .[0].score.primary)' >/dev/null; then
  ok "the lineage is ordered and monotone under the metric's own direction"
else
  bad "the lineage was not monotone"
fi

say ""
say "\$ avo lineage"
avo lineage --cwd "$fixture" | tee -a "$evidence"

out="$(avo best --cwd "$fixture" --json)"
if printf '%s' "$out" | jq -e '.version == 2' >/dev/null; then
  ok "avo best names the version a candidate is ranked against"
else
  bad "avo best did not report v2"
fi

if avo lineage diff 1 2 --cwd "$fixture" | grep -q 'impl.sh'; then
  ok "avo lineage diff shows the patch between two versions"
else
  bad "avo lineage diff showed no patch"
fi
if avo lineage show 2 --cwd "$fixture" | grep -q 'dropped the padding comment'; then
  ok "avo lineage show recovers the agent's rationale"
else
  bad "avo lineage show lost the rationale"
fi
if avo lineage show 9 --cwd "$fixture" >/dev/null 2>&1; then
  bad "avo lineage show invented a missing version"
else
  ok "avo lineage show exits non-zero for a version that does not exist"
fi

# ---------------------------------------------------------------- 9. invariant 1
say ""
trailers="$(ingit log --format=%B | grep -c '^Avo-Version:')"
versions="$(avo lineage --cwd "$fixture" --json | jq 'length')"
say "Avo-Version trailers in git: $trailers; versions reported: $versions"
if [[ "$trailers" == "$versions" ]]; then
  ok "invariant 1: every committed version came from avo commit, and none was lost"
else
  bad "trailer count and lineage length disagree"
fi

say ""
if [[ $fails -eq 0 ]]; then
  say "all checks passed"
else
  say "$fails check(s) failed"
fi
exit $((fails > 0 ? 1 : 0))
