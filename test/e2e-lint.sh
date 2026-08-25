#!/usr/bin/env bash
# End-to-end checks for the shellcheck gate itself (#2). This suite exists because the gate
# spent eight slices unable to fail: `just lint` ended the shellcheck line with
# `|| echo "shellcheck: skipped (not installed)"`, so CI installed shellcheck, ran it, collected
# 32 findings and went green while printing a reason that was not true. A gate nothing tests is
# a gate that reports whatever it likes, so every assertion below is about the gate going RED.
# Writes evidence/lint-gate-e2e.txt.
set -uo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 1

evidence="$root/evidence/lint-gate-e2e.txt"
mkdir -p "$root/evidence"
: > "$evidence"

fails=0
say() { printf '%s\n' "$*" | tee -a "$evidence"; }
ok()   { say "PASS  $*"; }
bad()  { say "FAIL  $*"; fails=$((fails + 1)); }
yes_no() { if [[ $1 == 0 ]]; then ok "$2"; else bad "$3"; fi; }

# An untracked-but-not-ignored script: it doubles as the probe for "a finding turns the gate red"
# and for "a script is checked before anyone remembers to `git add` it".
probe="$root/test/tmp-lint-probe.sh"
trap 'rm -f "$probe"' EXIT
rm -f "$probe"

say "# avo lint-gate e2e — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "# $(npm exec --yes -- shellcheck --version 2>/dev/null | grep ^version || echo 'version: unknown')"
say ""

say "## 1. the gate is green on this repo, and says nothing about skipping"
clean_out="$(./test/lint-sh.sh 2>&1)"; clean_code=$?
yes_no "$clean_code" "./test/lint-sh.sh exits 0 on a clean tree" "the tree is not clean: $clean_out"
if printf '%s' "$clean_out" | grep -qiE 'skip'; then
  bad "a green run still talks about skipping: $clean_out"
else
  ok "a green run claims nothing it did not do"
fi
say ""

say "## 2. a finding turns the gate RED — the case #2 could not detect"
cat > "$probe" <<'PROBE'
#!/usr/bin/env bash
cd /tmp
echo $1
PROBE
listed="$(./test/lint-sh.sh --list | grep -cx 'test/tmp-lint-probe.sh')"
if [[ "$listed" == 1 ]]; then ok "an untracked script is discovered, not waiting on a hand-edited file list"
else bad "the probe was not in --list, so a new script would go unchecked"; fi
dirty_out="$(./test/lint-sh.sh 2>&1)"; dirty_code=$?
if [[ $dirty_code -ne 0 ]]; then ok "the gate exits non-zero when shellcheck finds something (exit $dirty_code)"
else bad "the gate exited 0 with a broken script in the tree — #2 is back"; fi
printf '%s' "$dirty_out" | grep -qF 'SC2164'
yes_no $? "the finding is reported, not just counted" "no SC2164 in the output"
rm -f "$probe"
say ""

say "## 3. no shellcheck means FAIL, not skip"
missing_out="$(SHELLCHECK=/nonexistent/shellcheck ./test/lint-sh.sh 2>&1)"; missing_code=$?
if [[ $missing_code -ne 0 ]]; then ok "an unrunnable shellcheck exits non-zero (exit $missing_code)"
else bad "an unrunnable shellcheck exited 0 — that is exactly #2"; fi
printf '%s' "$missing_out" | grep -qF 'refusing to pass a gate that did not run'
yes_no $? "it says why it failed" "the message was: $missing_out"
printf '%s' "$missing_out" | grep -qiE 'install it|npm fallback'
yes_no $? "it says how to fix it" "no install hint in: $missing_out"
say ""

say "## 4. just lint propagates the gate rather than swallowing it"
recipe="$(sed -n '/^lint:/,/^$/p' justfile)"
printf '%s' "$recipe" | grep -qF './test/lint-sh.sh'
yes_no $? "the lint recipe calls the gate" "lint: does not call test/lint-sh.sh"
if printf '%s' "$recipe" | grep -qE '\|\||; *true'; then
  bad "the lint recipe still has an escape hatch: $recipe"
else
  ok "the lint recipe has no || and no ; true to swallow an exit code"
fi
if command -v just >/dev/null 2>&1; then
  cat > "$probe" <<'PROBE'
#!/usr/bin/env bash
cd /tmp
PROBE
  just lint >/dev/null 2>&1; just_code=$?
  rm -f "$probe"
  if [[ $just_code -ne 0 ]]; then ok "just lint itself goes red on a finding (exit $just_code)"
  else bad "just lint exited 0 with a broken script present"; fi
else
  say "SKIP  just is not installed; the recipe was checked as text only"
fi
say ""

say "# $(grep -c '^PASS' "$evidence") checks passed, $fails failed"
exit $((fails > 0 ? 1 : 0))
