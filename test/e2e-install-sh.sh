#!/usr/bin/env bash
# End-to-end checks for ./install.sh — the fresh-clone path. Writes evidence/install-sh-e2e.txt.
#
# Every assertion here is about a way the installer can silently do nothing useful:
# a link that resolves to the wrong checkout is the one that bit us (#41), because `avo --version`
# through the link fails in a way that only shows up in someone else's repo, days later.
set -uo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 1

evidence="$root/evidence/install-sh-e2e.txt"
mkdir -p "$root/evidence"
: > "$evidence"

fails=0
say() { printf '%s\n' "$*" | tee -a "$evidence"; }
ok()   { say "PASS  $*"; }
bad()  { say "FAIL  $*"; fails=$((fails + 1)); }

sandbox="$(mktemp -d)"
bin="$sandbox/bin"
trap 'rm -rf "$sandbox"' EXIT

say "# install.sh e2e — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "# node $(node --version), bin-dir $bin"
say ""

# 1. A first install creates the link and reports it.
out="$(./install.sh --bin-dir "$bin" --skip-doctor 2>&1)"
code=$?
say "\$ ./install.sh --bin-dir <sandbox> --skip-doctor -> exit $code"
printf '%s\n' "$out" | sed 's/^/    /' >> "$evidence"
if [[ $code -eq 0 ]]; then ok "first install exits 0"
else bad "first install exited $code"; fi
if [[ -L "$bin/avo" ]]; then ok "created a symlink at <bin>/avo"
else bad "no symlink at $bin/avo"; fi
if [[ "$(readlink -- "$bin/avo")" == "$root/bin/avo" ]]; then ok "link points into this checkout"
else bad "link points at $(readlink -- "$bin/avo")"; fi
if printf '%s' "$out" | grep -q "created"; then ok "reports 'created'"
else bad "no 'created' in the step report"; fi

# 2. THE regression this fixes: avo must resolve its own checkout THROUGH the link, from a
#    directory that is not the checkout. bin/avo walking the symlink chain is what makes this
#    work; taking dirname of the link instead looks for src/ next to the link and exits 127.
elsewhere="$(mktemp -d)"
got="$(cd "$elsewhere" && "$bin/avo" --version 2>&1)"
vcode=$?
want="$(jq -r .version package.json)"
say "\$ (cd <elsewhere> && <bin>/avo --version) -> $got (exit $vcode)"
if [[ $vcode -eq 0 && "$got" == "$want" ]]; then ok "avo runs through the link from outside the checkout"
else bad "avo through the link: want $want exit 0, got '$got' exit $vcode"; fi
rm -rf "$elsewhere"

# 3. Invariant 5: a second run creates nothing.
out2="$(./install.sh --bin-dir "$bin" --skip-doctor 2>&1)"
code2=$?
say "\$ ./install.sh (again) -> exit $code2"
if [[ $code2 -eq 0 ]]; then ok "second install exits 0"
else bad "second install exited $code2"; fi
if printf '%s' "$out2" | grep -q "unchanged .*$bin/avo"; then ok "second install reports the link 'unchanged'"
else bad "second install did not report 'unchanged'"; fi
if printf '%s' "$out2" | grep -q "created .*$bin/avo"; then bad "second install created the link again"
else ok "second install created nothing"; fi

# 4. Something else in the way is refused, not clobbered.
other="$sandbox/other-avo"
printf '#!/bin/sh\necho not-avo\n' > "$other"
ln -sfn "$other" "$bin/avo"
out3="$(./install.sh --bin-dir "$bin" --skip-doctor 2>&1)"
code3=$?
say "\$ ./install.sh with a foreign link in the way -> exit $code3"
if [[ $code3 -ne 0 ]] && printf '%s' "$out3" | grep -q -- "--force"; then
  ok "refuses a foreign link and names --force"
else bad "did not refuse a foreign link (exit $code3)"; fi
if [[ "$(readlink -- "$bin/avo")" == "$other" ]]; then ok "left the foreign link alone"
else bad "clobbered the foreign link"; fi

# 5. --force replaces it.
./install.sh --bin-dir "$bin" --skip-doctor --force >/dev/null 2>&1
code4=$?
say "\$ ./install.sh --force -> exit $code4"
if [[ $code4 -eq 0 && "$(readlink -- "$bin/avo")" == "$root/bin/avo" ]]; then ok "--force replaces the link"
else bad "--force did not replace the link (exit $code4)"; fi

# 6. --uninstall removes our link and says the checkout is untouched.
./install.sh --bin-dir "$bin" --uninstall >/dev/null 2>&1
code5=$?
say "\$ ./install.sh --uninstall -> exit $code5"
if [[ $code5 -eq 0 && ! -e "$bin/avo" ]]; then ok "--uninstall removes the link"
else bad "--uninstall left $bin/avo behind (exit $code5)"; fi
if [[ -x "$root/bin/avo" ]]; then ok "--uninstall did not touch the checkout"
else bad "--uninstall damaged the checkout"; fi

# 7. --uninstall never removes a link it did not make.
ln -sfn "$other" "$bin/avo"
out6="$(./install.sh --bin-dir "$bin" --uninstall 2>&1)"
say "\$ ./install.sh --uninstall with a foreign link -> skipped?"
if [[ "$(readlink -- "$bin/avo")" == "$other" ]] && printf '%s' "$out6" | grep -q "skipped"; then
  ok "--uninstall leaves a foreign avo alone"
else bad "--uninstall removed a link into another checkout"; fi
rm -f "$bin/avo"

# 8. An unknown option is a usage error, not a partial install.
./install.sh --frobnicate >/dev/null 2>&1
code7=$?
say "\$ ./install.sh --frobnicate -> exit $code7"
if [[ $code7 -eq 2 ]]; then ok "unknown option exits 2"
else bad "unknown option: want exit 2, got $code7"; fi

say ""
if [[ $fails -eq 0 ]]; then
  say "install.sh e2e: all checks passed"
else
  say "install.sh e2e: $fails check(s) failed"
fi
exit $((fails > 0))
