#!/usr/bin/env bash
# Score an arcagi3 target's current policy on games it has never seen.
#
#   test/fixtures/arcagi3/score-holdout.sh <target-repo> [--json]
#
# `f` cannot catch memorisation from the inside -- the training games are in the target repo, and a
# policy that hardcodes its way through them looks exactly like a policy that learned to play. This
# is the check from outside: the same harness, the same policy, six different games.
#
# It runs the TARGET's own bench/run.py, deliberately. Only the corpus changes, so the holdout
# number and the training number are measured the same way and can be compared.
set -uo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
UPSTREAM="https://github.com/theredbluepill/arc-interactive.git"
COMMIT="b6cbf21a36f029882b72c702bbbfd45455ce330d"

die() { printf 'score-holdout.sh: %s\n' "$*" >&2; exit 2; }

json=false
dest=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) json=true; shift ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option '$1'" ;;
    *) [[ -z "$dest" ]] || die "one target at a time"; dest="$1"; shift ;;
  esac
done
[[ -n "$dest" ]] || die "need a target repo"
dest="$(cd -- "$dest" 2>/dev/null && pwd)" || die "no such directory"
[[ -f "$dest/bench/run.py" ]] || die "$dest is not an arcagi3 target (no bench/run.py)"
[[ -x "$dest/.venv/bin/python" ]] || die "$dest has no .venv -- run its bench/setup.sh first"
command -v jq >/dev/null || die "jq is required"

lock="$here/holdout.lock"
[[ -f "$lock" ]] || die "no holdout.lock beside this script"
games="$(sed -n 's|^[0-9a-f]\{64\}  bench/games/\([^/]*\)/.*|\1|p' "$lock" | sort -u)"
[[ -n "$games" ]] || die "holdout.lock names no games"

# The corpus goes in a temp dir, never into the target: a holdout game that lands in the repo the
# agent is editing has stopped being a holdout.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git clone -q --filter=blob:none --no-checkout "$UPSTREAM" "$work/src" 2>/dev/null \
  || die "could not clone $UPSTREAM"
git -C "$work/src" sparse-checkout set --cone environment_files >/dev/null 2>&1 \
  || die "could not sparse-checkout environment_files"
git -C "$work/src" checkout -q "$COMMIT" || die "could not check out $COMMIT"

mkdir -p "$work/games"
while read -r g; do
  [[ -n "$g" ]] || continue
  [[ -d "$work/src/environment_files/$g" ]] || die "the pinned commit has no game '$g'"
  cp -r "$work/src/environment_files/$g" "$work/games/$g"
done <<<"$games"

# Verify the holdout corpus the same way `f` verifies the training corpus: a holdout that drifted
# measures something other than what it claims.
if ! drift="$(cd "$work" && sed 's|bench/games/|games/|' "$lock" | sha256sum -c --quiet 2>&1)"; then
  printf 'score-holdout.sh: the fetched holdout does not match holdout.lock:\n%s\n' "$drift" >&2
  exit 2
fi

ids="$(tr '\n' ',' <<<"$games" | sed 's/,$//')"
scores="{}"
for g in $games; do
  line="$(cd "$dest" && .venv/bin/python bench/run.py \
    --games-dir "$work/games" --games "$ids" --config "$g" 2>&1)"
  if ! jq -e 'has("ok")' >/dev/null 2>&1 <<<"$line"; then
    printf 'score-holdout.sh: bench/run.py printed no JSON for %s:\n%s\n' "$g" "$(head -c 2000 <<<"$line")" >&2
    exit 2
  fi
  if [[ "$(jq -r '.correct' <<<"$line")" != true ]]; then
    printf 'score-holdout.sh: the policy failed on holdout game %s: %s\n' "$g" "$(jq -r '.log' <<<"$line")" >&2
    exit 1
  fi
  scores="$(jq -c --arg n "$g" --argjson v "$(jq -r '.score' <<<"$line")" '. + {($n): $v}' <<<"$scores")"
done

primary="$(jq -r '[.[]] | add / length' <<<"$scores")"
if [[ "$json" == true ]]; then
  jq -cn --argjson scores "$scores" --argjson primary "$primary" \
    '{primary:$primary,scores:$scores,games:($scores|keys|length)}'
else
  printf 'holdout primary  %s\n' "$primary"
  jq -r 'to_entries[] | "  \(.key)  \(.value)"' <<<"$scores"
fi
