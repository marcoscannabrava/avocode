#!/usr/bin/env bash
# Materialize an avocode optimization target into a fresh git repo of its own, and verify one that
# has already been optimized.
#
#   bench/init.sh <dest> [--target fuzzysearch] [--force]
#   bench/init.sh --verify <dest> [--target fuzzysearch]
#
# Why a separate repo and not a directory in avocode: `avo commit` writes `Avo-Version` commits into
# the repo it is pointed at. A target living inside this checkout would put the loop's whole lineage
# into avocode's own history, and every score would be measuring a tree the loop is also editing.
# That is the self-perturbation bug S3, S6 and S8 each hit once; this script refuses it outright.
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

die() { printf 'bench/init.sh: %s\n' "$*" >&2; exit 1; }

target=fuzzysearch
force=false
verify=false
dest=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --verify) verify=true; shift ;;
    --force) force=true; shift ;;
    --target) [[ -n "${2-}" ]] || die "--target needs a value"; target="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) die "unknown option '$1'" ;;
    *) [[ -z "$dest" ]] || die "one destination at a time (got '$dest' and '$1')"; dest="$1"; shift ;;
  esac
done

[[ -n "$dest" ]] || die "need a destination directory"
src="$root/bench/$target"
[[ -d "$src" ]] || die "no such target '$target' (have: $(cd "$root/bench" && find . -mindepth 1 -maxdepth 1 -type d -printf '%f ' ))"

# The protected set: every file that is part of `f`. `avo/score` is listed at its materialized path
# because that is where the hash has to match.
protected=(bench/reference.js bench/corpus.js bench/run.js test/search.test.js .avo/score)

# Template path -> materialized path. Only `avo/` moves, so that the template dir stays greppable
# and does not collide with an `.avo` of avocode's own.
materialized() { case "$1" in avo/*) printf '.avo/%s' "${1#avo/}" ;; *) printf '%s' "$1" ;; esac; }

template_files() { (cd "$src" && find . -type f -printf '%P\n' | sort); }

# ---------------------------------------------------------------- --verify
if [[ "$verify" == true ]]; then
  [[ -d "$dest" ]] || die "$dest does not exist"
  drift=0
  for p in "${protected[@]}"; do
    tpl="$src/$p"
    [[ "$p" == .avo/* ]] && tpl="$src/avo/${p#.avo/}"
    if [[ ! -f "$dest/$p" ]]; then
      printf 'MISSING   %s\n' "$p"
      drift=$((drift + 1))
    elif ! cmp -s "$tpl" "$dest/$p"; then
      printf 'MODIFIED  %s\n' "$p"
      drift=$((drift + 1))
    else
      printf 'ok        %s\n' "$p"
    fi
  done
  if [[ $drift -gt 0 ]]; then
    printf '\n%d protected file(s) differ from bench/%s -- f was edited, so the scores it produced do not mean what they say.\n' "$drift" "$target" >&2
    exit 1
  fi
  printf '\nf is intact: %d protected file(s) match bench/%s.\n' "${#protected[@]}" "$target"
  exit 0
fi

# ---------------------------------------------------------------- materialize
# Refuse to write inside this checkout, however the path is spelled.
abs_dest="$(cd -- "$(dirname -- "$dest")" 2>/dev/null && pwd)/$(basename -- "$dest")" || die "cannot resolve the parent of '$dest'"
case "$abs_dest/" in
  "$root"/*) die "$abs_dest is inside avocode ($root). The target needs its own repo -- try \$(mktemp -d)/$target or ~/work/$target." ;;
esac

if [[ -e "$abs_dest" ]]; then
  if [[ "$force" != true ]]; then
    [[ -d "$abs_dest" ]] || die "$abs_dest exists and is not a directory"
    [[ -z "$(ls -A "$abs_dest")" ]] || die "$abs_dest is not empty -- pass --force to overwrite the target files in it"
  fi
  [[ -d "$abs_dest" ]] || die "$abs_dest exists and is not a directory"
fi

mkdir -p "$abs_dest"
while read -r p; do
  out="$abs_dest/$(materialized "$p")"
  mkdir -p "$(dirname -- "$out")"
  cp "$src/$p" "$out"
done < <(template_files)
chmod +x "$abs_dest/.avo/score"

# The gate hashes are GENERATED here rather than checked in, so the template files stay the single
# source of truth: edit one and the next materialization records the new hash, with nothing to
# forget to update.
(cd "$abs_dest" && sha256sum "${protected[@]}" > .avo/gate.sha256)

if [[ ! -d "$abs_dest/.git" ]]; then
  git -C "$abs_dest" init -q
  git -C "$abs_dest" config user.email "avo@example.com"
  git -C "$abs_dest" config user.name "avo bench"
fi
printf 'node_modules/\n' > "$abs_dest/.gitignore"
git -C "$abs_dest" add -A
if [[ -n "$(git -C "$abs_dest" status --porcelain)" ]]; then
  git -C "$abs_dest" commit -qm "$target v0: correct and slow

The baseline. src/search.js is the candidate; everything hashed in .avo/gate.sha256 is f."
fi

cat <<EOF
materialized bench/$target -> $abs_dest

  $(cd "$abs_dest" && git log --oneline -1)

next:
  avo init --cwd "$abs_dest"        # .avo/.gitignore, K, memory (config + scorer are already here)
  (cd "$abs_dest" && .avo/score | jq .)
  avo run --cwd "$abs_dest" ...     # the loop
  bench/init.sh --verify "$abs_dest"  # afterwards: was f still f?
EOF
