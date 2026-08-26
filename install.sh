#!/usr/bin/env bash
# avocode installer. One command from a fresh clone to a working `avo` on PATH.
#
# It does three things and reports each one as created / unchanged / skipped, because
# invariant 5 (idempotent by construction) applies to the installer too — a second run
# must be safe and must create nothing:
#
#   1. checks the toolchain (node >= 22, npm, git)
#   2. installs the npm dependencies (tsx is what bin/avo executes; there is no build step)
#   3. links bin/avo into a directory on PATH, so `avo` works from any repo
#
# `avo doctor` runs last and is reported, but never changes this script's exit code:
# whether avocode is installed and whether the tools it drives are present are two
# different questions, and conflating them makes a fine install look broken.
#
# Usage:
#   ./install.sh                      link into ~/.local/bin (or $AVO_BIN_DIR)
#   ./install.sh --bin-dir /usr/local/bin
#   ./install.sh --force              replace whatever occupies <bin-dir>/avo
#   ./install.sh --skip-doctor        no dependency report at the end
#   ./install.sh --uninstall          remove the link (never touches the checkout)
set -uo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$root" || exit 1

NODE_MIN=22

bin_dir="${AVO_BIN_DIR:-$HOME/.local/bin}"
force=0
uninstall=0
skip_doctor=0

while (( $# > 0 )); do
  case "$1" in
    --bin-dir) bin_dir="${2:-}"; shift 2 || true ;;
    --bin-dir=*) bin_dir="${1#*=}"; shift ;;
    --force) force=1; shift ;;
    --uninstall) uninstall=1; shift ;;
    --skip-doctor) skip_doctor=1; shift ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown option '$1' (try --help)" >&2; exit 2 ;;
  esac
done

if [[ -z "$bin_dir" ]]; then
  echo "install.sh: --bin-dir needs a directory" >&2
  exit 2
fi

# --- reporting --------------------------------------------------------------------------
# Same vocabulary as `avo init` and `avo install`, so a re-run reads the same way.
bold=""; dim=""; red=""; green=""; yellow=""; reset=""
if [[ -t 1 ]]; then
  bold=$'\033[1m'; dim=$'\033[2m'; red=$'\033[31m'; green=$'\033[32m'
  yellow=$'\033[33m'; reset=$'\033[0m'
fi

step()  { printf '  %-12s %s\n' "$1" "$2"; }
ok()    { step "${green}$1${reset}" "$2"; }
warn()  { step "${yellow}$1${reset}" "$2"; }
die()   { printf '\n%sinstall.sh: %s%s\n' "$red" "$1" "$reset" >&2; exit 1; }

printf '\n%savocode installer%s %s(%s)%s\n\n' "$bold" "$reset" "$dim" "$root" "$reset"

link="$bin_dir/avo"

# --- uninstall --------------------------------------------------------------------------
# Only ever removes a link that points into THIS checkout. Anything else is left alone:
# deleting a stranger's `avo` because it shares a name is not a thing an uninstaller does.
if (( uninstall )); then
  if [[ -L "$link" ]]; then
    target="$(readlink -- "$link")"
    if [[ "$target" == "$root/bin/avo" ]]; then
      rm -f -- "$link"
      ok "removed" "$link"
    else
      warn "skipped" "$link -> $target (not this checkout)"
    fi
  elif [[ -e "$link" ]]; then
    warn "skipped" "$link is not a symlink — remove it yourself"
  else
    ok "unchanged" "$link does not exist"
  fi
  printf '\nThe checkout at %s was not touched. Delete it to finish removing avocode.\n\n' "$root"
  exit 0
fi

# --- 1. toolchain -----------------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "node is not on PATH — avocode needs Node $NODE_MIN or newer (https://nodejs.org)"
node_v="$(node --version)"                 # v22.14.0
node_major="${node_v#v}"; node_major="${node_major%%.*}"
if [[ ! "$node_major" =~ ^[0-9]+$ ]] || (( node_major < NODE_MIN )); then
  die "node $node_v is too old — avocode needs $NODE_MIN or newer (bin/avo runs TypeScript through tsx)"
fi
ok "found" "node $node_v"

command -v npm >/dev/null 2>&1 || die "npm is not on PATH — it ships with Node (https://nodejs.org)"
ok "found" "npm $(npm --version)"

# git is required at runtime, not by this script: the lineage P_t lives in commits.
if command -v git >/dev/null 2>&1; then
  ok "found" "$(git --version)"
else
  warn "missing" "git — required at runtime; avo doctor will say so again"
fi

# --- 2. dependencies --------------------------------------------------------------------
# `npm ci` when there is a lockfile and no tree yet: it is the reproducible one. An existing
# tree gets `npm install`, which is a fast no-op when nothing changed.
printf '\n%sdependencies%s\n' "$bold" "$reset"
if [[ -d node_modules ]]; then
  npm install --no-audit --no-fund >/dev/null 2>&1 || die "npm install failed — run it directly to see why: (cd $root && npm install)"
  ok "unchanged" "node_modules (npm install was a no-op or a top-up)"
elif [[ -f package-lock.json ]]; then
  npm ci --no-audit --no-fund >/dev/null 2>&1 || die "npm ci failed — run it directly to see why: (cd $root && npm ci)"
  ok "created" "node_modules (npm ci, from package-lock.json)"
else
  npm install --no-audit --no-fund >/dev/null 2>&1 || die "npm install failed — run it directly to see why: (cd $root && npm install)"
  ok "created" "node_modules (npm install)"
fi

[[ -x node_modules/.bin/tsx ]] || die "node_modules/.bin/tsx is missing after install — bin/avo cannot run without it"
ok "found" "tsx $(node_modules/.bin/tsx --version 2>/dev/null | head -1)"

# --- 3. the link ------------------------------------------------------------------------
# A symlink, not a copy: `git pull` in this checkout is the whole upgrade path.
printf '\n%savo on PATH%s\n' "$bold" "$reset"
mkdir -p -- "$bin_dir" || die "cannot create $bin_dir — pick another with --bin-dir"

if [[ -L "$link" ]]; then
  current="$(readlink -- "$link")"
  if [[ "$current" == "$root/bin/avo" ]]; then
    ok "unchanged" "$link -> $root/bin/avo"
  elif (( force )); then
    ln -sfn -- "$root/bin/avo" "$link" || die "cannot write $link"
    ok "replaced" "$link -> $root/bin/avo (was $current)"
  else
    die "$link already points at $current — re-run with --force to replace it"
  fi
elif [[ -e "$link" ]]; then
  if (( force )); then
    rm -f -- "$link" || die "cannot remove $link"
    ln -s -- "$root/bin/avo" "$link" || die "cannot write $link"
    ok "replaced" "$link -> $root/bin/avo (was a regular file)"
  else
    die "$link exists and is not a symlink — re-run with --force to replace it"
  fi
else
  ln -s -- "$root/bin/avo" "$link" || die "cannot write $link — pick another with --bin-dir"
  ok "created" "$link -> $root/bin/avo"
fi

# Verify through the link, not through ./bin/avo: resolving its own checkout THROUGH a
# symlink is exactly what breaks when bin/avo stops walking the link chain.
version="$("$link" --version 2>&1)" || die "$link --version failed: $version"
ok "works" "avo $version"

# --- PATH -------------------------------------------------------------------------------
on_path=0
case ":$PATH:" in *":$bin_dir:"*) on_path=1 ;; esac

printf '\n'
if (( on_path )); then
  printf '%sInstalled.%s avo is on your PATH.\n' "$green$bold" "$reset"
else
  # Display strings for the human to paste, never paths this script opens — hence the literal ~.
  rc="your shell rc"
  # shellcheck disable=SC2088
  case "${SHELL##*/}" in
    zsh) rc="~/.zshrc" ;;
    bash) rc="~/.bashrc" ;;
    fish) rc="~/.config/fish/config.fish" ;;
  esac
  printf '%sInstalled, but %s is not on your PATH.%s\n\n' "$yellow$bold" "$bin_dir" "$reset"
  if [[ "${SHELL##*/}" == "fish" ]]; then
    printf '  Add this to %s, then open a new shell:\n\n    fish_add_path %s\n' "$rc" "$bin_dir"
  else
    # The $PATH inside the format string is the line the user pastes, not an expansion here.
    # shellcheck disable=SC2016
    printf '  Add this to %s, then open a new shell:\n\n    export PATH="%s:$PATH"\n' "$rc" "$bin_dir"
  fi
fi

# --- 4. doctor --------------------------------------------------------------------------
if (( ! skip_doctor )); then
  printf '\n%sdependency report%s %s(avo doctor)%s\n\n' "$bold" "$reset" "$dim" "$reset"
  "$link" doctor 2>&1 | sed 's/^/  /'
  printf '\n  %sThis report never fails the install.%s avocode itself is installed;\n' "$dim" "$reset"
  printf '  %sanything missing above is a tool avo drives, with its install line beside it.%s\n' "$dim" "$reset"
fi

printf '\n%sNext:%s  avo init      %sin the repo you want to optimize%s\n' "$bold" "$reset" "$dim" "$reset"
printf '       avo install   %swire your coding agent to avo'"'"'s skills%s\n' "$dim" "$reset"
printf '       avo --help    %severy subcommand%s\n\n' "$dim" "$reset"
