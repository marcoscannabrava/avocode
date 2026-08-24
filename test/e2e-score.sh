#!/usr/bin/env bash
# End-to-end checks for `avo score` (S1) against a real fixture repo with a real .avo/score.
# Writes evidence/s1-e2e.txt.
set -uo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 1

evidence="$root/evidence/s1-e2e.txt"
mkdir -p "$root/evidence"
: > "$evidence"

fails=0
say() { printf '%s\n' "$*" | tee -a "$evidence"; }
ok()   { say "PASS  $*"; }
bad()  { say "FAIL  $*"; fails=$((fails + 1)); }

fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT

avo() { "$root/bin/avo" "$@"; }

say "# avo S1 e2e — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "# node $(node --version), $(git --version), jq $(jq --version)"
say "# fixture: a repo whose candidate must print 42; the metric is code size (lower is better)"
say ""

git -C "$fixture" init -q
git -C "$fixture" config user.email avo@example.com
git -C "$fixture" config user.name avo
printf 'echo 42\n' > "$fixture/impl.sh"
git -C "$fixture" add impl.sh
git -C "$fixture" commit -qm "fixture v0"

# ---------------------------------------------------------------- 1. --init
out="$(avo score --init hyperfine --cwd "$fixture" --json)"
code=$?
say "\$ avo score --init hyperfine -> exit $code $out"
if [[ $code -eq 0 ]] && printf '%s' "$out" | jq -e '.action == "created"' >/dev/null; then
  ok "--init scaffolds .avo/score"
else
  bad "--init did not create the scorer"
fi
if [[ -x "$fixture/.avo/score" ]]; then ok "the scaffolded scorer is executable"; else bad "scorer is not executable"; fi

before="$(md5sum "$fixture/.avo/score")"
out="$(avo score --init hyperfine --cwd "$fixture" --json)"
after="$(md5sum "$fixture/.avo/score")"
say "\$ avo score --init hyperfine (again) -> $out"
if printf '%s' "$out" | jq -e '.action == "unchanged"' >/dev/null && [[ "$before" == "$after" ]]; then
  ok "--init is idempotent (invariant 5)"
else
  bad "--init was not idempotent"
fi

printf '# hand edit\n' >> "$fixture/.avo/score"
if avo score --init hyperfine --cwd "$fixture" >/dev/null 2>&1; then
  bad "--init clobbered a hand-edited scorer"
else
  ok "--init refuses to clobber an edited scorer"
fi

# Every shipped template must answer --configs before it touches any external tool.
for t in hyperfine pytest vitest; do
  if names="$(bash "$root/templates/score/$t.sh" --configs 2>&1)" && [[ -n "$names" ]]; then
    ok "template $t answers --configs ($(printf '%s' "$names" | tr '\n' ' '))"
  else
    bad "template $t --configs failed: $names"
  fi
done

# ----------------------------------------------- 2. the real fixture scorer
cat > "$fixture/.avo/score" <<'SCORER'
#!/usr/bin/env bash
# Fixture scorer: correctness = impl.sh prints 42; metric = code size in bytes, lower is better.
set -uo pipefail
case "${1-}" in
  --configs) printf 'bytes\nlines\nwords\n'; exit 0 ;;
  --config) want="${2-}" ;;
  *) want="" ;;
esac
got="$(bash impl.sh 2>&1)"
if [[ "$got" != "42" ]]; then
  jq -cn --arg log "expected 42, got '$got'" \
    '{ok:true,correct:false,primary:null,unit:"bytes",higher_is_better:false,log:$log}'
  exit 0
fi
b="$(wc -c < impl.sh | tr -d ' ')"
l="$(wc -l < impl.sh | tr -d ' ')"
w="$(wc -w < impl.sh | tr -d ' ')"
case "$want" in
  bytes) jq -cn --argjson v "$b" '{ok:true,correct:true,primary:$v,unit:"bytes",higher_is_better:false,scores:{bytes:$v}}' ;;
  lines) jq -cn --argjson v "$l" '{ok:true,correct:true,primary:$v,unit:"bytes",higher_is_better:false,scores:{lines:$v}}' ;;
  words) jq -cn --argjson v "$w" '{ok:true,correct:true,primary:$v,unit:"bytes",higher_is_better:false,scores:{words:$v}}' ;;
  "") jq -cn --argjson b "$b" --argjson l "$l" --argjson w "$w" \
        '{ok:true,correct:true,primary:$b,unit:"bytes",higher_is_better:false,scores:{bytes:$b,lines:$l,words:$w},duration_s:0.01}' ;;
  *) jq -cn --arg log "unknown config '$want'" '{ok:false,correct:false,primary:null,unit:"bytes",higher_is_better:false,log:$log}' ;;
esac
SCORER
chmod +x "$fixture/.avo/score"

json="$(avo score --json --cwd "$fixture")"
code=$?
say ""
say "\$ avo score --json -> exit $code"
say "$json" | jq -c '{ok,correct,pass,primary,normalized,unit,scores,configs}' | tee -a "$evidence" >/dev/null
if [[ $code -eq 0 ]] && printf '%s' "$json" | jq -e '.pass == true and .correct == true' >/dev/null; then
  ok "a correct candidate exits 0 and passes"
else
  bad "correct candidate: want exit 0 and pass, got exit $code"
fi
# lower_is_better must be reflected in normalized, so consumers never branch on direction.
if printf '%s' "$json" | jq -e '.normalized == (-.primary)' >/dev/null; then
  ok "normalized flips a lower-is-better metric"
else
  bad "normalized did not flip a lower-is-better metric"
fi
if printf '%s' "$json" | jq -e '.git.head != null and (.git.head | length) == 40 and .git.dirty == true' >/dev/null; then
  ok "the attempt records the git head and dirty state"
else
  bad "git provenance missing from the attempt"
fi
if [[ "$(printf '%s' "$json" | wc -l)" -eq 0 ]]; then ok "score --json is one line"; else bad "score --json is multi-line"; fi

# ---------------------------------- 3. the S1 acceptance case: correct:false
printf 'echo 41\n' > "$fixture/impl.sh"
json="$(avo score --json --cwd "$fixture")"
code=$?
say ""
say "\$ echo 41 > impl.sh; avo score --json -> exit $code"
say "$json" | jq -c '{correct,pass,primary,log,errors}' | tee -a "$evidence" >/dev/null
if printf '%s' "$json" | jq -e '.correct == false' >/dev/null; then
  ok "acceptance: avo score --json | jq -e '.correct == false' passes"
else
  bad "acceptance: .correct was not false for a wrong candidate"
fi
if [[ $code -eq 1 ]]; then
  ok "a failing candidate exits 1 (a result, not an error)"
else
  bad "failing candidate: want exit 1, got $code"
fi
if printf '%s' "$json" | jq -e '.primary == null and .normalized == null and (.errors | length) == 0' >/dev/null; then
  ok "a failing candidate gets the null sentinel with no harness errors"
else
  bad "failing candidate sentinel/errors wrong"
fi
if printf '%s' "$json" | jq -e '.log | test("expected 42, got .41.")' >/dev/null; then
  ok "the scorer's diagnosis reaches the agent in .log"
else
  bad "scorer log lost"
fi
printf 'echo 42\n' > "$fixture/impl.sh"

# -------------------------------------------------------------- 4. --parallel
json="$(avo score --json --parallel --cwd "$fixture")"
code=$?
say ""
say "\$ avo score --json --parallel -> exit $code"
say "$json" | jq -c '{parallel,configs,scores,primary,warnings}' | tee -a "$evidence" >/dev/null
if printf '%s' "$json" | jq -e '.parallel == true and (.configs | length) == 3 and (.scores | keys) == ["bytes","lines","words"]' >/dev/null; then
  ok "--parallel discovers 3 configs and merges their scores"
else
  bad "--parallel did not fan out over the discovered configs"
fi
if [[ $code -eq 0 ]]; then ok "--parallel exits 0 when every config passes"; else bad "--parallel exit $code"; fi

# A scorer with no --configs support must degrade, not crash.
cat > "$fixture/.avo/noconfigs" <<'SCORER'
#!/usr/bin/env bash
printf '{"ok":true,"correct":true,"primary":3,"unit":"bytes","higher_is_better":false}\n'
SCORER
chmod +x "$fixture/.avo/noconfigs"
cp "$fixture/.avo/score" "$fixture/.avo/score.bak"
cp "$fixture/.avo/noconfigs" "$fixture/.avo/score"
json="$(avo score --json --parallel --cwd "$fixture")"
code=$?
say "\$ avo score --parallel against a scorer with no --configs -> exit $code"
if [[ $code -eq 0 ]] && printf '%s' "$json" | jq -e '.parallel == false and (.warnings[0] | test("--parallel requested"))' >/dev/null; then
  ok "--parallel degrades to serial with one warning (invariant 4)"
else
  bad "--parallel did not degrade cleanly: $json"
fi
mv "$fixture/.avo/score.bak" "$fixture/.avo/score"

# ------------------------------------------------- 5. malformed and hanging
cat > "$fixture/.avo/broken" <<'SCORER'
#!/usr/bin/env bash
echo 'linking...'
printf '{"ok":true,"correct":true,"primary":"fast","unit":"bytes","higher_is_better":false}\n'
exit 3
SCORER
chmod +x "$fixture/.avo/broken"
cp "$fixture/.avo/score" "$fixture/.avo/score.bak"
cp "$fixture/.avo/broken" "$fixture/.avo/score"
json="$(avo score --json --cwd "$fixture")"
code=$?
say ""
say "\$ avo score --json against a scorer emitting primary:\"fast\" -> exit $code"
say "$json" | jq -c '{ok,pass,errors}' | tee -a "$evidence" >/dev/null
if [[ $code -eq 2 ]]; then ok "malformed scorer output exits 2 (harness error)"; else bad "malformed output: want exit 2, got $code"; fi
if printf '%s' "$json" | jq -e '.errors[0] | test("field .primary.") and test("fast")' >/dev/null; then
  ok "the error names the offending field and the value received"
else
  bad "malformed output error is not actionable: $json"
fi

printf '#!/usr/bin/env bash\nsleep 30\n' > "$fixture/.avo/score"
chmod +x "$fixture/.avo/score"
start=$SECONDS
json="$(avo score --json --timeout 1 --cwd "$fixture")"
code=$?
elapsed=$((SECONDS - start))
say "\$ avo score --timeout 1 against a sleeping scorer -> exit $code in ${elapsed}s"
if [[ $code -eq 2 ]] && printf '%s' "$json" | jq -e '.errors[0] | test("exceeded the timeout")' >/dev/null; then
  ok "--timeout kills a hanging scorer and reports it (${elapsed}s)"
else
  bad "--timeout did not fire: exit $code, $json"
fi
if [[ $elapsed -lt 10 ]]; then ok "the timeout actually bounded the run"; else bad "the run was not bounded (${elapsed}s)"; fi
mv "$fixture/.avo/score.bak" "$fixture/.avo/score"

# --------------------------------------------------- 6. the attempt log
say ""
lines="$(wc -l < "$fixture/.avo/attempts.jsonl" | tr -d ' ')"
say "\$ wc -l .avo/attempts.jsonl -> $lines"
if [[ "$lines" -eq 6 ]]; then
  ok "every scoring run appended exactly one attempt (6 runs, 6 lines)"
else
  bad "attempts.jsonl has $lines lines, expected 6"
fi
if jq -e -s 'all(has("ts") and has("pass") and has("normalized") and has("configs"))' \
     < "$fixture/.avo/attempts.jsonl" >/dev/null; then
  ok "every recorded attempt has the Attempt shape"
else
  bad "a recorded attempt has the wrong shape"
fi
avo score --json --no-record --cwd "$fixture" >/dev/null
after="$(wc -l < "$fixture/.avo/attempts.jsonl" | tr -d ' ')"
if [[ "$after" -eq "$lines" ]]; then ok "--no-record appends nothing"; else bad "--no-record still appended"; fi
jq -c '{ts,pass,primary,unit,configs}' < "$fixture/.avo/attempts.jsonl" >> "$evidence"

# --------------------------------------------------- 7. no scorer at all
empty="$(mktemp -d)"
out="$(avo score --cwd "$empty" 2>&1)"
code=$?
say ""
say "\$ avo score in a repo with no .avo/score -> exit $code"
printf '%s\n' "$out" | sed 's/^/    /' >> "$evidence"
if [[ $code -eq 2 ]]; then ok "a missing scorer exits 2"; else bad "missing scorer: want exit 2, got $code"; fi
if printf '%s' "$out" | grep -qF -- "--init <hyperfine|pytest|vitest>"; then
  ok "the missing-scorer message says how to scaffold one"
else
  bad "no --init hint in the message"
fi
rm -rf "$empty"

say ""
if [[ $fails -eq 0 ]]; then
  say "e2e-score: all checks passed"
else
  say "e2e-score: $fails check(s) failed"
fi
exit $((fails > 0))
