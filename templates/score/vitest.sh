#!/usr/bin/env bash
# avo scorer — pass-rate from vitest's JSON reporter. Higher is better.
#
#   correct = the suite is runnable
#   primary = the pass rate you are optimizing
# Set REQUIRE_ALL_PASS=true when a green suite should instead be the commit gate.
set -uo pipefail

# ---- EDIT THIS BLOCK -------------------------------------------------------
VITEST_CMD="npx vitest run"
# One "name=extra vitest args" per config; used by --configs / --config.
CONFIGS=(
  "all="
)
REQUIRE_ALL_PASS=false
# ---------------------------------------------------------------------------

UNIT="pass-rate"

emit() { # $1=ok $2=correct $3=log
  jq -cn --argjson ok "$1" --argjson correct "$2" --arg log "$3" --arg unit "$UNIT" --argjson d "$SECONDS" \
    '{ok:$ok,correct:$correct,primary:null,unit:$unit,higher_is_better:true,log:$log,duration_s:$d}'
  exit 0
}

mode=all
want=""
case "${1-}" in
  --configs)
    for entry in "${CONFIGS[@]}"; do printf '%s\n' "${entry%%=*}"; done
    exit 0
    ;;
  --config)
    mode=one
    want="${2-}"
    [[ -n "$want" ]] || emit true false "--config needs a config name"
    ;;
  "") ;;
  *) emit true false "unknown argument '$1'" ;;
esac

command -v jq >/dev/null 2>&1 || { printf '{"ok":false,"correct":false,"primary":null,"unit":"pass-rate","higher_is_better":true,"log":"jq not found on PATH"}\n'; exit 0; }

scores="{}"
log=""
for entry in "${CONFIGS[@]}"; do
  name="${entry%%=*}"
  extra="${entry#*=}"
  if [[ "$mode" == one && "$name" != "$want" ]]; then continue; fi
  tmp="$(mktemp)"
  bash -c "$VITEST_CMD --reporter=json --outputFile=$tmp $extra" >/dev/null 2>&1
  if ! jq -e 'has("numTotalTests")' "$tmp" >/dev/null 2>&1; then
    report="$(head -c 4000 "$tmp" 2>/dev/null)"
    rm -f "$tmp"
    emit false false "vitest produced no JSON report for config '$name'
$report"
  fi
  passed="$(jq -r '.numPassedTests' "$tmp")"
  total="$(jq -r '.numTotalTests' "$tmp")"
  rm -f "$tmp"
  if [[ "$total" -eq 0 ]]; then emit true false "vitest found no tests for config '$name'"; fi
  rate="$(jq -n --argjson p "$passed" --argjson t "$total" '$p / $t')"
  scores="$(jq -c --arg n "$name" --argjson v "$rate" '. + {($n): $v}' <<<"$scores")"
  log="$log
[$name] $passed/$total passed"
done

[[ "$scores" != "{}" ]] || emit true false "no config matched '$want'"

primary="$(jq -r '[.[]] | add / length' <<<"$scores")"
correct=true
if [[ "$REQUIRE_ALL_PASS" == true ]] && [[ "$(jq -r 'if $p < 1 then "no" else "yes" end' -n --argjson p "$primary")" == no ]]; then
  correct=false
fi
jq -cn --argjson scores "$scores" --argjson primary "$primary" --argjson correct "$correct" \
  --arg unit "$UNIT" --arg log "$log" --argjson d "$SECONDS" \
  '{ok:true,correct:$correct,primary:$primary,unit:$unit,higher_is_better:true,scores:$scores,log:$log,duration_s:$d}'
