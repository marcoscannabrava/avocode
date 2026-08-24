#!/usr/bin/env bash
# End-to-end checks for `avo init` / `avo mem` (S3) against real fixture repos.
# The fallback store is the path most environments take, so it is checked unconditionally; the
# beads path runs only when `bd` is on PATH (reported as SKIP otherwise, never as a pass).
# Writes evidence/s3-e2e.txt.
set -uo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 1

evidence="$root/evidence/s3-e2e.txt"
mkdir -p "$root/evidence"
: > "$evidence"

fails=0
say() { printf '%s\n' "$*" | tee -a "$evidence"; }
ok()   { say "PASS  $*"; }
bad()  { say "FAIL  $*"; fails=$((fails + 1)); }
skip() { say "SKIP  $*"; }

fixture="$(mktemp -d)"
# Scratch space for command output. It must live *outside* the fixture repo: a stray file in the
# working tree is a change, and `avo commit` would rightly score it.
work="$(mktemp -d)"
trap 'rm -rf "$fixture" "$work"' EXIT

avo() { "$root/bin/avo" "$@"; }
ingit() { git -C "$fixture" "$@"; }

have_bd=no
if command -v bd >/dev/null 2>&1; then have_bd=yes; fi

say "# avo S3 e2e — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "# node $(node --version), $(git --version), jq $(jq --version)"
say "# bd on PATH: $have_bd$([[ $have_bd == yes ]] && printf ' (%s)' "$(bd --version 2>&1 | head -1)")"
say ""

ingit init -q
ingit config user.email avo@example.com
ingit config user.name avo
ingit config commit.gpgsign false
printf 'echo 42\n# padding padding\n' > "$fixture/impl.sh"
ingit add -A
ingit commit -qm "fixture baseline"

# ---------------------------------------------------------------- 1. avo init
out="$(avo init --cwd "$fixture" --json)"
say "\$ avo init --json -> $out"
if printf '%s' "$out" | jq -e '.ok == true' >/dev/null; then
  ok "avo init succeeds in a git repo"
else
  bad "avo init did not report ok"
fi
for f in .avo/.gitignore .avo/config.json; do
  if [[ -f "$fixture/$f" ]]; then ok "avo init created $f"; else bad "avo init did not create $f"; fi
done
if [[ -d "$fixture/lineage" ]]; then ok "avo init created lineage/"; else bad "avo init did not create lineage/"; fi
if printf '%s' "$out" | jq -e '.steps[] | select(.name == ".avo/score") | .action == "skipped"' >/dev/null; then
  ok "avo init reports the missing scorer instead of guessing one"
else
  bad "avo init did not report the missing scorer"
fi

# ---------------------------------------------------------------- 2. idempotency (invariant 5)
printf '{"reduce":"mean","floor":0.02}\n' > "$fixture/.avo/config.json"
sum_before="$(cksum < "$fixture/.avo/config.json")"
again="$(avo init --cwd "$fixture" --json)"
if printf '%s' "$again" | jq -e '[.steps[] | select(.action == "created")] | length == 0' >/dev/null; then
  ok "a second avo init creates nothing"
else
  say "$again"
  bad "a second avo init reported a created step"
fi
if [[ "$(cksum < "$fixture/.avo/config.json")" == "$sum_before" ]]; then
  ok "avo init leaves an edited .avo/config.json alone"
else
  bad "avo init overwrote an edited config"
fi
# Back to the defaults, so the checks below exercise the default dominate-or-tie comparator.
printf '{"reduce":"dominate","floor":0}\n' > "$fixture/.avo/config.json"

# ---------------------------------------------------------------- 3. init outside a repo
plain="$(mktemp -d)"
avo init --cwd "$plain" >/dev/null 2>&1 && rc=0 || rc=$?
if [[ $rc -eq 2 ]] && [[ ! -e "$plain/.avo" ]]; then
  ok "avo init in a non-repo exits 2 and writes nothing"
else
  bad "avo init in a non-repo exited $rc (and left $(find "$plain" -mindepth 1 | tr '\n' ' '))"
fi
rm -rf "$plain"

# ---------------------------------------------------------------- 4. avo mem add / avo mem
avo mem add "shared memory beats registers on b8" --cwd "$fixture" > "$work/add.txt" 2> "$work/add.err"
say "\$ avo mem add -> $(cat "$work/add.txt")"
if grep -q 'remembered \[shared-memory-beats-registers-on-b8\]' "$work/add.txt"; then
  ok "avo mem add reports the key it wrote"
else
  bad "avo mem add did not report a key"
fi
if avo mem --cwd "$fixture" | grep -q "shared memory beats registers on b8"; then
  ok "avo mem shows the insight back (the slice's acceptance case)"
else
  bad "avo mem did not show the insight"
fi
memjson="$(avo mem --cwd "$fixture" --json)"
if printf '%s' "$memjson" | jq -e '.memories | length == 1' >/dev/null; then
  ok "avo mem --json holds exactly the one memory"
else
  say "$memjson"
  bad "avo mem --json did not hold one memory"
fi
if printf '%s' "$memjson" | jq -e '.warnings | length <= 1' >/dev/null; then
  ok "the backend is warned about at most once per command (invariant 4)"
else
  bad "more than one warning per command"
fi
if avo mem prime --cwd "$fixture" | grep -q "shared memory beats registers"; then
  ok "avo mem prime carries the insight into a session"
else
  bad "avo mem prime lost the insight"
fi
avo mem add --cwd "$fixture" >/dev/null 2>&1 && rc=0 || rc=$?
if [[ $rc -eq 2 ]]; then ok "avo mem add with no insight exits 2"; else bad "avo mem add with no text exited $rc"; fi

# ---------------------------------------------------------------- 5. what backend was used
backend="$(printf '%s' "$memjson" | jq -r '.backend')"
say "backend in use: $backend"
if [[ $have_bd == yes ]]; then
  if [[ "$backend" == "beads" ]]; then
    ok "with bd installed and initialized, memory goes to beads"
    bd -C "$fixture" memories > "$work/memories.txt" 2>&1
    if grep -q "shared memory beats registers" "$work/memories.txt"; then
      ok "the insight is readable straight from bd memories"
    else
      say "$(cat "$work/memories.txt")"
      bad "bd memories does not hold the insight avo wrote"
    fi
  else
    bad "bd is installed but avo used the $backend backend"
  fi
else
  skip "the beads-backed checks — bd is not on PATH, so the fallback path is what runs here"
  if [[ "$backend" == "file" ]] && [[ -f "$fixture/lineage/memory.jsonl" ]]; then
    ok "without bd, memory falls back to lineage/memory.jsonl (invariant 4)"
  else
    bad "no bd, but the fallback store was not used"
  fi
  if grep -q "bd is not installed" "$work/add.err"; then
    ok "the degradation is warned about, not hidden"
  else
    bad "no warning about the missing bd"
  fi
fi

# ---------------------------------------------------------------- 6. commit -> version memory
cat > "$fixture/.avo/score" <<'SCORER'
#!/usr/bin/env bash
out=$(bash impl.sh 2>&1)
size=$(wc -c < impl.sh | tr -d ' ')
if [[ "$out" == "42" ]]; then
  printf '{"ok":true,"correct":true,"primary":%s,"unit":"bytes","higher_is_better":false}\n' "$size"
else
  printf '{"ok":true,"correct":false,"primary":null,"unit":"bytes","higher_is_better":false,"log":"printed %s"}\n' "$out"
fi
SCORER
chmod +x "$fixture/.avo/score"

printf 'echo 42\n# pad\n' > "$fixture/impl.sh"
avo commit --cwd "$fixture" --why "dropped the padding" --json > "$work/c1.json"
if jq -e '.action == "committed" and .version == 1' < "$work/c1.json" >/dev/null; then
  ok "v1 committed"
else
  say "$(cat "$work/c1.json")"
  bad "v1 was not committed"
fi

printf 'echo 42\n' > "$fixture/impl.sh"
avo commit --cwd "$fixture" --json > "$work/c2.json"
if jq -e '.action == "committed" and .version == 2' < "$work/c2.json" >/dev/null; then
  ok "v2 committed"
else
  say "$(cat "$work/c2.json")"
  bad "v2 was not committed"
fi

versions="$(avo mem --cwd "$fixture" --json | jq '[.memories[] | select(.kind == "version")] | length')"
say "version memories: $versions"
if [[ "$have_bd" == yes ]]; then
  # bd holds versions as beads, not memories; check the graph instead.
  prefix="$(bd -C "$fixture" context --json | jq -r '.database')"
  chain="$(bd -C "$fixture" --json show "$prefix-v2" | jq -r '.[0].dependencies[0].id')"
  say "bd show $prefix-v2 -> parent $chain"
  if [[ "$chain" == "$prefix-v1" ]]; then
    ok "the version beads carry the parent chain (bd show $prefix-v2 -> $prefix-v1)"
  else
    bad "v2's bead is not linked to v1 (got '$chain')"
  fi
else
  if [[ "$versions" == "2" ]]; then
    ok "both committed versions are remembered"
  else
    bad "expected 2 version memories, got $versions"
  fi
  parent="$(jq -r 'select(.key == "avo-v2") | .parent' "$fixture/lineage/memory.jsonl" | tail -1)"
  if [[ "$parent" == "v1" ]]; then
    ok "the v2 record names v1 as its parent"
  else
    bad "v2's parent is '$parent', not v1"
  fi
fi

# ---------------------------------------------------------------- 7. refusal -> dead end
printf 'echo 42\n# padding padding padding padding\n' > "$fixture/impl.sh"
avo commit --cwd "$fixture" --json > "$work/c3.json" && rc=0 || rc=$?
if [[ $rc -eq 1 ]] && jq -e '.action == "refused"' < "$work/c3.json" >/dev/null; then
  ok "a regression is refused (exit 1)"
else
  bad "the regression was not refused (exit $rc)"
fi
if [[ "$have_bd" == yes ]]; then
  if bd -C "$fixture" list -l avo-insight 2>/dev/null | grep -qi "dead end"; then
    ok "the dead end is recorded as an insight bead"
  else
    bad "no insight bead for the refused candidate"
  fi
else
  dead="$(avo mem --cwd "$fixture" --json | jq '[.memories[] | select(.kind == "failure")] | length')"
  if [[ "$dead" == "1" ]]; then
    ok "the refused candidate is remembered as a dead end"
  else
    bad "expected 1 dead-end memory, got $dead"
  fi
  if avo mem prime --cwd "$fixture" | grep -q "do not re-try these"; then
    ok "avo mem prime tells the agent which directions are dead"
  else
    bad "avo mem prime does not surface dead ends"
  fi
fi

# re-attempting the same dead end must update one record, not pile up
avo commit --cwd "$fixture" --json > /dev/null 2>&1
if [[ "$have_bd" == yes ]]; then
  n="$(bd -C "$fixture" --json list -l avo-insight 2>/dev/null | jq 'length')"
else
  n="$(avo mem --cwd "$fixture" --json | jq '[.memories[] | select(.kind == "failure")] | length')"
fi
if [[ "$n" == "1" ]]; then
  ok "re-trying the same dead end updates one record instead of piling up"
else
  bad "the same dead end produced $n records"
fi

# ---------------------------------------------------------------- 8. no self-perturbation
git -C "$fixture" checkout -q -- impl.sh
avo commit --cwd "$fixture" --json > "$work/c4.json"
say "\$ avo commit (nothing changed) -> $(jq -c '{action, reason}' < "$work/c4.json")"
if jq -e '.action == "noop"' < "$work/c4.json" >/dev/null; then
  ok "avo's own memory writes do not make the next run look like a candidate"
else
  bad "a run with no agent change was not a no-op"
fi

# ---------------------------------------------------------------- 9. the lineage is untouched
if [[ "$(avo lineage --cwd "$fixture" --json | jq 'length')" == "2" ]]; then
  ok "invariant 1 holds: memory added no versions to the lineage"
else
  bad "the lineage changed length"
fi

say ""
if [[ $fails -eq 0 ]]; then
  say "all checks passed"
else
  say "$fails check(s) failed"
fi
exit $((fails > 0 ? 1 : 0))
