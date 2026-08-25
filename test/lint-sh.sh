#!/usr/bin/env bash
# The shellcheck half of `just lint`. Split out of the justfile because a gate a `||` can
# swallow is not a gate (#2): for eight slices this ran in CI, found 32 things, and reported
# itself as "shellcheck: skipped (not installed)" while the job went green.
#
# Two failure-open holes are closed here, not one:
#   1. A missing binary used to mean "skip". shellcheck ships on npm, so absence is no longer
#      an excuse to skip -- and if no runner can be resolved at all, that is a hard failure
#      with an install hint, never a silent pass.
#   2. The file list was hand-maintained in the justfile, so a new script stayed unchecked
#      until someone remembered to add it. The list is discovered from git instead, and
#      includes untracked-but-not-ignored files so a script is checked before it is committed.
set -uo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 1

# --- which shellcheck -------------------------------------------------------------------
# The version is pinned because the findings are not stable across versions: 0.9.0 (what
# `apt install shellcheck` gives on ubuntu-latest) reports 20 SC2317 "unreachable command" hits
# on ralph.sh's trap bodies that 0.11.0 does not, having replaced them with one SC2329 per
# function. A gate whose verdict depends on the machine is a gate that goes red in CI and green
# on the laptop, which is how the last one got ignored.
#
# Resolution prefers a runner AT the pin over a faster one at the wrong version:
#   $SHELLCHECK   an explicit override; disables every fallback, so the no-runner path is
#                 testable (test/e2e-lint.sh) without uninstalling anything
#   PATH          only when it already is the pinned version
#   npm           `npm exec --yes -- shellcheck` — the npm package downloads the official
#                 binary on first use, so no install and no apt-get is needed anywhere
#   PATH again    any version, last resort for an offline checkout, and it says so loudly
SC_PIN="0.11.0"

sc_version() { "$@" --version 2>/dev/null | sed -n 's/^version: *//p' | head -1; }

sc=()
if [[ -n "${SHELLCHECK:-}" ]]; then
  read -r -a sc <<<"$SHELLCHECK"
  if ! "${sc[@]}" --version >/dev/null 2>&1; then sc=(); fi
elif command -v shellcheck >/dev/null 2>&1 && [[ "$(sc_version shellcheck)" == "$SC_PIN" ]]; then
  sc=(shellcheck)
elif npm exec --yes -- shellcheck --version >/dev/null 2>&1; then
  sc=(npm exec --yes -- shellcheck)
elif command -v shellcheck >/dev/null 2>&1; then
  sc=(shellcheck)
fi

if (( ${#sc[@]} == 0 )); then
  echo "lint-sh: no shellcheck available -- refusing to pass a gate that did not run (#2)" >&2
  echo "lint-sh: install it (apt install shellcheck / brew install shellcheck) or leave the" >&2
  echo "lint-sh: npm fallback reachable (npm exec --yes -- shellcheck --version)" >&2
  exit 1
fi

got="$(sc_version "${sc[@]}")"
if [[ -n "$got" && "$got" != "$SC_PIN" ]]; then
  echo "lint-sh: shellcheck $got, not the pinned $SC_PIN -- findings may differ from CI" >&2
fi

# --- what to check ----------------------------------------------------------------------
# A `.sh` name, or a shell shebang on anything else (bin/avo, templates/score/*, .avo/score).
targets=()
while IFS= read -r -d '' f; do
  [[ -f $f ]] || continue
  case "$f" in
    *.sh) targets+=("$f"); continue ;;
  esac
  first=""
  IFS= read -r first < "$f" 2>/dev/null || true
  if [[ "${first%$'\r'}" =~ ^#!.*[[:space:]/](sh|bash|dash|ksh)([[:space:]]|$) ]]; then
    targets+=("$f")
  fi
done < <(git ls-files -z --cached --others --exclude-standard)

if (( ${#targets[@]} == 0 )); then
  echo "lint-sh: found no shell scripts -- discovery is broken, not the repo" >&2
  exit 1
fi

if [[ "${1:-}" == "--list" ]]; then
  printf '%s\n' "${targets[@]}"
  exit 0
fi

"${sc[@]}" -S style -- "${targets[@]}"
code=$?
if (( code != 0 )); then
  echo "lint-sh: shellcheck failed on ${#targets[@]} scripts (exit $code) -- lint is red" >&2
fi
exit $code
