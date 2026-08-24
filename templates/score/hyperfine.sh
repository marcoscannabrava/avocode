#!/usr/bin/env bash
# avo scorer — wall-clock time via hyperfine, correctness via the project's own test suite.
# Metric: mean seconds, lower is better.
#
# The f contract (see templates/score/README.md):
#   .avo/score                   one JSON line scoring every config
#   .avo/score --configs         config names, one per line (this is what `avo score --parallel` reads)
#   .avo/score --config <name>   one JSON line scoring just that config
# Always exits 0 — failures are reported *in* the JSON so the agent gets a diagnosable payload.
set -uo pipefail

# ---- EDIT THIS BLOCK -------------------------------------------------------
# One "name=command" per benchmarked config. Names must match [A-Za-z0-9._-]+.
CONFIGS=(
  "default=./bench.sh"
)
# Must exit 0 iff the candidate is correct. This is the gate: a failure here can never commit.
CORRECTNESS_CMD="npm test"
WARMUP=1
RUNS=10
# ---------------------------------------------------------------------------

UNIT="s"
HIGHER_IS_BETTER=false

emit() { # $1=ok $2=correct $3=log
  jq -cn --argjson ok "$1" --argjson correct "$2" --arg log "$3" --arg unit "$UNIT" \
    --argjson hib "$HIGHER_IS_BETTER" --argjson d "$SECONDS" \
    '{ok:$ok,correct:$correct,primary:null,unit:$unit,higher_is_better:$hib,log:$log,duration_s:$d}'
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

command -v jq >/dev/null 2>&1 || { printf '{"ok":false,"correct":false,"primary":null,"unit":"s","higher_is_better":false,"log":"jq not found on PATH"}\n'; exit 0; }
command -v hyperfine >/dev/null 2>&1 \
  || emit false false "hyperfine not found on PATH — https://github.com/sharkdp/hyperfine#installation"

if ! correctness_log="$(bash -c "$CORRECTNESS_CMD" 2>&1)"; then
  emit true false "correctness command failed: $CORRECTNESS_CMD
$correctness_log"
fi

scores="{}"
for entry in "${CONFIGS[@]}"; do
  name="${entry%%=*}"
  cmd="${entry#*=}"
  if [[ "$mode" == one && "$name" != "$want" ]]; then continue; fi
  tmp="$(mktemp)"
  if ! hyperfine --warmup "$WARMUP" --runs "$RUNS" --style none --export-json "$tmp" "$cmd" >/dev/null 2>&1; then
    log="$(cat "$tmp" 2>/dev/null)"
    rm -f "$tmp"
    emit false true "hyperfine failed on config '$name' ($cmd)
$log"
  fi
  mean="$(jq -r '.results[0].mean' "$tmp")"
  rm -f "$tmp"
  scores="$(jq -c --arg n "$name" --argjson v "$mean" '. + {($n): $v}' <<<"$scores")"
done

[[ "$scores" != "{}" ]] || emit true false "no config matched '$want'"

primary="$(jq -r '[.[]] | add / length' <<<"$scores")"
jq -cn --argjson scores "$scores" --argjson primary "$primary" --arg unit "$UNIT" \
  --argjson hib "$HIGHER_IS_BETTER" --argjson d "$SECONDS" \
  '{ok:true,correct:true,primary:$primary,unit:$unit,higher_is_better:$hib,scores:$scores,duration_s:$d}'
