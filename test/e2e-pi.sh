#!/usr/bin/env bash
# End-to-end checks for the native Pi extensions — the six tools (S8a) and the supervisor (S8b) —
# against a repo wired by the real `bin/avo install` and loaded by the real Pi resource loader, the
# same class `pi` itself uses. The unit tests prove the tools behave and the supervisor decides
# correctly; this proves Pi FINDS them and ROUTES to them, which is the half that breaks silently.
# Writes evidence/s8-e2e.txt.
set -uo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 1

evidence="$root/evidence/s8-e2e.txt"
mkdir -p "$root/evidence"
: > "$evidence"

fails=0
say() { printf '%s\n' "$*" | tee -a "$evidence"; }
ok()   { say "PASS  $*"; }
bad()  { say "FAIL  $*"; fails=$((fails + 1)); }
yes_no() { if [[ $1 == 0 ]]; then ok "$2"; else bad "$3"; fi; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

avo() { "$root/bin/avo" "$@"; }
repo="$work/repo"
tsx="$root/node_modules/.bin/tsx"

# Pi is a devDependency; a checkout that never installed it cannot run this suite, and saying so is
# better than failing every check with a module-not-found.
if [[ ! -d "$root/node_modules/@earendil-works/pi-coding-agent" ]]; then
  say "SKIP  pi is not installed (npm ci); the native-extension checks need it"
  exit 0
fi

say "# avo S8 e2e — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "# node $(node --version), pi $(node -p "require('$root/node_modules/@earendil-works/pi-coding-agent/package.json').version")"
say ""

# ------------------------------------------------------- 0. a fixture repo, wired by avo install
git init -q -b main "$repo"
git -C "$repo" config user.email avo@example.com
git -C "$repo" config user.name avo
mkdir -p "$repo/.avo"
printf 'echo 42\n' > "$repo/impl.sh"
cat > "$repo/.avo/score" <<'SCORE'
#!/usr/bin/env bash
out=$(bash impl.sh 2>&1)
size=$(wc -c < impl.sh | tr -d ' ')
if [[ "$out" == "42" ]]; then
  printf '{"ok":true,"correct":true,"primary":%s,"unit":"bytes","higher_is_better":false}\n' "$size"
else
  printf '{"ok":true,"correct":false,"primary":null,"unit":"bytes","higher_is_better":false}\n'
fi
SCORE
chmod +x "$repo/.avo/score"
git -C "$repo" add -A
git -C "$repo" commit -qm baseline

say "## 1. avo install --agent pi wires the extension where pi looks for it"
avo install --agent pi --cwd "$repo" > "$work/install.txt" 2>&1
yes_no $? "avo install --agent pi exits 0" "avo install failed: $(head -3 "$work/install.txt")"

# Two extensions, not one: the tools and the supervisor load separately, so an operator already
# running `avo run` can take the first without the second.
for ext in avo avo-supervisor; do
  [[ -L "$repo/.pi/extensions/$ext" ]]
  yes_no $? ".pi/extensions/$ext is a symlink, not a copy" ".pi/extensions/$ext is missing or is a copy"
  [[ -f "$repo/.pi/extensions/$ext/index.ts" ]]
  yes_no $? "$ext resolves to a real index.ts — pi loads <dir>/index.ts" "the $ext link is dangling"
done

# Idempotency (invariant 5): the second install must report unchanged and rewrite nothing.
before="$(readlink "$repo/.pi/extensions/avo")"
avo install --agent pi --cwd "$repo" --json > "$work/install2.json" 2>&1
jq -e '[.steps[] | select(.name == ".pi/extensions/avo")][0].action == "unchanged"' "$work/install2.json" >/dev/null
yes_no $? "a second install reports the extension unchanged" "the second install did not report unchanged"
[[ "$(readlink "$repo/.pi/extensions/avo")" == "$before" ]]
yes_no $? "the link is byte-identical after a re-run" "the link changed on a re-run"
say ""

say "## 2. pi's own resource loader discovers it in a trusted project"
agentdir="$work/pi-agent"
mkdir -p "$agentdir"
loaded="$("$tsx" "$root/test/pi-load.ts" --cwd "$repo" --agent-dir "$agentdir" --trust yes 2>"$work/load.err")"
if [[ -z "$loaded" ]]; then
  bad "the loader produced no output: $(head -5 "$work/load.err")"
  loaded='{"errors":["no output"],"extensions":[]}'
fi

printf '%s' "$loaded" | jq -e '.errors | length == 0' >/dev/null
yes_no $? "the extension loads with zero errors" "pi reported load errors: $(printf '%s' "$loaded" | jq -c '.errors')"

printf '%s' "$loaded" | jq -e '[.extensions[] | select(.path | test("\\.pi/extensions/avo/index\\.ts$"))] | length == 1' >/dev/null
yes_no $? "it was found by DISCOVERY, at .pi/extensions/avo/index.ts" "the extension was not discovered at the wired path"

printf '%s' "$loaded" | jq -e '[.extensions[] | select(.path | test("\\.pi/extensions/avo-supervisor/index\\.ts$"))] | length == 1' >/dev/null
yes_no $? "the supervisor is discovered too, and registers no tools of its own" "the supervisor extension was not discovered"

# The six tools, by name — a rename that the unit tests' constant follows would still be a break
# for every prompt and session that names the old one.
printf '%s' "$loaded" | jq -e '
  [.extensions[].tools[]] | sort ==
  ["avo_commit","avo_fan","avo_know_add","avo_know_query","avo_lineage","avo_score"]
' >/dev/null
yes_no $? "all six tools register: score, commit, lineage, know_query, know_add, fan" "the registered tools are $(printf '%s' "$loaded" | jq -c '[.extensions[].tools[]]')"
say ""

say "## 3. an untrusted project gets nothing — the warning avo prints is real"
# Trust is resolved by the CALLER (reload's resolveProjectTrust), which is what pi decides from
# defaultProjectTrust / trust.json / --approve. `--trust no` is the headless-unapproved case.
never="$("$tsx" "$root/test/pi-load.ts" --cwd "$repo" --agent-dir "$agentdir" --trust no 2>/dev/null)"
printf '%s' "$never" | jq -e '[.extensions[] | select(.path | test("\\.pi/extensions/avo"))] | length == 0' >/dev/null
yes_no $? "an untrusted project loads no project-local extension, exactly as avo install warns" "an untrusted project loaded the extension anyway"

grep -q "trust" "$work/install.txt"
yes_no $? "avo install says so out loud rather than leaving it to be discovered" "avo install never mentions project trust"
say ""

say "## 4. the tools are the CLI: a version committed through the extension is a version"
# Drives avoTools() the way pi drives it — execute(id, params, signal, onUpdate, ctx) — in the repo
# the loader just accepted, and then reads the result back with the CLI. Two implementations of the
# commit rule is the failure this is here to catch (invariant 1).
driven="$("$tsx" "$root/test/pi-drive.ts" "$repo" 2>"$work/drive.err")"
if [[ -z "$driven" ]]; then
  bad "driving the tools produced no output: $(head -5 "$work/drive.err")"
  driven='{"commit":{},"lineage":{}}'
fi

printf '%s' "$driven" | jq -e '.commit.action == "committed" and .commit.version == 1' >/dev/null
yes_no $? "avo_commit persisted v1" "avo_commit did not commit: $(printf '%s' "$driven" | jq -c '.commit.action, .commit.reason')"

git -C "$repo" log -1 --format=%B | grep -q '^Avo-Version: 1$'
yes_no $? "the commit carries the Avo-Version trailer the CLI writes" "the trailer is missing — the extension is not using the commit rule"

avo lineage --cwd "$repo" --json | jq -e 'length == 1 and .[0].version == 1 and .[0].why == "e2e: the baseline scorer"' >/dev/null
yes_no $? "the CLI reads back the version the extension wrote" "avo lineage does not see the extension's version"

# And the rationale the tool required survives into the rendered lineage, which is what S7's
# supervisor cites back at a stalling agent.
grep -q "e2e: the baseline scorer" "$repo/lineage/v001.md"
yes_no $? "the rationale reaches lineage/v001.md" "the --why did not reach the lineage file"
say ""

say "## 5. the supervisor steers a stalling session exactly once, through pi's own dispatch"
# A separate repo: section 4 already put a version in $repo, and a stall wants a clean start.
# The scripted sequence is a run of tool calls whose candidate only gets worse, executed through
# the tool definitions pi registered and fed back through runner.emitToolResult — so what is under
# test is pi routing a custom tool's result to a handler in a DIFFERENT extension, and
# pi.sendMessage from inside that handler reaching the session. The unit suite covers the decision.
repo2="$work/stall"
git init -q -b main "$repo2"
git -C "$repo2" config user.email avo@example.com
git -C "$repo2" config user.name avo
mkdir -p "$repo2/.avo"
printf '# scaffold\necho 42\n' > "$repo2/impl.sh"
cp "$repo/.avo/score" "$repo2/.avo/score"
# Thresholds low enough to stall in a handful of scores, set the way an operator would.
printf '{"supervise":{"stall":3,"thrash":2}}\n' > "$repo2/.avo/config.json"
git -C "$repo2" add -A
git -C "$repo2" commit -qm baseline
avo install --agent pi --cwd "$repo2" > "$work/install3.txt" 2>&1
# The lean candidate: smaller than the scaffold, so it lands as v1 and there is a best to stall on.
printf 'echo 42\n' > "$repo2/impl.sh"

steer="$("$tsx" "$root/test/pi-supervise-drive.ts" --cwd "$repo2" --agent-dir "$agentdir" --scores 6 2>"$work/steer.err" | tail -1)"
if [[ -z "$steer" ]]; then
  bad "driving the supervisor produced no output: $(head -5 "$work/steer.err")"
  steer='{"loadErrors":["no output"],"steersDuringStall":0,"steersAfterBranch":0}'
fi

printf '%s' "$steer" | jq -e '(.loadErrors | length) == 0 and .handlesToolResult == true' >/dev/null
yes_no $? "pi loads both extensions and has a tool_result handler" "no tool_result handler: $(printf '%s' "$steer" | jq -c '[.loadErrors, .handlesToolResult]')"

printf '%s' "$steer" | jq -e '.commit.action == "committed" and .commit.version == 1' >/dev/null
yes_no $? "v1 lands first, so the stall has a best to be measured against" "the baseline did not commit: $(printf '%s' "$steer" | jq -c '.commit.action')"

printf '%s' "$steer" | jq -e '.steersDuringStall == 1' >/dev/null
yes_no $? "six worsening scores produce ONE directive, not six" "steered $(printf '%s' "$steer" | jq -c '.steersDuringStall') times for one stall"

printf '%s' "$steer" | jq -e '.customTypes == ["avo-supervisor"] and (.kinds[0] == ["stall"])' >/dev/null
yes_no $? "the injected message is the supervisor's, and it names the stall" "unexpected injection: $(printf '%s' "$steer" | jq -c '.customTypes, .kinds')"

# The count is the attempt log's: the directive fires at the threshold, not at the sixth score.
printf '%s' "$steer" | jq -e '.sinceBest[0] == 3' >/dev/null
yes_no $? "it fires at the configured threshold (3 since best), read from .avo/config.json" "fired at $(printf '%s' "$steer" | jq -c '.sinceBest[0]') since best, not 3"

# A branch back past the directive is a model that never read it. Session state is reconstructed
# from the branch, so it must be steered again — the one case where re-steering is correct.
printf '%s' "$steer" | jq -e '.steersAfterBranch == 1' >/dev/null
yes_no $? "a branch that never saw the directive is steered again" "a branched session was left unsteered"

printf '%s' "$steer" | jq -e '[.notices[] | select(.type == "info" and (.message | test("new best")))] | length == 1' >/dev/null
yes_no $? "a landed version is announced once to the operator" "the new-best notice is missing or duplicated"

# And the intervention is a real record in this repo, not just a message in a session file.
avo mem list --cwd "$repo2" --json 2>/dev/null | jq -e '[.memories[] | select(.kind == "intervention")] | length >= 1' >/dev/null
yes_no $? "the steer is written down as an intervention memory, as avo run writes it" "no intervention memory was recorded"
say ""

say "## summary"
if [[ $fails == 0 ]]; then
  say "all checks passed ($(grep -c '^PASS' "$evidence") of them)"
else
  say "$fails check(s) FAILED"
fi
exit "$((fails > 0))"
