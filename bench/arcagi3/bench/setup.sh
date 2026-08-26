#!/usr/bin/env bash
# PROTECTED -- this file is part of `f`. Editing it makes `bench/init.sh --verify` fail.
#
# One-time setup for the arcagi3 target: a virtualenv with the ARC-AGI-3 toolkit, and the pinned
# game corpus. Both are gitignored, so neither is ever part of a candidate's diff.
#
#   bench/setup.sh              venv + games
#   bench/setup.sh --games-only fetch and verify the corpus into bench/games/
#   bench/setup.sh --check      report what is present; exit 1 if anything is missing
#
# The corpus is fetched at a pinned commit and verified against bench/games.lock, which is itself
# hashed into .avo/gate.sha256. A game file that changes changes what `f` measures, so the chain has
# to hold end to end.
set -uo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname -- "$here")"
cd "$root" || exit 2

UPSTREAM="https://github.com/theredbluepill/arc-interactive.git"
COMMIT="b6cbf21a36f029882b72c702bbbfd45455ce330d"

die() { printf 'bench/setup.sh: %s\n' "$*" >&2; exit 2; }
say() { printf '%s\n' "$*"; }

games_only=false
check=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --games-only) games_only=true; shift ;;
    --check) check=true; shift ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option '$1'" ;;
  esac
done

# ---------------------------------------------------------------------------- --check
if [[ "$check" == true ]]; then
  missing=0
  if [[ -x .venv/bin/python ]] && .venv/bin/python -c 'import arc_agi' 2>/dev/null; then
    say "ok       .venv with the arc-agi toolkit"
  else
    say "MISSING  .venv with the arc-agi toolkit"; missing=$((missing + 1))
  fi
  if [[ -d bench/games ]] && sha256sum -c --quiet bench/games.lock 2>/dev/null; then
    say "ok       bench/games matches bench/games.lock"
  else
    say "MISSING  bench/games matching bench/games.lock"; missing=$((missing + 1))
  fi
  exit $(( missing > 0 ))
fi

# ---------------------------------------------------------------------------- the venv
if [[ "$games_only" != true ]]; then
  # arc-agi needs >= 3.12. Prefer the newest interpreter that satisfies it rather than whatever
  # `python3` happens to be, so a box with an old default still works.
  py=""
  for cand in python3.14 python3.13 python3.12 python3; do
    command -v "$cand" >/dev/null 2>&1 || continue
    if "$cand" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)' 2>/dev/null; then
      py="$cand"; break
    fi
  done
  [[ -n "$py" ]] || die "no python >= 3.12 on PATH; the arc-agi toolkit requires it"

  if [[ ! -x .venv/bin/python ]]; then
    say "creating .venv with $py ($("$py" --version 2>&1))"
    "$py" -m venv .venv || die "could not create .venv"
  fi
  say "installing requirements.txt"
  .venv/bin/python -m pip install -q --upgrade pip >/dev/null 2>&1
  .venv/bin/python -m pip install -q -r requirements.txt || die "pip install failed"
  .venv/bin/python -c 'import arc_agi, arcengine' || die "the toolkit installed but does not import"
fi

# ---------------------------------------------------------------------------- the games
if [[ ! -d bench/games ]] || ! sha256sum -c --quiet bench/games.lock 2>/dev/null; then
  command -v git >/dev/null || die "git is required to fetch the game corpus"
  say "fetching the game corpus at $COMMIT"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  git clone -q --filter=blob:none --no-checkout "$UPSTREAM" "$tmp/src" || die "could not clone $UPSTREAM"
  git -C "$tmp/src" sparse-checkout set --cone environment_files >/dev/null 2>&1 \
    || die "could not sparse-checkout environment_files"
  git -C "$tmp/src" checkout -q "$COMMIT" || die "could not check out $COMMIT"

  # Copy only the games the lock names, so the target never holds a game `f` does not measure --
  # and never holds a holdout game.
  mkdir -p bench/games
  while read -r want; do
    src="$tmp/src/environment_files/$want"
    [[ -d "$src" ]] || die "the pinned commit has no game '$want'"
    rm -rf "bench/games/$want"
    cp -r "$src" "bench/games/$want"
  done < <(sed -n 's|^[0-9a-f]\{64\}  bench/games/\([^/]*\)/.*|\1|p' bench/games.lock | sort -u)
fi

if ! drift="$(sha256sum -c --quiet bench/games.lock 2>&1)"; then
  printf 'bench/setup.sh: the fetched corpus does not match bench/games.lock:\n%s\n' "$drift" >&2
  exit 2
fi
say "ok       bench/games matches bench/games.lock ($(grep -c '^[0-9a-f]' bench/games.lock) files)"

if [[ "$games_only" != true ]]; then
  say ""
  say "next:  .avo/score | jq ."
fi
