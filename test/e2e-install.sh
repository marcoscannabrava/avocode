#!/usr/bin/env bash
# End-to-end checks for the agent-agnostic skills layer and `avo install` (S5), against the real
# bin/avo and real fixture repos. Every agent's wiring is verified as an agent would find it — by
# reading through the links avo created, not by trusting avo's own report.
# Writes evidence/s5-e2e.txt.
set -uo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 1

evidence="$root/evidence/s5-e2e.txt"
mkdir -p "$root/evidence"
: > "$evidence"

fails=0
say() { printf '%s\n' "$*" | tee -a "$evidence"; }
ok()   { say "PASS  $*"; }
bad()  { say "FAIL  $*"; fails=$((fails + 1)); }
skip() { say "SKIP  $*"; }
# `yes_no <exit-status> <pass message> <fail message>` — keeps the one-line assertions readable
# without `A && B || C`, which shellcheck rightly flags as not being if-then-else.
yes_no() { if [[ $1 == 0 ]]; then ok "$2"; else bad "$3"; fi; }

fixture="$(mktemp -d)"
work="$(mktemp -d)"
trap 'rm -rf "$fixture" "$work"' EXIT

avo() { "$root/bin/avo" "$@"; }

say "# avo S5 e2e — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "# node $(node --version), $(git --version), jq $(jq --version)"
for a in pi claude codex; do
  if command -v "$a" >/dev/null 2>&1; then say "# $a on PATH: yes"; else say "# $a on PATH: no"; fi
done
say ""

git -C "$fixture" init -q
git -C "$fixture" config user.email avo@example.com
git -C "$fixture" config user.name avo

# ------------------------------------------------- 1. the bundled skills are spec-valid
say "## 1. the skills themselves"
skills=(); while IFS= read -r d; do skills+=("$d"); done < <(find "$root/.agents/skills" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)
if [[ ${#skills[@]} -ge 4 ]]; then ok "avo ships ${#skills[@]} skills: ${skills[*]}"; else bad "expected at least 4 bundled skills, found ${#skills[@]}"; fi
for s in "${skills[@]}"; do
  f="$root/.agents/skills/$s/SKILL.md"
  if [[ -f $f ]]; then ok "$s has a SKILL.md"; else bad "$s has no SKILL.md"; continue; fi
  # Frontmatter as an agent parses it: a '---' first line, a name matching the directory, a
  # description. Read with awk rather than avo's own parser, so this is an independent check.
  head -1 "$f" | grep -qx -- '---'
  yes_no $? "$s: SKILL.md opens with a frontmatter fence" "$s: SKILL.md does not open with '---'"
  name="$(awk 'NR>1 && /^---/{exit} /^name:/{sub(/^name:[[:space:]]*/,""); print; exit}' "$f")"
  desc="$(awk 'NR>1 && /^---/{exit} /^description:/{sub(/^description:[[:space:]]*/,""); print; exit}' "$f")"
  if [[ $name == "$s" ]]; then ok "$s: name matches its directory"; else bad "$s: name '$name' does not match directory '$s'"; fi
  if [[ -n $desc ]]; then ok "$s: has a non-empty description (${#desc} chars)"; else bad "$s: has no description"; fi
  if [[ ${#desc} -le 1024 ]]; then ok "$s: description is within the 1024-char cap"; else bad "$s: description is ${#desc} chars"; fi
done
say ""

# ------------------------------------------------- 2. install into a fresh repo
say "## 2. avo install into a fresh repo"
out="$(avo install --cwd "$fixture" --json 2>"$work/err")"
printf '%s\n' "$out" | jq . > "$work/install.json" 2>/dev/null || printf '%s' "$out" > "$work/install.json"
say "\$ avo install --json | jq -c '{ok, agents, skills: [.skills[].name]}' -> $(printf '%s' "$out" | jq -c '{ok, agents, skills: [.skills[].name]}' 2>&1)"
if printf '%s' "$out" | jq -e '.ok == true' >/dev/null; then ok "avo install reports ok"; else bad "avo install did not report ok"; fi
if printf '%s' "$out" | jq -e '.agents == ["pi","claude","codex"]' >/dev/null; then ok "no --agent means all three"; else bad "default agent set is wrong"; fi
if printf '%s' "$out" | jq -e '[.steps[] | select(.action == "failed")] | length == 0' >/dev/null; then ok "no step failed"; else bad "a step failed: $(printf '%s' "$out" | jq -c '[.steps[]|select(.action=="failed")]')"; fi

# ------------------------------------------------- 3. what each agent actually finds
say ""
say "## 3. what each agent finds"
# pi: project .agents/skills/, discovered natively.
for s in "${skills[@]}"; do
  link="$fixture/.agents/skills/$s"
  if [[ -L $link ]]; then ok "pi: .agents/skills/$s is a symlink, not a copy"; else bad "pi: .agents/skills/$s is not a symlink"; fi
  if head -1 "$link/SKILL.md" 2>/dev/null | grep -qx -- '---'; then ok "pi: $s/SKILL.md is readable through the link"; else bad "pi: cannot read $s/SKILL.md through the link"; fi
done
if [[ -f $fixture/.pi/settings.json ]] && jq -e '.defaultTools | index("bash")' "$fixture/.pi/settings.json" >/dev/null; then
  ok "pi: .pi/settings.json enables bash, which every avo command needs"
else
  bad "pi: .pi/settings.json does not enable bash"
fi
if jq -e 'has("skills") | not' "$fixture/.pi/settings.json" >/dev/null; then
  ok "pi: .agents/skills is not re-declared in settings (pi finds it natively; a duplicate warns)"
else
  bad "pi: settings re-declares a natively-discovered location"
fi
if printf '%s' "$out" | jq -e '[.warnings[] | select(test("--approve|defaultProjectTrust"))] | length == 1' >/dev/null; then
  ok "pi: the headless project-trust trap is named exactly once"
else
  bad "pi: the project-trust warning is missing or duplicated"
fi

# claude: one directory symlink, so a skill added later needs no re-install.
if [[ -L $fixture/.claude/skills ]]; then
  ok "claude: .claude/skills is a symlink -> $(readlink "$fixture/.claude/skills")"
else
  bad "claude: .claude/skills is not a symlink"
fi
for s in "${skills[@]}"; do
  if head -1 "$fixture/.claude/skills/$s/SKILL.md" 2>/dev/null | grep -qx -- '---'; then
    ok "claude: $s reads through .claude/skills -> .agents/skills -> avo"
  else
    bad "claude: cannot read $s through .claude/skills"
  fi
done

# codex: AGENTS.md is the whole mechanism.
if [[ -f $fixture/AGENTS.md ]]; then ok "codex: AGENTS.md exists"; else bad "codex: AGENTS.md missing"; fi
for s in "${skills[@]}"; do
  if grep -q -- "\`$s\`" "$fixture/AGENTS.md"; then ok "codex: AGENTS.md indexes $s"; else bad "codex: AGENTS.md does not index $s"; fi
done
if grep -q '\.agents/skills/<name>/SKILL\.md' "$fixture/AGENTS.md"; then ok "codex: AGENTS.md says where to read the full instructions"; else bad "codex: AGENTS.md does not give the skill path"; fi
for rule in 'avo commit' 'avo mem add' 'bd'; do
  if grep -q -- "$rule" "$fixture/AGENTS.md"; then ok "AGENTS.md carries the always-on rule about '$rule'"; else bad "AGENTS.md is missing the rule about '$rule'"; fi
done

# ------------------------------------------------- 4. idempotency (the slice's acceptance case)
say ""
say "## 4. avo install --agent all twice produces no diff"
find "$fixture" -path "$fixture/.git" -prune -o -printf '%y %p %l\n' -print0 2>/dev/null | sort > "$work/before.txt"
sha_before="$(find "$fixture" -path "$fixture/.git" -prune -o -type f -printf '%P\n' -print0 2>/dev/null | sort | while read -r f; do [[ -f "$fixture/$f" ]] && sha256sum "$fixture/$f"; done | sort)"
out2="$(avo install --cwd "$fixture" --agent all --json)"
find "$fixture" -path "$fixture/.git" -prune -o -printf '%y %p %l\n' -print0 2>/dev/null | sort > "$work/after.txt"
sha_after="$(find "$fixture" -path "$fixture/.git" -prune -o -type f -printf '%P\n' -print0 2>/dev/null | sort | while read -r f; do [[ -f "$fixture/$f" ]] && sha256sum "$fixture/$f"; done | sort)"
if diff -q "$work/before.txt" "$work/after.txt" >/dev/null; then ok "the second run adds, removes and relinks nothing"; else bad "the second run changed the tree: $(diff "$work/before.txt" "$work/after.txt" | head -5)"; fi
if [[ $sha_before == "$sha_after" ]]; then ok "every file is byte-identical after the second run"; else bad "a file changed on the second run"; fi
if printf '%s' "$out2" | jq -e '[.steps[] | select(.action != "unchanged")] | length == 0' >/dev/null; then
  ok "every step reports 'unchanged' on the second run"
else
  bad "a step was not 'unchanged': $(printf '%s' "$out2" | jq -c '[.steps[]|select(.action!="unchanged")]')"
fi

# ------------------------------------------------- 5. it protects what it did not write
say ""
say "## 5. avo install never clobbers"
guard="$(mktemp -d)"
git -C "$guard" init -q
mkdir -p "$guard/.claude/skills/their-skill"
printf -- '---\nname: their-skill\ndescription: theirs\n---\nbody\n' > "$guard/.claude/skills/their-skill/SKILL.md"
printf '# Our rules\n\nAlways rebase.\n' > "$guard/AGENTS.md"
avo install --cwd "$guard" >"$work/guard.txt" 2>&1
if [[ -f $guard/.claude/skills/their-skill/SKILL.md ]]; then ok "an existing .claude/skills directory and its skills survive"; else bad "avo install destroyed an existing .claude/skills"; fi
if [[ -L $guard/.claude/skills/avo-vary ]]; then ok "avo's skills are linked *inside* the existing directory instead"; else bad "avo's skills were not linked into the existing .claude/skills"; fi
if grep -q 'Always rebase' "$guard/AGENTS.md" && grep -q 'BEGIN avo' "$guard/AGENTS.md"; then
  ok "an existing AGENTS.md keeps its content and gains the managed block"
else
  bad "an existing AGENTS.md was not preserved alongside the block"
fi
# The managed block is rewritten in place, not appended again.
avo install --cwd "$guard" >/dev/null 2>&1
if [[ "$(grep -c 'BEGIN avo' "$guard/AGENTS.md")" == 1 ]]; then ok "the managed block appears exactly once after a re-run"; else bad "the managed block was appended twice"; fi
printf '{ not json\n' > "$guard/.pi/settings.json"
avo install --cwd "$guard" --agent pi >"$work/guard2.txt" 2>&1
if [[ "$(cat "$guard/.pi/settings.json")" == '{ not json' ]]; then ok "an unparseable .pi/settings.json is left exactly as it was"; else bad "avo install overwrote an unparseable .pi/settings.json"; fi
grep -q 'not valid JSON' "$work/guard2.txt"
yes_no $? "and the reason is reported" "the unparseable settings file was skipped silently"
rm -rf "$guard"

# ------------------------------------------------- 6. exit codes and --agent
say ""
say "## 6. flags and exit codes"
avo install --cwd "$fixture" --agent cursor >"$work/bad.txt" 2>&1; rc=$?
if [[ $rc == 2 ]]; then ok "an unknown agent exits 2"; else bad "an unknown agent exited $rc, expected 2"; fi
grep -q 'pi | claude | codex | all' "$work/bad.txt"
yes_no $? "and it names the valid agents" "the error does not name the valid agents"
single="$(mktemp -d)"; git -C "$single" init -q
avo install --cwd "$single" --agent codex >/dev/null 2>&1
if [[ -f $single/AGENTS.md ]]; then ok "--agent codex writes AGENTS.md"; else bad "--agent codex did not write AGENTS.md"; fi
if [[ ! -e $single/.pi/settings.json ]]; then ok "--agent codex leaves pi alone"; else bad "--agent codex wrote pi's settings"; fi
if [[ ! -e $single/.claude/skills ]]; then ok "--agent codex leaves claude alone"; else bad "--agent codex wired claude"; fi
rm -rf "$single"
avo install --cwd "$fixture" >/dev/null 2>&1
yes_no $? "avo install exits 0 on success" "avo install did not exit 0"
avo help | grep -q '^  install '
yes_no $? "avo help lists install" "avo help does not list install"

# ------------------------------------------------- 7. avo's own repo
say ""
say "## 7. avo's own repo"
own="$(avo install --json --cwd "$root")"
if printf '%s' "$own" | jq -e '[.steps[] | select(.name == ".agents/skills" and .action == "unchanged")] | length >= 1' >/dev/null; then
  ok "in avo's own checkout the skills are reported as already owned, not linked to themselves"
else
  bad "avo install tried to link avo's own skills into avo"
fi
if printf '%s' "$own" | jq -e '[.steps[] | select(.action == "created" or .action == "failed")] | length == 0' >/dev/null; then
  ok "and re-running it in this repo changes nothing"
else
  bad "running avo install in this repo was not a no-op: $(printf '%s' "$own" | jq -c '[.steps[]|select(.action!="unchanged")]')"
fi

say ""
say "# ${fails} failure(s)"
[[ $fails == 0 ]] || exit 1
