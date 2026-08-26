#!/usr/bin/env bash
# End-to-end checks for the arcagi3 optimization target: bench/init.sh's target-aware protected
# manifest, the ARC-AGI-3 `f`, its anti-gaming gates, and the known-good policy ladder.
# Writes evidence/arcagi3-e2e.txt.
#
# Two halves, deliberately. Everything up to section 6 runs with NO network and NO python toolkit,
# because that is what CI has; the ARC-AGI-3 engine is a 40MB dependency tree that CI should not be
# made to install. Sections 6 and 7 need `bench/setup.sh` to have been run against a target and are
# reported as SKIP otherwise -- never as a pass.
#
#   ./test/e2e-arcagi3.sh                 the offline half; SKIPs the scoring half
#   ARCAGI3_TARGET=<dir> ./test/e2e-arcagi3.sh    reuse a set-up target and run everything
set -uo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 1

evidence="$root/evidence/arcagi3-e2e.txt"
mkdir -p "$root/evidence"
: > "$evidence"

fails=0
say()  { printf '%s\n' "$*" | tee -a "$evidence"; }
ok()   { say "PASS  $*"; }
bad()  { say "FAIL  $*"; fails=$((fails + 1)); }
skip() { say "SKIP  $*"; }

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
repo="$scratch/arcagi3"

avo() { "$root/bin/avo" "$@"; }

# Invariant 6: a key must never reach any output. evidence/ is committed to git, so this canary is
# set for the whole run and grepped for at the end -- as test/e2e.sh does for ANTHROPIC_API_KEY.
CANARY="sk-arc-e2e-canary-must-not-leak"
export ARC_API_KEY="$CANARY"

say "# avo arcagi3 e2e -- $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "# $(git --version), jq $(jq --version)"
say "# target: bench/arcagi3 -- ARC-AGI-3 levels completed, higher is better, 10 games"
say ""

# ================================================================ 1. materializing the target
say "## 1. bench/init.sh --target arcagi3"

out="$(./bench/init.sh "$repo" --target arcagi3 2>&1)"
code=$?
say "\$ bench/init.sh \$scratch/arcagi3 --target arcagi3 -> exit $code"
if [[ $code -eq 0 && -d "$repo/.git" ]]; then ok "materializes into a fresh git repo"; else bad "did not materialize: $out"; fi
if [[ -x "$repo/.avo/score" ]]; then ok ".avo/score is executable"; else bad ".avo/score is not executable"; fi
if [[ -x "$repo/bench/setup.sh" ]]; then ok "bench/setup.sh is executable"; else bad "bench/setup.sh is not executable"; fi

# The manifest is the whole point of the target-aware change: the gate must cover exactly what
# bench/arcagi3/avo/protected.txt names, and nothing else.
want="$(grep -vE '^\s*(#|$)' bench/arcagi3/avo/protected.txt | sort)"
got="$(awk '{print $2}' "$repo/.avo/gate.sha256" | sort)"
if [[ "$want" == "$got" ]]; then
  ok "the gate covers exactly the $(wc -l <<<"$want") path(s) in avo/protected.txt"
else
  bad "the gate does not match avo/protected.txt:$(diff <(echo "$want") <(echo "$got") | tr '\n' ' ')"
fi
if grep -q '^\.avo/protected\.txt$' <<<"$got"; then
  ok "the manifest protects itself (a candidate that may edit the list has no list)"
else
  bad "the manifest is not in its own protected set"
fi

if [[ "$(git -C "$repo" rev-list --count HEAD 2>/dev/null)" == 1 ]]; then
  ok "the baseline is one commit: $(git -C "$repo" log --oneline -1)"
else
  bad "expected exactly one baseline commit"
fi
# avo/baseline-msg.txt, the other half of the target-aware change.
if git -C "$repo" log -1 --format=%s | grep -q 'arcagi3 v0'; then
  ok "the baseline commit message came from the template"
else
  bad "the baseline commit message is fuzzysearch's: $(git -C "$repo" log -1 --format=%s)"
fi
# The template ships its own .gitignore; the node_modules default must not have won.
if grep -q '^\.venv/$' "$repo/.gitignore" && ! grep -q node_modules "$repo/.gitignore"; then
  ok "the template's own .gitignore was kept (.venv/, not node_modules/)"
else
  bad ".gitignore is wrong: $(tr '\n' ' ' < "$repo/.gitignore")"
fi
# A holdout game that ships into the target has stopped being a holdout.
if [[ ! -e "$repo/holdout.lock" && ! -e "$repo/test/fixtures" ]] \
   && ! grep -qE 'ez04|cs01|mm02|pb01' "$repo/bench/games.lock"; then
  ok "no holdout game leaked into the target"
else
  bad "a holdout game is present in the target"
fi
say ""

# ================================================================ 2. fuzzysearch still works
say "## 2. the other target still materializes"
say "# bench/init.sh's protected list stopped being hardcoded; fuzzysearch must not have noticed"
fz="$scratch/fuzzysearch"
if ./bench/init.sh "$fz" >/dev/null 2>&1 && ./bench/init.sh --verify "$fz" >/dev/null 2>&1; then
  ok "fuzzysearch materializes and verifies through the manifest path"
else
  bad "the target-aware change broke fuzzysearch"
fi
say ""

# ================================================================ 3. the config list without a venv
say "## 3. .avo/score --configs answers before anything is installed"
say "# avo score --parallel asks for the config list first; a config list is a property of f, not"
say "# of whether the toolkit happens to be installed"
configs="$(cd "$repo" && .avo/score --configs 2>&1)"
n="$(grep -c . <<<"$configs")"
if [[ "$n" == 10 ]]; then
  ok "10 configs listed: $(tr '\n' ' ' <<<"$configs")"
else
  bad "expected 10 configs, got $n: $configs"
fi
if diff -q <(printf '%s\n' "$configs") <(cd "$repo" && .avo/score --configs) >/dev/null 2>&1; then
  ok "--configs is stable across calls"
else
  bad "--configs is not stable"
fi
# .avo/score scrapes TRAIN out of bench/run.py rather than asking it, so that it can answer with no
# python at all. That is only safe while the two agree, so check it -- run.py's --list path touches
# nothing but the standard library, so any python3 can answer it.
if command -v python3 >/dev/null 2>&1; then
  authoritative="$(cd "$repo" && python3 bench/run.py --list 2>&1)"
  if [[ "$configs" == "$authoritative" ]]; then
    ok "the scraped config list matches bench/run.py --list exactly"
  else
    bad "the scraped list and bench/run.py --list disagree: '$configs' vs '$authoritative'"
  fi
else
  skip "no python3 on PATH, so the scraped config list was not cross-checked"
fi
say ""

# ================================================================ 4. a missing harness is ok:false
say "## 4. no venv is a harness problem, not a bad candidate"
say "# ok:false and correct:false are different claims; mistaking the first for the second would"
say "# record 'this policy is wrong' about a machine that simply has nothing installed"
line="$(cd "$repo" && .avo/score 2>&1 | tail -n 1)"
if jq -e '.ok == false and .primary == null' >/dev/null 2>&1 <<<"$line"; then
  ok "ok:false with a null primary"
else
  bad "expected ok:false, got: $(head -c 300 <<<"$line")"
fi
if jq -e '.log | test("bench/setup.sh")' >/dev/null 2>&1 <<<"$line"; then
  ok "the log says how to fix it: $(jq -r '.log' <<<"$line")"
else
  bad "the log does not name bench/setup.sh: $(jq -r '.log // "<none>"' <<<"$line")"
fi
# And it must still be a well-formed scorer response, because avo parses it either way.
if jq -e 'has("ok") and has("correct") and has("primary") and has("unit") and has("higher_is_better")' \
     >/dev/null 2>&1 <<<"$line"; then
  ok "the failing response still carries every required field"
else
  bad "the failing response is missing required fields"
fi
if [[ "$(jq -r '.higher_is_better' <<<"$line")" == true ]]; then
  ok "higher_is_better is true (this is a capability, not a latency)"
else
  bad "higher_is_better is not true"
fi
say ""

# ================================================================ 5. the gate bites
say "## 5. f measures the candidate, not itself"
for victim in bench/run.py test/test_policy.py bench/games.lock .avo/protected.txt; do
  cp "$repo/$victim" "$scratch/keep"
  printf '\n# tampered\n' >> "$repo/$victim"
  line="$(cd "$repo" && .avo/score 2>&1 | tail -n 1)"
  gate_ok=false
  if [[ "$(jq -r '.correct' <<<"$line")" == false ]] && jq -e --arg v "$victim" '.log | test($v)' >/dev/null 2>&1 <<<"$line"; then
    gate_ok=true
  fi
  vout="$(./bench/init.sh --verify "$repo" --target arcagi3 2>&1)"
  vrc=$?
  if [[ "$gate_ok" == true ]] && (( vrc != 0 )) && grep -q "MODIFIED  $victim" <<<"$vout"; then
    ok "editing $victim fails f AND bench/init.sh --verify"
  else
    bad "editing $victim was not caught (score correct=$(jq -r '.correct' <<<"$line"), verify exit $vrc)"
  fi
  cp "$scratch/keep" "$repo/$victim"
done
if ./bench/init.sh --verify "$repo" --target arcagi3 >/dev/null 2>&1; then
  ok "restoring every protected file makes --verify clean again"
else
  bad "--verify is still dirty after restoring"
fi
say ""

# ================================================================ 6. scoring (needs the toolkit)
say "## 6. the real thing"
target="${ARCAGI3_TARGET:-}"
have=false
if [[ -n "$target" && -x "$target/.venv/bin/python" && -d "$target/bench/games" ]]; then
  have=true
elif (cd "$repo" && ./bench/setup.sh --check >/dev/null 2>&1); then
  target="$repo"; have=true
fi

if [[ "$have" != true ]]; then
  skip "no set-up arcagi3 target: the ARC-AGI-3 toolkit and the pinned corpus are not installed"
  say "      to run this half:  ./bench/init.sh /tmp/t --target arcagi3 && (cd /tmp/t && ./bench/setup.sh)"
  say "      then:              ARCAGI3_TARGET=/tmp/t ./test/e2e-arcagi3.sh"
  say ""
else
  say "# target $target"
  base="$(cd "$target" && .avo/score 2>&1 | tail -n 1)"
  if [[ "$(jq -r '.correct' <<<"$base")" == true ]]; then
    ok "the baseline scores: primary $(jq -r '.primary' <<<"$base") over $(jq -r '.scores|length' <<<"$base") configs"
  else
    bad "the baseline does not score: $(jq -r '.log' <<<"$base" | head -c 400)"
  fi
  if jq -e '.primary > 0' >/dev/null 2>&1 <<<"$base"; then
    ok "the baseline is above zero, so the loop has a gradient to climb from"
  else
    bad "the baseline scores zero -- every commit would be refused and the loop would stall"
  fi
  # No config may sit at or near zero: avo commit compares RELATIVE deltas, so a config at 0.02
  # swings +/-100% on one level and vetoes every commit.
  if jq -e '[.scores[] | select(. < 0.05)] | length == 0' >/dev/null 2>&1 <<<"$base"; then
    ok "no config sits near zero (a near-zero config vetoes every commit)"
  else
    bad "a config is near zero: $(jq -c '.scores' <<<"$base")"
  fi

  again="$(cd "$target" && .avo/score 2>&1 | tail -n 1)"
  if [[ "$(jq -cS '.scores' <<<"$base")" == "$(jq -cS '.scores' <<<"$again")" ]]; then
    ok "the score vector is bit-identical on a second run -- f is deterministic, which is what"
    say "      lets .avo/config.json use a floor at all"
  else
    bad "the score changed between runs: $(jq -c '.scores' <<<"$base") vs $(jq -c '.scores' <<<"$again")"
  fi

  one="$(cd "$target" && .avo/score --config ff01 2>&1 | tail -n 1)"
  if jq -e '.correct == true and (.scores | keys) == ["ff01"]' >/dev/null 2>&1 <<<"$one"; then
    ok "--config scores one game only"
  else
    bad "--config did not narrow to one game: $(head -c 200 <<<"$one")"
  fi
  say ""

  # ---- the sandbox, which is the gate f cannot express as a hash ----
  say "### the sandbox"
  say "# a policy has two cheap routes to a high score that are not playing well"
  saved="$scratch/policy.py.orig"
  cp "$target/src/policy.py" "$saved"

  cat > "$target/src/policy.py" <<'CHEAT'
import pathlib
class Policy:
    def __init__(self, action_space, rng):
        self.action_space = action_space; self.rng = rng
    def act(self, frame):
        for p in pathlib.Path("bench/games").rglob("*.py"):
            p.read_text(); break
        a = self.rng.choice(self.action_space)
        return (a, {"x": 0, "y": 0}) if a.is_complex() else (a, {})
CHEAT
  line="$(cd "$target" && .avo/score 2>&1 | tail -n 1)"
  if [[ "$(jq -r '.correct' <<<"$line")" == false ]] && jq -e '.log | test("read a game source")' >/dev/null 2>&1 <<<"$line"; then
    ok "a policy that reads a game's source is refused"
  else
    bad "reading a game source was not caught: $(jq -r '.correct,.log' <<<"$line" | tr '\n' ' ' | head -c 300)"
  fi

  # The version of this that matters: the cheat swallows the error the sandbox raises. An earlier
  # sandbox raised a plain Exception and this scored a clean 0.26.
  cat > "$target/src/policy.py" <<'CHEAT'
class Policy:
    def __init__(self, action_space, rng):
        self.action_space = action_space; self.rng = rng
    def act(self, frame):
        import socket
        try:
            socket.getaddrinfo("example.com", 80)
        except BaseException:
            pass
        a = self.rng.choice(self.action_space)
        return (a, {"x": 0, "y": 0}) if a.is_complex() else (a, {})
CHEAT
  line="$(cd "$target" && .avo/score 2>&1 | tail -n 1)"
  if [[ "$(jq -r '.correct' <<<"$line")" == false ]] && jq -e '.log | test("network access")' >/dev/null 2>&1 <<<"$line"; then
    ok "a policy that reaches the network is refused even when it swallows the error"
  else
    bad "network access was not caught: $(jq -r '.correct,.log' <<<"$line" | tr '\n' ' ' | head -c 300)"
  fi

  cat > "$target/src/policy.py" <<'CHEAT'
class Policy:
    def __init__(self, action_space, rng):
        self.action_space = action_space
    def act(self, frame):
        return "ACTION9", {}
CHEAT
  line="$(cd "$target" && .avo/score 2>&1 | tail -n 1)"
  if [[ "$(jq -r '.correct' <<<"$line")" == false ]]; then
    ok "an illegal action is refused"
  else
    bad "an illegal action scored"
  fi
  cp "$saved" "$target/src/policy.py"
  say ""

  # ---- 7. the ladder ----
  say "## 7. a scripted optimizer walks the known-good ladder"
  say "# each rung replaces src/policy.py, then avo score + avo commit decide. The second rung is a"
  say "# measured REGRESSION and must be refused: that is the vector rule, not a formality."
  # A fresh materialization rather than a copy of $target: `cp -r` dereferences the .venv symlink
  # and produces a venv whose interpreter paths point at the wrong prefix, so `f` came back
  # "toolkit not installed" and every rung read as a correctness failure. The venv and the corpus
  # are borrowed by symlink instead -- neither is part of the candidate, and both are gitignored.
  ladder="$scratch/ladder"
  if ! ./bench/init.sh "$ladder" --target arcagi3 >/dev/null 2>&1; then
    skip "could not materialize a target for the ladder"
  else
    ln -s "$(cd "$target/.venv" && pwd -P)" "$ladder/.venv"
    ln -s "$(cd "$target/bench/games" && pwd -P)" "$ladder/bench/games"
    avo init --cwd "$ladder" --json >/dev/null 2>&1
    committed=0
    refused=0
    avo commit --cwd "$ladder" --why "baseline: the blind random walk" --json >/dev/null 2>&1 \
      && committed=$((committed + 1))

    c="$(cp "$root/test/fixtures/arcagi3/policy-v1-aimed-clicks.py" "$ladder/src/policy.py" \
      && avo commit --cwd "$ladder" --why "aim the clicks at the bounding box of non-background cells" --json 2>&1)"
    if [[ "$(jq -r '.action' <<<"$c")" == committed ]]; then
      committed=$((committed + 1))
      ok "rung 1 (aimed clicks) commits: $(jq -r '.reason' <<<"$c")"
    else
      bad "rung 1 did not commit: $(jq -r '.action, .reason' <<<"$c" | tr '\n' ' ')"
    fi
    # The movement games must come back bit-identical, which is the property that makes this rung
    # commit at all rather than fight the rng noise.
    if jq -e '[.comparison.deltas[] | select(.rel == 0)] | length >= 7' >/dev/null 2>&1 <<<"$c"; then
      ok "the seven movement games are bit-identical (rel: 0), so the click win is measured exactly"
    else
      bad "expected >= 7 configs at rel 0: $(jq -c '[.comparison.deltas[] | {config,rel}]' <<<"$c")"
    fi

    c="$(cp "$root/test/fixtures/arcagi3/policy-v2-cell-clicks.py" "$ladder/src/policy.py" \
      && avo commit --cwd "$ladder" --why "draw clicks from the non-background cells themselves" --json 2>&1)"
    if [[ "$(jq -r '.action' <<<"$c")" == refused ]]; then
      refused=$((refused + 1))
      ok "rung 2 is refused: $(jq -r '.reason' <<<"$c")"
    else
      bad "rung 2 should have been refused (mm01 loses everything): $(jq -r '.action, .reason' <<<"$c" | tr '\n' ' ')"
    fi
    git -C "$ladder" checkout -- src/policy.py 2>/dev/null

    if (( committed >= 2 && refused >= 1 )); then
      ok "$committed version(s) committed, $refused refused"
    else
      bad "expected >= 2 commits and >= 1 refusal, got $committed and $refused"
    fi

    # A score in the lineage is a measurement, not a claim.
    while read -r v sha recorded; do
      [[ -n "$v" ]] || continue
      wt="$scratch/replay-v$v"
      if ! git -C "$ladder" worktree add -q --detach "$wt" "$sha" 2>/dev/null; then
        bad "v$v: could not check out $sha"; continue
      fi
      # The worktree has no .venv or corpus of its own; f needs both, so borrow the target's.
      ln -s "$ladder/.venv" "$wt/.venv" 2>/dev/null
      ln -s "$ladder/bench/games" "$wt/bench/games" 2>/dev/null
      fresh="$(cd "$wt" && .avo/score 2>/dev/null | tail -n 1 | jq -r '.primary // "null"')"
      git -C "$ladder" worktree remove --force "$wt" 2>/dev/null
      if [[ "$fresh" == null || -z "$fresh" ]]; then
        bad "v$v does not score from its own commit"
      elif [[ "$fresh" == "$recorded" ]]; then
        ok "v$v reproduces its recorded score exactly ($recorded)"
      else
        bad "v$v recorded $recorded but re-scores at $fresh"
      fi
    done < <(avo lineage --cwd "$ladder" --json 2>/dev/null | jq -r '.[] | "\(.version) \(.sha) \(.score.primary)"')
    git -C "$ladder" worktree prune 2>/dev/null
  fi
  say ""

  # ---- 8. the holdout ----
  say "## 8. the holdout catches what f cannot"
  hb="$("$root/test/fixtures/arcagi3/score-holdout.sh" "$target" --json 2>&1 | tail -n 1)"
  if jq -e '.primary > 0 and .games == 8' >/dev/null 2>&1 <<<"$hb"; then
    ok "the baseline scores $(jq -r '.primary' <<<"$hb") on 8 unseen games"
  else
    skip "the holdout did not run (it needs the network to fetch its corpus): $(head -c 200 <<<"$hb")"
  fi
  if jq -e '.scores | has("cs01") and has("mm02")' >/dev/null 2>&1 <<<"$hb"; then
    ok "the holdout includes click games, so a click improvement has somewhere to show up"
  else
    skip "holdout corpus unavailable, so its composition was not checked"
  fi
  say ""
fi

# ================================================================ the canary
say "## the key never leaked"
say "# evidence/ is committed to git (invariant 6)"
if grep -rqF "$CANARY" "$evidence" 2>/dev/null; then
  bad "ARC_API_KEY leaked into evidence/arcagi3-e2e.txt"
else
  ok "ARC_API_KEY does not appear in the evidence file"
fi
say ""

if [[ $fails -eq 0 ]]; then
  say "e2e-arcagi3: all checks passed ($(grep -c '^PASS' "$evidence") of them, $(grep -c '^SKIP' "$evidence") skipped)"
else
  say "e2e-arcagi3: $fails check(s) failed"
fi
exit $((fails > 0))
