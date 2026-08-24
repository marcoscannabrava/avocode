#!/usr/bin/env bash
# End-to-end checks for `avo know` (S4) against a real fixture repo and the real bin/avo.
# qmd is an optional dependency, so the local-scan fallback is the path most environments take and
# is checked unconditionally; the qmd path runs only when `qmd` is on PATH (reported as SKIP
# otherwise, never as a pass). No network: the web-search backends are checked through their
# selection and error paths only.
# Writes evidence/s4-e2e.txt.
set -uo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 1

evidence="$root/evidence/s4-e2e.txt"
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

have_qmd=no
if command -v qmd >/dev/null 2>&1; then have_qmd=yes; fi

say "# avo S4 e2e — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "# node $(node --version), $(git --version), jq $(jq --version)"
say "# qmd on PATH: $have_qmd$([[ $have_qmd == yes ]] && printf ' (%s)' "$(qmd --version 2>&1 | head -1)")"
say ""

ingit init -q
ingit config user.email avo@example.com
ingit config user.name avo
ingit config commit.gpgsign false
printf 'echo 42\n' > "$fixture/impl.sh"
ingit add -A
ingit commit -qm "fixture baseline"

# ------------------------------------------------------------- 1. avo know init
out="$(avo know init --cwd "$fixture" --json 2>"$work/init.err")"
say "\$ avo know init --json -> $(printf '%s' "$out" | head -c 400)"
if printf '%s' "$out" | jq -e '.ok == true' >/dev/null; then
  ok "avo know init succeeds"
else
  bad "avo know init did not report ok"
fi
for d in knowledge lineage; do
  if [[ -d "$fixture/$d" ]]; then ok "avo know init created $d/"; else bad "avo know init did not create $d/"; fi
done
if printf '%s' "$out" | jq -e '[.steps[].name] | index("knowledge/") != null and index("lineage/") != null' >/dev/null; then
  ok "both collections are reported as steps"
else
  bad "the steps do not name both collections"
fi

# Idempotency (invariant 5): a second run creates nothing.
second="$(avo know init --cwd "$fixture" --json)"
if printf '%s' "$second" | jq -e '[.steps[] | select(.action == "created")] | length == 0' >/dev/null; then
  ok "a second avo know init creates nothing"
else
  say "    $(printf '%s' "$second" | jq -c '[.steps[] | select(.action == "created")]')"
  bad "a second avo know init created something"
fi

# ------------------------------------------------- 2. avo know add: a local doc
cat > "$work/regs.md" <<'DOC'
# Register pressure on Blackwell

Spilling registers to local memory destroys occupancy. Cap per-thread register
usage with __launch_bounds__ before reaching for shared memory.
DOC
out="$(avo know add "$work/regs.md" --cwd "$fixture" --name register-pressure --json 2>"$work/add.err")"
say "\$ avo know add regs.md --json -> $(printf '%s' "$out" | jq -c '{ok, action, path, bytes, embedded}')"
if printf '%s' "$out" | jq -e '.ok == true and .action == "created" and .path == "knowledge/register-pressure.md"' >/dev/null; then
  ok "avo know add wrote knowledge/register-pressure.md"
else
  bad "avo know add did not create the expected doc"
fi
doc="$fixture/knowledge/register-pressure.md"
if grep -q '^source: ' "$doc" && grep -q '^fetched-at: ' "$doc" && grep -q '^via: ' "$doc"; then
  ok "the doc carries provenance frontmatter (source, fetched-at, via)"
else
  bad "the doc has no provenance frontmatter"
fi

# Re-adding the same content must be a no-op, and differing content must be refused (invariant 5).
if avo know add "$work/regs.md" --cwd "$fixture" --name register-pressure --json | jq -e '.action == "unchanged"' >/dev/null; then
  ok "re-adding identical content is 'unchanged', not a duplicate"
else
  bad "re-adding identical content was not a no-op"
fi
printf '# Register pressure\n\ndifferent body\n' > "$work/regs.md"
avo know add "$work/regs.md" --cwd "$fixture" --name register-pressure --json > "$work/conflict.json" 2>&1
rc=$?
if [[ $rc -eq 1 ]] && jq -e '.action == "refused"' < "$work/conflict.json" >/dev/null; then
  ok "differing content is refused with exit 1 until --force"
else
  bad "differing content was not refused (rc=$rc)"
fi
if grep -q 'launch_bounds' "$doc"; then
  ok "a refused add leaves the existing doc untouched"
else
  bad "a refused add modified the doc"
fi
if avo know add "$work/regs.md" --cwd "$fixture" --name register-pressure --force --json | jq -e '.action == "updated"' >/dev/null; then
  ok "--force replaces it"
else
  bad "--force did not replace the doc"
fi

# ------------------------------------------------------------ 3. avo know query
# Restore the richer doc, and add a second one so ranking has something to rank.
cat > "$work/regs.md" <<'DOC'
# Register pressure on Blackwell

Spilling registers to local memory destroys occupancy. Cap per-thread register
usage with __launch_bounds__ before reaching for shared memory.
DOC
avo know add "$work/regs.md" --cwd "$fixture" --name register-pressure --force >/dev/null 2>&1
printf '# Async copy\n\nTMA bulk copies overlap global to shared transfers with compute.\n' > "$work/tma.md"
avo know add "$work/tma.md" --cwd "$fixture" --name async-copy >/dev/null 2>&1

avo know query "register occupancy" --cwd "$fixture" --json > "$work/q.json" 2>"$work/q.err"
say "\$ avo know query 'register occupancy' --json -> $(jq -c '{backend, n: (.hits | length), top: .hits[0].file, score: .hits[0].score}' < "$work/q.json")"
if jq -e '[.backend, .query, .hits, .warnings, .errors] | length == 5' < "$work/q.json" >/dev/null; then
  ok "avo know query --json has the same keys whichever backend answered"
else
  bad "avo know query --json is missing keys"
fi
# The slice's acceptance case: a fixed doc, ingested, comes back above a score threshold.
if jq -e '.hits[0].file == "knowledge/register-pressure.md" and .hits[0].score >= 0.5' < "$work/q.json" >/dev/null; then
  ok "the ingested doc is the top hit, above the 0.5 score threshold"
else
  bad "the ingested doc did not rank first above the threshold"
fi
if jq -e '.hits[0].line > 0 and (.hits[0].snippet | length) > 0' < "$work/q.json" >/dev/null; then
  ok "a hit carries a line number and a snippet, so the agent can read on"
else
  bad "a hit is missing its line or snippet"
fi
if avo know query "register occupancy" --cwd "$fixture" --min-score 1.1 --json | jq -e '.hits | length == 0' >/dev/null; then
  ok "--min-score filters hits"
else
  bad "--min-score did not filter"
fi
if [[ $have_qmd == yes ]]; then
  # qmd search reports every BM25 hit with score 0, so a threshold there would silently drop them
  # all. It must say so rather than return a confusing empty list.
  avo know query "register" --cwd "$fixture" --lexical --min-score 0.5 --json > "$work/lex.json" 2>&1
  if jq -e '(.hits | length) > 0 and ([.warnings[] | select(test("does not report a relevance score"))] | length == 1)' < "$work/lex.json" >/dev/null; then
    ok "--lexical with --min-score keeps the hits and explains that BM25 has no score"
  else
    bad "--lexical --min-score neither filtered honestly nor explained itself"
  fi
fi
if avo know query "nothing whatsoever matches this" --cwd "$fixture" >/dev/null 2>&1; then
  ok "an empty result is exit 0, not an error"
else
  bad "an empty result exited non-zero"
fi

# The lineage is a searchable collection too — the synergy PLAN §3 calls out. `avo commit` writes
# straight into lineage/, so qmd needs a re-scan before it can see the new version; the local
# fallback reads the files live and needs none. Both must end up answering the same question.
printf '# v001\n\nraised occupancy by capping registers per thread\n' > "$fixture/lineage/v001.md"
avo know reindex --cwd "$fixture" --json > "$work/reindex.json" 2>"$work/reindex.err"
if avo know query "capping registers" --cwd "$fixture" --json > "$work/lin.json" 2>&1 &&
   jq -e '[.hits[].collection] | index("lineage") != null' < "$work/lin.json" >/dev/null; then
  ok "lineage/ is searched alongside knowledge/"
else
  say "    $(jq -c '{backend, hits: [.hits[].file]}' < "$work/lin.json" 2>&1)"
  bad "the lineage is not searchable"
fi
if jq -e 'has("ok") and has("backend") and has("reindexed")' < "$work/reindex.json" >/dev/null; then
  ok "avo know reindex reports itself the same way with or without qmd"
else
  bad "avo know reindex --json is missing keys"
fi
rm -f "$fixture/lineage/v001.md"

# ------------------------------------------------------------ 4. the qmd path
if [[ $have_qmd == yes ]]; then
  if [[ -f "$fixture/.qmd/index.yml" ]]; then
    ok "avo know init created a project-local qmd index (not the global ~/.cache one)"
  else
    bad "no .qmd/index.yml — qmd would have used the global index"
  fi
  if grep -qx '\*' "$fixture/.qmd/.gitignore" 2>/dev/null; then
    ok ".qmd/ is gitignored (index.yml records absolute paths)"
  else
    bad ".qmd/ is not gitignored"
  fi
  if [[ -z "$(ingit status --porcelain -- .qmd)" ]]; then
    ok "git sees nothing under .qmd/, so the index cannot dirty a candidate"
  else
    bad "git sees changes under .qmd/"
  fi
  avo know query "register" --cwd "$fixture" --lexical --json > "$work/qmdq.json" 2>&1
  if jq -e '.backend == "qmd"' < "$work/qmdq.json" >/dev/null; then
    ok "avo know query --lexical goes through qmd search"
  else
    bad "avo know query did not use qmd"
  fi
  # The regression that motivated `qmd update`: `qmd embed` alone leaves a doc added after
  # `collection add` invisible, so every search returns nothing at all.
  if jq -e '[.hits[].file] | index("knowledge/register-pressure.md") != null' < "$work/qmdq.json" >/dev/null; then
    ok "a doc added after the collection existed is in the qmd index (avo know add runs qmd update)"
  else
    say "    $(jq -c '{backend, hits: [.hits[].file], warnings}' < "$work/qmdq.json")"
    bad "the ingested doc is missing from the qmd index"
  fi
else
  skip "qmd is not installed — the qmd index, its gitignore and the qmd query path"
  if jq -e '.backend == "files"' < "$work/q.json" >/dev/null; then
    ok "without qmd the query is answered by the local scan, with the same JSON shape"
  else
    bad "the fallback did not report the files backend"
  fi
  if [[ "$(jq -r '[.warnings[] | select(test("qmd is not installed"))] | length' < "$work/q.json")" == "1" ]]; then
    ok "--json carries the degradation warning in the payload, exactly once"
  else
    bad "the degradation warning is missing from or duplicated in the --json payload"
  fi
  avo know query "register" --cwd "$fixture" > "$work/q.pretty" 2>"$work/qp.err"
  if grep -q 'qmd is not installed' "$work/qp.err"; then
    ok "the pretty form warns about the degradation on stderr, keeping stdout parseable"
  else
    bad "no degradation warning on stderr"
  fi
fi

# --------------------------------------------- 5. avo know search: no network
# Backend selection and its failure messages, exercised without making a request.
avo know search "avo paper" --backend firecrawl --cwd "$fixture" > "$work/s1.out" 2>"$work/s1.err"
rc=$?
if [[ $rc -eq 2 ]] && grep -q 'FIRECRAWL_API_KEY' "$work/s1.err" && grep -q 'searxng' "$work/s1.err" && grep -q 'ddgs' "$work/s1.err"; then
  ok "no key configured names all three alternatives instead of throwing"
else
  say "    rc=$rc stderr=$(head -c 200 "$work/s1.err")"
  bad "the missing-key message did not name the alternatives"
fi
avo know search "q" --backend bing --cwd "$fixture" > "$work/bing.err" 2>&1
if grep -q "unknown --backend 'bing'" "$work/bing.err"; then
  ok "an unknown --backend is a usage error naming the valid ones"
else
  bad "an unknown --backend was not rejected"
fi
avo know search "q" --backend searxng --cwd "$fixture" 2>"$work/s2.err" >/dev/null
if grep -q 'SEARXNG_URL' "$work/s2.err"; then
  ok "--backend searxng with no SEARXNG_URL names the variable"
else
  bad "the searxng message did not name SEARXNG_URL"
fi
# ddgs writes its json into CWD; whichever way it goes, it must not litter the repo.
avo know search "q" --backend ddgs --cwd "$fixture" >/dev/null 2>&1
if [[ -z "$(ingit status --porcelain -- ':!knowledge')" ]] && ! ls "$fixture"/text_*.json >/dev/null 2>&1; then
  ok "avo know search leaves no stray files in the repo"
else
  say "    $(ingit status --porcelain)"
  bad "avo know search littered the working tree"
fi

# --------------------------------------------------- 6. usage and exit codes
avo know --cwd "$fixture" > "$work/nosub.err" 2>&1
if grep -q 'needs a subcommand' "$work/nosub.err"; then
  ok "avo know with no subcommand explains itself"
else
  bad "avo know with no subcommand did not explain itself"
fi
avo know query --cwd "$fixture" >/dev/null 2>&1
if [[ $? -eq 2 ]]; then ok "a usage error exits 2"; else bad "a usage error did not exit 2"; fi
if avo help | grep -q 'avo know:'; then
  ok "avo help documents the know subcommands"
else
  bad "avo help does not document avo know"
fi

# --------------------------------------- 7. avo init folds avo know init in
other="$(mktemp -d)"
git -C "$other" init -q
avo init --cwd "$other" --json > "$work/init2.json" 2>&1
if jq -e '[.steps[].name] | index("knowledge/") != null' < "$work/init2.json" >/dev/null; then
  ok "avo init scaffolds K too, so one command sets the whole loop up"
else
  bad "avo init did not fold in avo know init"
fi
if jq -e '.ok == true' < "$work/init2.json" >/dev/null; then
  ok "avo init still succeeds with qmd absent (degradation is not failure)"
else
  bad "avo init failed"
fi
rm -rf "$other"

# ------------------------------------------- 8. K does not disturb the lineage
avo init --cwd "$fixture" >/dev/null 2>&1
if [[ -n "$(ingit status --porcelain -- knowledge)" ]]; then
  ok "ingested docs are ordinary tracked files, visible to git"
else
  bad "the knowledge docs are invisible to git"
fi

say ""
if [[ $fails -eq 0 ]]; then
  say "all checks passed"
else
  say "$fails check(s) failed"
fi
exit $((fails > 0 ? 1 : 0))
