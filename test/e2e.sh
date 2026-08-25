#!/usr/bin/env bash
# End-to-end checks against the real `bin/avo` binary. Writes evidence/s0-e2e.txt.
set -uo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 1

evidence="$root/evidence/s0-e2e.txt"
mkdir -p "$root/evidence"
: > "$evidence"

fails=0
say() { printf '%s\n' "$*" | tee -a "$evidence"; }
ok()   { say "PASS  $*"; }
bad()  { say "FAIL  $*"; fails=$((fails + 1)); }

say "# avo S0 e2e — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "# node $(node --version), $(git --version)"
say ""

# 1. --version prints exactly the package version.
want="$(jq -r .version package.json)"
got="$(./bin/avo --version)"
say "\$ ./bin/avo --version -> $got"
if [[ "$got" == "$want" ]]; then ok "version matches package.json ($want)"
else bad "version: want $want, got $got"; fi

# 2. help exits 0 and mentions doctor.
./bin/avo --help > /tmp/avo-help.$$ 2>&1
help_code=$?
say "\$ ./bin/avo --help -> exit $help_code"
if [[ $help_code -eq 0 ]] && grep -q doctor /tmp/avo-help.$$; then
  ok "help exits 0 and documents doctor"
else bad "help broken (exit $help_code)"; fi
rm -f /tmp/avo-help.$$

# 3. unknown command exits 2.
./bin/avo frobnicate > /dev/null 2>&1
unknown_code=$?
say "\$ ./bin/avo frobnicate -> exit $unknown_code"
if [[ $unknown_code -eq 2 ]]; then ok "unknown command exits 2"
else bad "unknown command: want exit 2, got $unknown_code"; fi

# 4. doctor --json is a single parseable line with the expected shape.
json="$(./bin/avo doctor --json)"
doctor_code=$?
say "\$ ./bin/avo doctor --json -> exit $doctor_code"
say "$json" | jq -c '{ok, version, deps: (.deps|length), missing: [.deps[]|select(.present==false)|.name]}' \
  | tee -a "$evidence" >/dev/null
if printf '%s' "$json" | jq -e 'has("ok") and has("deps") and has("keys") and has("problems")' >/dev/null; then
  ok "doctor --json has ok/deps/keys/problems"
else
  bad "doctor --json shape wrong"
fi
if [[ "$(printf '%s' "$json" | wc -l)" -eq 0 ]]; then ok "doctor --json is one line"
else bad "doctor --json is multi-line"; fi

# 5. Invariant 6: no API key value ever appears in output, even when one is set.
canary="sk-avo-e2e-canary-must-not-leak"
keyed_json="$(ANTHROPIC_API_KEY="$canary" ./bin/avo doctor --json)"
keyed_text="$(ANTHROPIC_API_KEY="$canary" ./bin/avo doctor)"
if printf '%s\n%s' "$keyed_json" "$keyed_text" | grep -qF "$canary"; then
  bad "doctor leaked an API key value"
else
  ok "doctor reports key presence without leaking the value"
fi
if [[ "$(printf '%s' "$keyed_json" | jq -r '.keys[]|select(.name=="ANTHROPIC_API_KEY")|.set')" == "true" ]]; then
  ok "a set key is reported as present"
else
  bad "a set key was not reported as present"
fi

# 6. The S0 acceptance case: with required deps absent, doctor exits non-zero
#    and prints a readable list. Sandbox PATH keeps only what bin/avo itself needs.
sandbox="$(mktemp -d)"
mkdir -p "$sandbox/bin"
for c in env bash node dirname; do ln -sf "$(command -v "$c")" "$sandbox/bin/$c"; done
out="$(PATH="$sandbox/bin" ./bin/avo doctor 2>&1)"
code=$?
say ""
say "\$ PATH=<node+bash only> ./bin/avo doctor -> exit $code"
printf '%s\n' "$out" | sed 's/^/    /' >> "$evidence"
if [[ $code -ne 0 ]]; then ok "doctor exits non-zero when required deps are missing (exit $code)"
else bad "doctor exited 0 with git and jq missing"; fi
for expect in "required dependency 'git'" "required dependency 'jq'" "no coding agent found"; do
  if printf '%s' "$out" | grep -qF "$expect"; then ok "reports: $expect"
  else bad "missing from output: $expect"; fi
done
if printf '%s' "$out" | grep -qF "https://jqlang.org/download/"; then
  ok "includes an install hint"
else bad "no install hint in output"; fi
rm -rf "$sandbox"

say ""
if [[ $fails -eq 0 ]]; then
  say "e2e: all checks passed"
else
  say "e2e: $fails check(s) failed"
fi
exit $((fails > 0))
