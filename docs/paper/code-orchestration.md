# Code notes: the orchestration layer

Auxiliary notes for the article *An implementation of NVIDIA's Agentic Variation Operators (AVO) for
Autonomous Evolutionary Search*. Scope: how the agent loop runs. That is `avo run`, `avo supervise`,
`avo fan`, the agent adapters, the pi extensions, and the meta loop that built the repo.

All line references are to the tree at commit `d05177c`. Quotes are verbatim. Where a statement is
an inference and not a quote, it says so.

Notation follows the paper (`docs/avo-paper.md:29`): `P_t` is the lineage, `K` is the knowledge
base, `f` is the scoring function, and `Vary(P_t) = Agent(P_t, K, f)`.

---

## 0. Map of the layer

| File | Lines | Role |
| --- | --- | --- |
| `src/agents.ts` | 436 | command templates for pi / claude / codex / custom; `driveAgent` runs one headless turn; `parseAgentOutput` reads summary, tokens, cost |
| `src/run.ts` | 823 | `avo run`: the outer loop *turn → commit → supervise → inject* |
| `src/supervise.ts` | 550 | `avo supervise`: pure stall/thrash detector plus a directive that cites `P_t`, memory and `K` |
| `src/fan.ts` | 1065 | `avo fan`: N detached worktrees, N probes, the four guards, promote, resume, clean |
| `pi/extensions/avo/{index,tools}.ts` | 19 + 412 | six native pi tools, thin wrappers over `src/` |
| `pi/extensions/avo-supervisor/{index,supervisor}.ts` | 21 + 241 | the supervisor inside a pi session, driven by `tool_result` events |

The CLI and the pi bindings import the same `src/` files. There is no build step
(`docs/architecture.md:60-62`). So the commit rule, the detector and the guards each exist once.

The orchestration layer calls two lower contracts that other notes cover in depth:

- `decideCommit` (`src/lineage.ts:417`), the only writer of a version (invariant 1).
- `runScore` (`src/score.ts:527`), the single path that runs `.avo/score` and writes an attempt to
  `.avo/attempts.jsonl` (`ATTEMPTS_PATH`, `src/score.ts:16`).

---

## 1. `avo run` — the outer loop

### 1.1 What it is

The file header states the design (`src/run.ts:1-9`):

> `avo run` — the continuous driver. N iterations of
> *agent turn → `avo commit` → `avo supervise` → inject the directive*.
> ...
> New here is the *between*: every iteration is a fresh process, so the turn prompt is the only
> continuity.

So one iteration is one fresh agent process. The process has no memory of earlier turns. All
continuity is in git (`P_t`), in `.avo/attempts.jsonl` (trajectory), in memory (`bd` or
`lineage/memory.jsonl`), and in the turn prompt.

### 1.2 Arguments, budgets and defaults

`parseRunArgs` (`src/run.ts:187-270`):

| Flag | Default | Source |
| --- | --- | --- |
| `--prompt` / `--prompt-file` | required, mutually exclusive | `run.ts:263-268` |
| `--agent` | `$AVO_AGENT`, then `.avo/config.json` `agent.name`, then first of `pi`, `claude`, `codex` on `$PATH` | `run.ts:194`, `497-509` |
| `--model` | `null` (the agent's own default) | `run.ts:193-195` |
| `-n` / `--max-iters` | `DEFAULT_MAX_ITERS = 10` | `run.ts:51` |
| `--timeout` (seconds per turn) | `DEFAULT_TIMEOUT_S = 900` | `fan.ts:44` |
| `--stall` (>= 1), `--thrash` (>= 2) | from `.avo/config.json`, else 5 and 3 | `run.ts:244-255`, `config.ts:74-76` |
| `--dry-run` | off | `run.ts:211` |

A key choice: `avo run` does **not** read `AVO_PROBE_MODEL` (`src/run.ts:193`):

> `// Not AVO_PROBE_MODEL: probes explore small, `avo run` exploits on the agent's default.`

There is a per-turn time budget (`--timeout`) and an iteration budget (`--max-iters`). There is
**no** wall-clock budget for the whole run and **no** cost budget. Cost is recorded but not
enforced. PLAN.md records this as open issue #28: "at this rate a 12-iteration default run is ~$33,
and nothing in the harness would stop it" (`PLAN.md:597-599`). In the S9b runs the operator used an
external watchdog that wrote `.avo/STOP` (`PLAN.md:496`, `564`).

### 1.3 Pre-flight (read-only)

`runLoop` (`src/run.ts:468-568`) does these checks before it writes anything:

1. Read the prompt; refuse an empty one (`run.ts:471-481`).
2. **Guards.** `checkGuards(env, promptSha(prompt))` (`run.ts:485-487`). This is the same depth and
   cycle budget as `avo fan` (see §3.4). The comment says why (`run.ts:483-484`):
   > a turn can call `avo run`, and a loop inside a loop is the same exponential hazard.
3. Load thresholds from config; flags override (`run.ts:490-495`).
4. Resolve the agent template (`run.ts:497-511`).
5. Require a git repo with at least one commit (`run.ts:513-519`).
6. Warn once if `.avo/score` is missing (`run.ts:520-523`): "Warn once, not --max-iters times."
7. Build the `RunReport` (`run.ts:526-553`). `--dry-run` returns here (`run.ts:555-560`).

Only after that does it write: `ensureTrajectoryIgnored` adds `.avo/runs/` to `.avo/.gitignore`,
and the first manifest is written (`run.ts:562-567`).

`--dry-run` prints the plan. Real output, from a scratch fixture repo (rendered by `renderPlan`,
`run.ts:713-746`):

```
avo run (--dry-run: nothing is spawned, nothing is committed)

  agent        claude
  command      claude --print --output-format stream-json --verbose --permission-mode bypassPermissions -- <prompt>
  approval     --permission-mode bypassPermissions (a prompt in --print mode is an auto-denial)
  model        — (the agent's own default)
  iterations   up to 3
  timeout      900s per turn
  thresholds   stall 5, thrash 3
  ...
each iteration:
  1. spawn the agent in <cwd> with the turn prompt
  2. avo commit — score the tree, compare against the best version, persist only if it wins
     (a turn that ran avo commit itself leaves nothing here; its version is still recorded)
  3. avo supervise — 5 attempts with no improvement, or 3 failures
     with the same signature, emits a steering directive that cites P_t and K
  4. inject that directive into the next turn's prompt and record it as an intervention

stops on: --max-iters 3, .avo/STOP, 3 unchanged iterations in a row,
          or an agent binary that cannot be started
```

### 1.4 The iteration body

`iterate` (`src/run.ts:570-706`). One pass of the `for` loop at `run.ts:585`:

1. **Stop file.** If `.avo/STOP` exists, stop before the turn (`run.ts:586-590`). The constant
   comment (`run.ts:49`): "Stops the loop from outside — no process to find, and an agent can reach
   it." The `avo-vary` skill tells the agent to `touch .avo/STOP` "when the task is genuinely done"
   (`.agents/skills/avo-vary/SKILL.md:105-106`).
2. **Record HEAD**, then **drive the agent** (`run.ts:592-606`):
   ```ts
   const turn = await driveAgent(
     runner,
     template,
     { prompt: turnPrompt(base, iter, opts.maxIters, prev, directive), model: opts.model },
     { cwd: opts.cwd, logPath, logFile: join(opts.cwd, logPath), timeoutS: opts.timeoutS,
       env: { ...childEnv, AVO_FAN_PROBE: String(iter) } },
     now,
   );
   ```
   The agent runs in the **root working tree**, not a worktree (header, `run.ts:5-6`: "the agent
   works in the root tree, where uncommitted work is the point rather than a hazard"). Its full
   stdout+stderr goes to `.avo/runs/<run-id>/logs/<iter>.log`.
3. **Sum tokens and cost** (`run.ts:623-630`). Summing is safe because each turn is a fresh process.
   `cost_usd` stays `null` until some agent reports a cost: "`null` and `0` differ — nothing measured
   versus nothing spent" (`run.ts:158-160`).
4. **Spawn failure stops the loop** (`run.ts:632-639`): "It will not start next iteration either;
   retrying is spinning."
5. **Commit.** The agent's final message, capped at 2,000 chars and 40 lines, becomes `--why`
   (`run.ts:641-657`, `WHY_CAP_CHARS = 2_000` at `run.ts:58`). Then
   `decideCommit(commitOpts, runner, now)` and `recordDecisionMemory(...)` (`run.ts:658-659`). The
   comment (`run.ts:641-642`):
   > The only writer of a version (invariant 1), through the same `decideCommit` the command
   > calls, so the rule cannot differ. The agent's final message is the `--why`.

   A silent turn commits with `why: null` and gets the warning `NO_SUMMARY` (`run.ts:61`, `646`).
   This is the fix for #49, where a raw JSON protocol event once became a permanent rationale.
6. **Credit the agent's own commits** (`run.ts:661-668`, `agentVersions` at `run.ts:451-466`). The
   skill tells the agent it may run `avo commit` itself. So the harness reads the `Avo-Version`
   trailers in `head_before..head_after` and credits those versions too. This is #42: before the
   fix, a run that grew four versions reported `committed: []` (`PLAN.md:526-531`).
7. **No-op counter** (`run.ts:670-672`):
   ```ts
   const idle = decision.action === "noop" && it.head_after === it.head_before;
   noops = idle ? noops + 1 : 0;
   ```
8. **Supervise** (`run.ts:674-676`): the same `supervise()` that `avo supervise` calls.
9. **Inject and record** (`run.ts:678-685`). The directive is stored on this iteration but injected
   into the *next* turn's prompt. If a signal fired, `recordIntervention` writes an
   `intervention` memory keyed by `avo-intervention-<shortHash(runId:iter)>` (`run.ts:411-437`).
10. **Rewrite the manifest** (`run.ts:688`).
11. **No-progress stop** (`run.ts:690-696`) when `noops >= MAX_CONSECUTIVE_NOOPS` (3, `run.ts:56`).

After the loop, `ok` is true if there were no errors and at least one turn's process ended cleanly
(`run.ts:702`).

### 1.5 The turn prompt

`turnPrompt` (`src/run.ts:313-334`). Iteration 1 gets the operator's prompt verbatim. Later
iterations get the prompt plus a footer:

```ts
const lines = [base.trimEnd(), "", "---", `# avo run — iteration ${iter} of ${maxIters}`, ""];
if (prev !== null) {
  lines.push(`Previous iteration: ${describeOutcome(prev)}`);
  const s = prev.supervision;
  if (s !== null) lines.push(`State: ${s.since_best} attempt(s) since the best version.`);
  lines.push(
    "",
    "You are a fresh process: nothing from the previous turn is in your context. Read what is",
    "already known before editing — `avo lineage`, `avo best`, `avo mem prime`.",
  );
}
if (directive !== null) lines.push("", directive.trimEnd());
```

`describeOutcome` (`run.ts:285-307`) gives one line per outcome, for example
`committed v3 at 0.408 ms — <reason>`, `refused at 0.42 ms — <reason>`, or
`nothing changed in the working tree, so there was nothing to score`.

The directive is **appended**, not substituted (test: `test/run.test.ts:134`, "a directive is
appended to the turn prompt, not substituted for it").

### 1.6 Termination conditions

`StopReason` (`src/run.ts:126`):

```ts
export type StopReason = "max-iters" | "stop-file" | "no-progress" | "agent-unavailable" | "dry-run";
```

| Reason | Trigger | Line |
| --- | --- | --- |
| `max-iters` | the `for` loop ends | `run.ts:585`, `699-701` |
| `stop-file` | `.avo/STOP` exists before a turn | `run.ts:586-590` |
| `no-progress` | 3 consecutive idle turns (no-op **and** HEAD unmoved) | `run.ts:690-696` |
| `agent-unavailable` | the agent binary cannot spawn | `run.ts:633-639` |
| `dry-run` | `--dry-run` | `run.ts:555-560` |

The supervisor never stops the loop. It only steers. The no-progress stop exists because the
supervisor cannot see an idle turn (`run.ts:52-56`):

> Idle iterations before giving up. An unchanged tree records no attempt, so the stall detector
> cannot see it — the one stop condition the supervisor cannot express.

A timed-out turn does **not** stop the loop. Its process group is killed and the loop carries on
(test: `test/run.test.ts:512`).

### 1.7 Logging and crash recovery

- **Per-turn raw log:** `.avo/runs/<run-id>/logs/<iter>.log` (`run.ts:592`; written by
  `driveAgent`, `agents.ts:404-410`).
- **Manifest:** `.avo/runs/<run-id>/manifest.json`. The manifest **is** the `--json` report
  (`run.ts:128-131`): "One shape, not two: a manifest that can drift from `--json` is one nobody
  trusts after a crash, which is the only time anybody reads it."
- **Written after every iteration** (`run.ts:344-355`): "A days-long loop gets killed eventually, and
  per-iteration versus at-exit is a recoverable record versus nothing."
- **Interventions** go to memory as `kind: "intervention"` beads (`run.ts:411-437`).
- **Run id:** `YYYYMMDDTHHMMSSZ-<sha6 of prompt>`, with a `-k` suffix on collision (`fan.ts:374-377`,
  `run.ts:368-373`).
- **Trajectory, not lineage:** `.avo/runs/` is gitignored, so logs never dirty the tree that the next
  `avo commit` reasons about (test: `test/run.test.ts:393`).

What "crash recovery" means here, precisely: there is **no** `avo run --resume`. Recovery is
structural. (a) The lineage is in git, and each version is committed before the next turn starts.
(b) The manifest holds every finished iteration. (c) A new `avo run` with the same prompt continues
from HEAD, because the agent reads `P_t` at the start of each turn. S9b-2a did exactly this: "Same
target repo, same prompt, resumed from v4 rather than re-materialized" (`PLAN.md:558`). PLAN.md §6
Q4 keeps the option to adopt Postgres-backed durable execution ("absurd") if the loop proves fragile
across days (`PLAN.md:666-667`). Only `avo fan` has a true `--resume` (§3.6).

Timeout kills the whole process group: `spawnRunner` spawns `detached: true` and on timeout calls
`process.kill(-pid, "SIGKILL")` (`src/score.ts:110-135`). Output is capped at 200 KB with a 50 KB
rolling tail (`score.ts:18`, `28`) so the closing `result` event survives (fix for #43).

---

## 2. `avo supervise` — stagnation detection

### 2.1 Purpose

File header (`src/supervise.ts:1-18`):

> The harness runs for days, and the paper is explicit that the agent needs *steering*, not just
> scoring: an unsupervised variation operator plateaus and keeps plateauing.
>
> Two detections, both from what the harness already records:
>
>   stall   — attempts since the last committed improvement. `P_t` is monotone, so the newest
>             version *is* the last improvement; everything after it did not win.
>   thrash  — consecutive failures with the same signature. Re-trying one broken thing reads
>             exactly like progress from inside a single turn.
>
> The output is a directive that **cites**. "Try something else" is worthless — the agent already
> believes it is.

### 2.2 Inputs

- The attempt log `.avo/attempts.jsonl`, last `ANALYSIS_WINDOW = 1_000` records
  (`supervise.ts:32`, `readAttempts` at `72-107`). Malformed lines are skipped and counted.
- The lineage from git (`readLineage`). Because the commit rule admits only non-regressions, the
  best version is the newest one (`docs/architecture.md:151-152`).
- Memory and `K`, **only if a signal fired** (`supervise.ts:448-458`). PLAN.md: "The command a loop
  runs every iteration must be cheap in the common case" (`PLAN.md:335-336`).

### 2.3 The exact signals

These are the only two signals. There is **no** plateau-by-score-delta test, **no** "repeated idea"
test, and **no** similarity measure between a candidate and prior versions. Repetition is handled
two other ways: (a) thrash matches failure *signatures*; (b) the directive lists prior versions
and tells the agent that "a variation that only re-derives one of these is not progress". The
agent, not the harness, judges similarity of ideas.

Let `A = (a_1, …, a_m)` be the windowed attempts, newest last, and `b` the best version.

**Stall** (`detect`, `supervise.ts:238`, `261-267`; `sinceBest`, `supervise.ts:196-205`).

```ts
return attempts.filter((a) => {
  if (a.git.head === best.sha) return true;
  if (Number.isNaN(commitMs)) return true;
  const t = Date.parse(a.ts);
  return !Number.isNaN(t) && t >= commitMs + 1_000;
}).length;
```

Formally:

```
s = |{ a ∈ A : head(a) = sha(b)  ∨  ts(a) ≥ date(b) + 1 s }|      (s = m if no version exists)
stall fires  ⇔  s ≥ N  ∧  s > 0,      N = supervise.stall (default 5, minimum 1)
```

Why the git head and not the clock (`supervise.ts:183-195`): the attempt that *became* `b` was
scored before the commit and carries the parent's sha. Git truncates author dates to the second,
so a millisecond timestamp can look later than the commit. The clock is only a fallback, with a
1 s margin. An attempt that **passed** `f` but did not beat `b` still counts toward the stall
(`.agents/skills/avo-vary/SKILL.md:75-76`).

**Thrash** (`supervise.ts:214-227`, `268-275`). Let `σ(a)` be the failure signature, `null` for a
passing attempt. Let `r` be the length of the longest suffix of `A` whose signatures all equal
`σ(a_m) ≠ null`.

```
thrash fires  ⇔  r ≥ K,      K = supervise.thrash (default 3, minimum 2)
```

A pass breaks the streak (test: `test/supervise.test.ts:176`).

**The failure signature** (`failureSignature`, `supervise.ts:135-144`). First harness errors, then
the scorer's first non-empty log line, then a fixed fallback. Then `normalizeSignature`
(`supervise.ts:118-128`) folds out noise that changes between runs of one broken build:

```ts
.toLowerCase()
.replaceAll("\\", "/")
.replace(/(\/(?:tmp|var\/folders)\/)[^\s:,)"']+/g, "$1T")   // temp dirs
.replace(/\b[0-9a-f]{7,40}\b/g, "H")                        // shas (before digits)
.replace(/\d+(?:\.\d+)?/g, "N")                              // numbers, pids, timings
.replace(/\s+/g, " ")
.trim()
.slice(0, SIGNATURE_CAP);                                    // 200 chars
```

PLAN.md records the choice of signature over "same file region": `Attempt` records no file list,
and "The signature ... is the region information the scorer already reports" (`PLAN.md:318-322`).

Both signals can fire at once (test: `test/supervise.test.ts:217`). Thresholds come from
`.avo/config.json` `supervise.{stall,thrash}`; a flag overrides (`supervise.ts:429-431`).

### 2.4 What the directive cites

`citationsFor` (`supervise.ts:330-356`):

| Kind | Count | Order | Text |
| --- | --- | --- | --- |
| `version` | up to 3 (`MAX_VERSION_CITATIONS`) | newest first | score, first line of `--why`, path `lineage/vNNN.md` |
| `failure` then `insight` | up to 5 together (`MAX_MEMORY_CITATIONS`) | dead ends first | memory text |
| `knowledge` | up to 3 (`MAX_KNOWLEDGE_CITATIONS`) | `K` order | docs in `knowledge/` never mentioned by the lineage |

**Unread docs.** A doc counts as explored when at least half of its title's significant terms
appear in the corpus of all version rationales plus all non-intervention memories
(`isExplored`, `supervise.ts:295-301`; `exploredCorpus`, `324-328`):

```ts
const found = terms.filter((t) => corpus.includes(t)).length;
return found * 2 >= terms.length;
```

So, with `T(d)` the significant terms of doc `d`'s title (or file name) and `C` the corpus:

```
unexplored(d)  ⇔  2·|{ t ∈ T(d) : t ⊂ C }| < |T(d)|
```

The bar is low on purpose (`supervise.ts:290-294`): "wrongly 'explored' only costs a citation, while
wrongly *unexplored* sends the agent back down a road it already travelled".

**Interventions are never cited** (`aboutTheProblem`, `supervise.ts:307-321`). Two reasons found by
running the loop: citing one nests old directives inside new ones, and it would put the doc names a
directive recommended into the corpus, so "every doc the supervisor ever recommended read as
explored. It would erase its own best advice."

### 2.5 The directive text

`renderDirective` (`supervise.ts:375-401`). Capped at 4,000 chars (`DIRECTIVE_CAP`,
`supervise.ts:35`) because it goes into a prompt. Stall steps are `STALL_STEPS`
(`supervise.ts:362-367`); if any thrash fired, the steps are `THRASH_STEPS` instead
(`supervise.ts:369-373`, `394`).

Real output, produced for these notes in a scratch fixture repo (one version, then five scores
that did not beat it, two docs in `K`):

```
STEERING (avo supervise)

- stall: 5 attempt(s) since v1 (16 bytes) with no committed improvement; the threshold is 5

Read this before editing anything:
  avo lineage            # every version and its score
  avo lineage show 1     # the version to beat, and why it won
  avo mem prime          # what earlier runs already learned

Already committed (a variation that only re-derives one of these is not progress):
  - v1 — 16 bytes — shrink the kernel by removing five redundant bytes (lineage/v001.md)

In K and never mentioned by any version — unexplored:
  - knowledge/loop-tiling.md — Loop tiling and cache blocking
  - knowledge/register-pressure.md — Register pressure on Blackwell

Do this next:
  1. Name the direction you are about to take, and say how it differs from every line above. If you cannot, you do not have a new idea yet.
  2. Change one thing, then `avo score` before you change a second — two edits at once cannot be attributed.
  3. `avo commit --why "<the direction>"` when it measures better. A refusal is a measurement: record it with `avo mem add`, do not retry it.
  4. If every direction you can name is already above, do not guess: `avo fan --n 4` explores four at once and lets `f` choose, and `avo know search "<question>"` puts what you find into `K`.
```

The same fixture, after a memory insight and three failing scores with one error
(`kernel.txt:3: undefined symbol foo (pid 4242)`), fires both signals. Note how the signature is
normalized and how the steps change:

```
- stall: 8 attempt(s) since v1 (16 bytes) with no committed improvement; the threshold is 5
- thrash: the last 3 attempts failed the same way ("kernel.txt:N: undefined symbol foo (pid N)"); the threshold is 3
...
Remembered:
  - unrolling-the-loop-4x-regressed-small-by-12 — unrolling the loop 4x regressed small by 12%
...
Do this next:
  1. Read the failure before editing again — the same error N times means the *diagnosis* is wrong, not the edit. `avo score --json` carries the scorer's log.
  2. Get back to a measurable state first: `avo best` names the version to return to, and `git diff` shows what you have actually changed since.
  3. Then change direction, not degree. A smaller version of the same edit fails the same way.
```

### 2.6 Exit codes and JSON

`superviseCommand` (`supervise.ts:540-550`): `0` = no intervention, `1` = a signal fired and a
directive was printed, `2` = harness error. So `avo supervise || inject` is the whole shell
integration (`PLAN.md:328-330`). `--json` returns `{triggered, state, signals, citations,
directive, thresholds, warnings}` (`Supervision`, `supervise.ts:403-413`).

### 2.7 Relation to the paper's self-supervision

The paper (`docs/avo-paper.md:49`):

> the agent may stall when it exhausts its current line of exploration, or it may enter
> unproductive cycles of edits that repeatedly fail to improve scores. To mitigate both, AVO
> incorporates a self-supervision mechanism that detects these scenarios and intervenes. Once
> triggered, the mechanism reviews the overall evolutionary trajectory and steers the search toward
> several candidate optimization directions.

Mapping:

| Paper | avocode |
| --- | --- |
| "stall when it exhausts its current line of exploration" | `stall`: `s ≥ N` attempts since the best version |
| "unproductive cycles of edits that repeatedly fail" | `thrash`: `r ≥ K` same-signature failures |
| "reviews the overall evolutionary trajectory" | reads lineage + attempt log + memory + `K` |
| "steers ... toward several candidate optimization directions" | cites prior versions (do not re-derive), dead ends (do not retry), unexplored `K` docs (candidate directions), and suggests `avo fan --n 4` |
| supervisor *agent* | a **deterministic** rule-based detector plus a template. No LLM call |

The key difference: the paper describes a supervisor *agent*. avocode's supervisor is not an LLM.
It is a pure function (`detect`, `supervise.ts:209-277`) plus a fixed template. The intelligence
stays in the main agent, which reads the citations. The paper does not publish its threshold.
PLAN.md §6 Q3 starts at 5 and keeps the question open: across nine real agent turns the supervisor
fired **zero** times, because every turn committed (`PLAN.md:615-619`, `660-665`).

---

## 3. `avo fan` — N directions at once

### 3.1 Purpose

File header (`src/fan.ts:1-8`):

> `avo fan` — N variation directions at once, each in its own `git worktree` and headless agent
> process. OS-level isolation, no shared state: `mjakl/pi-subagent`'s pattern (PLAN §2), and its
> same four guards.
>
> Invariant 7 governs the file: **worktrees are disposable, `main` is not.** Nothing writes outside
> a worktree, and promoting a probe is a separate, explicit step.

Modes (`FanMode`, `fan.ts:138`): `run`, `promote`, `resume`, `list`, `clean`.

### 3.2 Defaults

| Item | Value | Line |
| --- | --- | --- |
| probes `--n` | 3 | `fan.ts:42` |
| timeout per probe | 900 s (0 disables) | `fan.ts:44` |
| depth cap `AVO_FAN_DEPTH` | 3 | `fan.ts:41` |
| probe model | `$AVO_PROBE_MODEL` | `fan.ts:37-38`, `167` |
| concurrency | `max(1, min(8, cpus − 2))` | `score.ts:291-293` |

### 3.3 The run

`runFan` (`fan.ts:542-634`) then `executeProbes` (`fan.ts:653-711`):

1. Read prompt; run `checkGuards` (`fan.ts:557-559`).
2. Resolve the agent (same rule as `avo run`, `fan.ts:566-580`).
3. `baseline = git rev-parse HEAD` (`fan.ts:582-586`).
4. Warn if the root tree is dirty, because probes branch from HEAD and will not see uncommitted
   work (`fan.ts:591-603`). avo's own trajectory paths are filtered out first.
5. Write the manifest with every probe `pending` (`fan.ts:605-625`).
6. **Create worktrees serially** (`addWorktrees`, `fan.ts:636-651`):
   `git worktree add --detach .avo/worktrees/<run>/<i> <baseline>`. Serial because "concurrent
   `git worktree add` calls race on the same `.git/worktrees` lock". Detached because "8 probes
   should not leave 8 branches".
7. **Run probes** with bounded concurrency (`fan.ts:677-684`):
   ```ts
   const todo = manifest.probes.filter((p) => p.status !== "done");
   await mapLimit(todo, cap, async (probe) => {
     const result = await runProbe(ctx, probe);
     probe.status = "done";
     probe.result = result;
     // After every probe: a kill must leave finished work recoverable.
     writeManifest(opts.cwd, manifest);
   });
   ```
   `mapLimit` is a simple worker pool (`score.ts:277-289`). Probes beyond the cap queue.
8. **Each probe** (`runProbe`, `fan.ts:465-518`): `driveAgent` in the worktree with the **same**
   prompt; then `runScore` in the worktree with `record: false` (`fan.ts:485-500`), so probe scores
   never enter the root attempt log the supervisor reads; then a diffstat against the baseline
   commit (`diffstatOf`, `fan.ts:351-367`, which uses `git add -A -N` + `git diff --numstat` to see
   committed, staged, unstaged and untracked changes). A probe is scored "even when the agent
   failed: a half-finished edit passing `f` is a real result" (`fan.ts:483`).
9. **Cleanup** (`cleanupUntouched`, `fan.ts:713-734`): remove worktrees with zero changed files
   (unless `--keep`), then `git worktree prune`. Changed worktrees stay: "Changed ones stay until
   `--clean`: only copy."

Diversity comes from sampling, not from different prompts (`.agents/skills/avo-fanout/SKILL.md:58-60`):

> The prompt goes to **every** probe identically. Diversity comes from sampling, not from N different
> prompts — so write a prompt that names the *problem* and invites a direction, not one that dictates
> the edit.

### 3.4 The four guards

`checkGuards` (`fan.ts:286-319`) and `probeEnv` (`fan.ts:322-330`). State travels in environment
variables, "the only channel surviving `spawn` into an arbitrary agent binary" (`fan.ts:284`).

| Guard | Mechanism |
| --- | --- |
| Depth | refuse if `AVO_FAN_LEVEL ≥ AVO_FAN_DEPTH`; child gets `LEVEL + 1` |
| Cycle | refuse if `sha256(prompt)[:12]` is already in `AVO_FAN_CHAIN`; child gets chain + sha |
| Concurrency | `min(8, cpus − 2)` |
| Timeout | per-probe; the whole process group is killed |

A guard refusal is exit 1, not 2 (`fan.ts:1060-1061`): "A guard is a refusal, not a harness
failure." `avo run` shares this budget (`run.ts:483-487`, `iterate` at `578-579`), so a turn of
`avo run` that calls `avo fan` is one level deeper.

### 3.5 Selection and promotion

**The harness selects a hint, not a winner.** `bestProbe` (`fan.ts:525-534`):

```ts
for (const r of results) {
  const n = r.score?.pass === true ? r.score.normalized : null;
  if (n === null) continue;
  const cur = best?.score?.normalized ?? null;
  if (cur === null || n > cur) best = r;
}
return best?.i ?? null;
```

`normalized` is `primary` when higher is better and `−primary` otherwise (`score.ts:348`). As math,
for probes `i = 1..N` with candidate `x_i`:

```
ν(x) = primary(x)    if higher_is_better
       −primary(x)   otherwise
I    = { i : pass(x_i) ∧ ν(x_i) ≠ null }
î    = argmax_{i ∈ I} ν(x_i)       (smallest i on ties, since the test is strict >)
î    = null                         if I = ∅
```

`pass(x) = ok(x) ∧ correct(x)`. The field doc (`fan.ts:105`): "Index of the best *passing* probe, or
`null` when none scored. A hint, never a decision."

**Promotion is manual** (`promote`, `fan.ts:822-901`):

> Brings one probe's work into the *root* tree and stops. No score, no commit, no deletion of the
> others: `avo commit` is the only writer (invariant 1), promotion the separate step (invariant 7).

Steps: write `git diff --binary <baseline>` from the worktree to
`.avo/worktrees/<run>/promote-<i>.patch` **before** applying it; `git apply`; on failure
`git apply --3way` with a warning to check for conflict markers; warn if HEAD moved since the
fan-out.

**How a probe reaches the lineage.** Only through the root tree and `avo commit`. The full path is
`avo fan` → (agent or operator picks `i`, usually `î`) → `avo fan --promote i` → `avo score` →
`avo commit --why "…"`. The skill says to promote **at most one** probe per step, because "Two
probes' diffs stacked together is a candidate neither of them measured"
(`.agents/skills/avo-fanout/SKILL.md:94-96`).

So the full selection, combining fan-out with the commit rule `C` (`compareVectors`,
`src/compare.ts:91`; default `reduce: "dominate"`, `floor: 0`, `config.ts:78-85`):

```
x_{t+1} = promote(x_î)                        if î ≠ null ∧ C(promote(x_î), x_t) = commit
x_{t+1} = x_t  (no new version)               otherwise

C(x, b) = commit  ⇔  pass(x)
                   ∧ configs(b) ⊆ configs(x)
                   ∧ ∀c ∈ configs(b): δ_c ≥ −φ
                   ∧ ∃c ∈ configs(b): δ_c > φ
δ_c = (ν_c(x) − ν_c(b)) / |ν_c(b)|            (relDelta, compare.ts:35-40)
```

Here `φ` is the symmetric relative noise floor. Note that `C` re-scores in the root tree; the probe
score is never trusted for the commit. The skill rule: "Never promote a probe you have not scored in
the real tree" (`SKILL.md:138-139`).

### 3.6 Resume, list, clean

- `--resume <run-id>` (`resumeFan`, `fan.ts:779-803`): re-checks guards, re-adds missing worktrees
  (idempotent), re-runs only probes with `status !== "done"`.
- `--list` (`fan.ts:1006-1027`): runs, probe counts, unfinished probes.
- `--clean <id|all>` (`cleanRuns`, `fan.ts:919-945`): `git worktree remove --force` (with `rm -rf`
  fallback), delete the run dir, `git worktree prune`.

### 3.7 Probe result

`ProbeResult` (`fan.ts:69-90`): `i, ok, score{pass, primary, normalized, unit, higher_is_better,
scores, errors}, diffstat, summary, worktree, tokens, cost_usd, wall_s, exit_code, timed_out,
log_path, truncated, error`. `ok` describes the **process**, not the candidate (`fan.ts:72`).

---

## 4. Agent adapters

### 4.1 One turn, three agents

`driveAgent` (`src/agents.ts:389-436`) is shared by `avo run` and `avo fan` "so both report a
timeout, a crash and a missing binary in the same words" (`agents.ts:386-387`). It spawns the
template, writes the raw log, parses the output, and classifies the end as spawn failure, timeout,
non-zero exit, or ok.

Templates (`agents.ts:66-114`). Every flag was "read off the real binaries (pi 0.84.3, claude
2.1.241, codex-cli 0.147.0)" because "a wrong flag fails silently" (`agents.ts:5-8`).

| Agent | Command line | Approval / sandbox | Output parsed |
| --- | --- | --- | --- |
| pi | `pi --mode json --print --approve [--model M] -- <prompt>` | `--approve`: trusts project-local `.agents/skills/` and `.pi/settings.json`; "headless pi never shows the project-trust dialog" | `message_end` (final message, usage, cost) and `message_update` |
| claude | `claude --print --output-format stream-json --verbose --permission-mode bypassPermissions [--model M] -- <prompt>` | "in print mode a permission prompt is an auto-denial" | one `{"type":"result"}` line: `result`, `usage`, `total_cost_usd` |
| codex | `codex exec --json --skip-git-repo-check --sandbox workspace-write [--model M] -- <prompt>` | writes confined to the cwd; "`avo commit` inside a codex probe is blocked, and promotion is the path" | `item.completed` (`agent_message`) and `turn.completed` (usage); no cost |
| custom | from `.avo/config.json`, `{prompt}` / `{model}` substituted | "the template author's responsibility" | `text`: last line |

`--` (`END_OPTS`, `agents.ts:62`) ends option parsing so a prompt that starts with `-` is not a flag.

**Token normalization** (`tokensFrom`, `agents.ts:182-212`). The four counts are made disjoint:
`input` (uncached), `output`, `cache_read`, `cache_write`. Codex follows OpenAI, where
`cached_input_tokens` is a subset of `input_tokens`, so it is subtracted. The comment cites the bug
that forced this: "the S9b-1 run recorded 24 input tokens for a turn that sent 573,313, because
523,326 were a cache read (#43)".

**Summary fallback** (`parseAgentOutput`, `agents.ts:267-326`). Final message first, then the last
streamed message, then the last prose line. A JSON protocol line is never used as a rationale
(`lastProseLine`, `agents.ts:248-253`; issue #49).

### 4.2 Skill wiring per agent

From `docs/agents.md:35-39`:

| Agent | How it finds the skills |
| --- | --- |
| pi | native discovery of `.agents/skills/`; `.pi/settings.json` gets `defaultTools` (incl. `bash`) and `enableSkillCommands`; `.pi/extensions/{avo,avo-supervisor}` are symlinked |
| claude | `.claude/skills` → `.agents/skills`, one directory symlink |
| codex | the `AGENTS.md` skills index ("Codex has no skill-discovery mechanism; naming the files *is* the wiring") |

### 4.3 The `avo` pi extension — six native tools

`pi/extensions/avo/index.ts:17-19` registers `avoTools()`. `tools.ts:64-71`:

```ts
export const AVO_TOOL_NAMES = [
  "avo_score", "avo_commit", "avo_lineage", "avo_know_query", "avo_know_add", "avo_fan",
] as const;
```

| Tool | Wraps | Notes |
| --- | --- | --- |
| `avo_score` (`tools.ts:95`) | `runScore` | sequential; records the attempt by default |
| `avo_commit` (`tools.ts:151`) | `decideCommit` | sequential; `why` is **required** (`tools.ts:185`) while the CLI `--why` is optional |
| `avo_lineage` (`tools.ts:217`) | `readLineage`, `bestVersion` | read-only |
| `avo_know_query` (`tools.ts:261`) | `knowQuery` | read-only |
| `avo_know_add` (`tools.ts:300`) | `knowAdd` | local paths confined to the repo (`confineToRepo`, `tools.ts:346`) |
| `avo_fan` (`tools.ts:359`) | `parseFanArgs` + `runFan` | built through the CLI parser so env defaults match (`tools.ts:385-393`) |

Design rules (`tools.ts:1-19`, `docs/agents.md:76-86`):

- **Thin.** "nothing here decides anything: the commit rule is `decideCommit`, the `f` contract
  `runScore`, the guards `runFan`."
- **A refusal is not an error.** Only a harness error throws (`harnessError`, `tools.ts:87`), since
  pi marks `isError` only on throw. A refused commit is a normal result.
- **`content` = CLI's own renderer; `details` = structured result,** because pi rebuilds extension
  state from `details` when a session branches.
- **No tool takes a `cwd`** (`repoOf`, `tools.ts:79`): "an agent that can retarget the repo can write
  a version into a repo nobody is watching."

### 4.4 The `avo-supervisor` pi extension

`pi/extensions/avo-supervisor/supervisor.ts`. The header contrasts it with `avo run`
(`supervisor.ts:4-8`):

> `avo run` supervises by polling — turn, `avo commit`, `avo supervise`, splice the directive into
> the next prompt. That works for any agent (invariant 9) at a process per check. Pi does better:
> `tool_result` fires the moment `avo_score` or `avo_commit` finishes ... and `pi.sendMessage`
> injects without restarting anything.

Behavior of `installSupervisor` (`supervisor.ts:168-238`):

1. **Watched tools:** only `avo_score` and `avo_commit` (`SUPERVISED_TOOLS`, `supervisor.ts:42`).
   `avo_fan` is excluded because it scores with `record: false`.
2. On a watched `tool_result` (`supervisor.ts:193`): announce a new best with `ctx.ui.notify`; call
   the **same** `supervise()` with `stall: null, thrash: null` so config decides
   (`supervisor.ts:204`); update the footer, e.g. `v12 · 1668 TFLOPS · 3 since best`
   (`statusLine`, `supervisor.ts:148-155`).
3. **One episode, one directive.** `episodeKeys` (`supervisor.ts:139-145`):
   ```ts
   s.kind === "stall"
     ? `stall@${state.best === null ? "none" : state.best.sha}@${state.analyzed - state.since_best}`
     : `thrash@${state.signature ?? ""}@${state.analyzed - state.failing_streak}`
   ```
   If every key was already answered, do nothing (`supervisor.ts:215`). So "5 attempts since best"
   and "6 attempts since best" are one episode. A new best version, or a thrash during a stall, is
   a new episode. The anchor uses `analyzed`, not `attempts`, so it does not creep past the
   1,000-record window.
4. Record an `intervention` memory keyed by the episode (`recordIntervention`,
   `supervisor.ts:81-109`).
5. **Inject** (`supervisor.ts:236`):
   ```ts
   pi.sendMessage({ customType: SUPERVISOR_MESSAGE_TYPE, content: s.directive, display: true, details },
                  { deliverAs: "steer" });
   ```
   `triggerTurn` is not set: "the supervisor answers a turn the agent started, it does not start its
   own" (`supervisor.ts:233-235`).
6. **Branch-safe state.** On `session_start`, rebuild the answered set from injected messages on the
   current branch via `ctx.sessionManager.getBranch()` (`supervisor.ts:177-186`), never
   `getEntries()`. A branch that never saw a directive gets one.
7. **Degrade, never crash.** A throwing `supervise()` or memory write costs one warning
   (`supervisor.ts:205-209`, `219-224`). `session_shutdown` stops late steering (`supervisor.ts:188-191`).

It counts the attempt log, not the session (`supervisor.ts:12-13`): "Two drifting counters would
steer one stall twice."

The original sketch in `docs/avo-pi.md:77-109` kept an in-memory `attemptsSinceImprovement` counter
with a fixed threshold of 5 and a canned steer string. The shipped extension replaces all three:
state from disk, threshold from config, directive with citations. The sketch also warns against
sub-agent extensions (`docs/avo-pi.md:111-114`): "**Do not attempt this.** ... these extensions do
not work well enough." That is why `avo fan` uses OS processes and worktrees.

### 4.5 Tests for this layer

- `test/agents.test.ts` (283 lines): every template flag; token and cost parsing for all three
  formats; salvage of killed streams.
- `test/run.test.ts` (650 lines): prompt carry-over, directive injection, #42 self-commits, #49
  silent turns, STOP, no-progress, timeout, guards, crash-safe manifest.
- `test/supervise.test.ts` (493 lines): each threshold "at its exact firing point", e.g. line 81
  "the stall fires at exactly N attempts since the best version, not before"; signature noise;
  citation order; cap; no self-citation (line 470).
- `test/fan.test.ts` (563 lines): guards, parallel worktrees, cleanup back to baseline, promote,
  timeout, resume, self-perturbation (line 542).
- `test/pi-tools.test.ts`, `test/pi-supervisor.test.ts`: tool registration, refusal-vs-throw,
  no-`cwd` rule; "a scripted stalling sequence injects the steering directive EXACTLY ONCE" (line 243).
- `test/pi-supervise-drive.ts`: drives the supervisor through pi's real `DefaultResourceLoader`,
  `ExtensionRunner`, `SessionManager.inMemory()` and `emitToolResult`. "What is scripted is the
  *model*, not the harness" (lines 6-7).
- `test/e2e-run.sh` (12 sections), `test/e2e-fan.sh` (8), `test/e2e-supervise.sh` (9): real
  `bin/avo`, real git, real scorer, **stub agent** ("CI has none, and a real one would make this
  suite non-deterministic and expensive", `e2e-run.sh:3-4`). Evidence in `evidence/s6-e2e.txt`,
  `s7-e2e.txt`, `s7b-e2e.txt`, `s8-e2e.txt`.

---

## 5. The meta loop ("ralph")

`docs/meta-loop.md:1-14`:

> avocode is built by the loop it implements. The one that *builds* this repo is `ralph` — it was
> `ralph.sh` here until it earned its own repo, and it was never part of `avo` itself.
> ...
> It re-invokes a coding agent with `PROMPT.md` forever. The agent has **no memory** between runs —
> all continuity lives in the repo.

### 5.1 `PROMPT.md`

The prompt the meta loop gives the agent, every cycle (`PROMPT.md:7`):

> **Each run: do one coherent unit of work, prove it, commit it, hand off, exit.** The loop restarts you.

The cycle (`PROMPT.md:9-24`): orient (`git diff @`, `PLAN.md`, `tail -n 1 PROGRESS.jsonl`) → health
check (lint + typecheck + tests) → pick one task by a fixed priority ("broken `main` →
security/data-loss → bug in the core path → next unbuilt slice in `PLAN.md` → ...") → do it → verify
for real with evidence in `evidence/` → commit, PR → hand off (update `PLAN.md`, append one line to
`PROGRESS.jsonl`). Escape hatch: `touch RALPH_STOP` (`PROMPT.md:32-33`).

### 5.2 The continuity files

| File | Role (`docs/meta-loop.md:16-21`) |
| --- | --- |
| `PLAN.md` | slice order, invariants, open questions. Read first, every cycle |
| `PROGRESS.jsonl` | one line per iteration: `{iter, date, task, done[], verification, next, blocker?}`. Its last `next` is the default task |
| `evidence/` | what each iteration proved (21 files) |
| git + GitHub Issues | everything else |

`PROGRESS.jsonl` has 19 iterations over two days (2026-08-24 to 2026-08-25):

| iter | task |
| --- | --- |
| 1–6 | S0 skeleton; S1 `f`; S2 `P_t`; S3 memory; S4 `K`; S5 skills |
| 7 | S6 `avo fan` |
| 8 | S7a `avo supervise` |
| 9 | S7b `avo run` |
| 10 | S8a native pi tools |
| 11 | ralph: interrupt handling |
| 12 | S8b pi supervisor extension |
| 13 | S9a `bench/fuzzysearch` target |
| 14 | S9b-1 first real curve (`avo run --agent claude`) |
| 15–17 | fixes #42, #43, #2 |
| 18 | S9b-2a resumed lineage to v7 |
| 19 | fix #49 |

### 5.3 The structural parallel (inference, supported by the docs)

ralph and `avo run` have the same shape. Both re-invoke a memory-less agent; both keep all state in
the repo; both have a file-based stop (`RALPH_STOP` vs `.avo/STOP`); both make the agent "read the
past" first (`PLAN.md` + `PROGRESS.jsonl` vs `avo lineage` + `avo mem prime`). The difference is
the fitness signal. ralph's gate is "lint + typecheck + tests green" plus human-readable evidence.
`avo run`'s gate is a numeric `f` and the commit rule. Several `avo run` design points came from
running ralph: interrupt handling (iter 11, issue #33 — "two agents once ended up committing to one
checkout here", `docs/meta-loop.md:25-28`), and the handoff trap about `fixes #N` keywords
(`docs/meta-loop.md:30-35`).

### 5.4 Real `avo run` results recorded by the meta loop

S9b-1 (`PLAN.md:489-516`), `avo run --agent claude` on `bench/fuzzysearch`: 6 of 12 iterations,
34m 43s, **4** versions, 1 refusal, 1810.4 ms → 0.345 ms (5255×), **0** interventions.

S9b-2a (`PLAN.md:557-571`), resumed the same lineage: 3 iterations, 30m 41s, v5–v7,
1810.37 ms → 0.231 ms (7837×), **0** interventions, $8.19 = $2.73 per turn.

Bugs found only by real runs: #42 (agent self-commits not credited), #43 (cached tokens dropped and
the head-only output cap lost the final `result` event), #49 (a protocol event written as a
rationale), #41 (`avo` not on the target's `PATH`).

---

## 6. Pseudocode for an `algorithm` environment

Symbols: `P` lineage, `A` attempt log, `M` memory, `K` knowledge, `f` scorer, `C` commit rule,
`N` stall threshold, `R` thrash threshold, `T` max iterations, `τ` per-turn timeout.

```
Algorithm 1  avocode: AVO(P_0, K, f)
Input: repo with seed commit x_0, prompt π, agent α, thresholds N, R, budget T, timeout τ
──────────────────────────────────────────────────────────────────────────────
 1: CheckGuards(π)                                ▷ depth < D, sha(π) ∉ chain
 2: d ← ⊥; prev ← ⊥; idle ← 0
 3: for t = 1 … T do
 4:     if exists(.avo/STOP) then return "stop-file"
 5:     h₀ ← HEAD
 6:     p ← TurnPrompt(π, t, prev, d)             ▷ π verbatim at t=1; + outcome + d later
 7:     (ok, summary) ← DriveAgent(α, p, τ)       ▷ fresh process = Vary(P_t, K, f)
 8:     if spawn failed then return "agent-unavailable"
 9:     dec ← Commit(summary)                     ▷ Algorithm 2, on whatever the agent left
10:     h₁ ← HEAD
11:     idle ← (dec = noop ∧ h₁ = h₀) ? idle + 1 : 0
12:     (sig, d) ← Supervise(P, A, M, K, N, R)    ▷ Algorithm 3
13:     if sig ≠ ∅ then M ← M ∪ {intervention(t, sig, d)}
14:     WriteManifest(t)                          ▷ crash safety, every iteration
15:     prev ← (dec, versions in h₀..h₁, sig)
16:     if idle ≥ 3 then return "no-progress"
17: return "max-iters"

Algorithm 2  Commit(why)                          ▷ the only writer of P
 1: if tree clean (ignoring trajectory) then return noop
 2: x ← working tree;  a ← f(x);  A ← A ∪ {a}
 3: b ← last(P)                                   ▷ P monotone ⇒ newest is best
 4: if ¬pass(a) then M ← M ∪ {dead end}; return refused
 5: if b = ⊥ ∨ C(a, b) then
 6:     P ← P ∪ {(x, a, why)}                     ▷ git commit + trailers + notes + lineage/vNNN.md
 7:     return committed
 8: M ← M ∪ {dead end}; return refused

Algorithm 3  Supervise(P, A, M, K, N, R)
 1: A' ← last 1000 of A;  b ← last(P)
 2: s ← |{a ∈ A' : head(a) = sha(b) ∨ ts(a) ≥ date(b) + 1s}|
 3: r ← length of longest suffix of A' with equal non-null signature σ
 4: sig ← {stall | s ≥ N ∧ s > 0} ∪ {thrash | r ≥ R}
 5: if sig = ∅ then return (∅, ⊥)
 6: V ← newest 3 versions of P with score and why
 7: F ← up to 5 memories, failures before insights, no interventions
 8: U ← up to 3 docs d ∈ K with 2·|terms(d) ∩ corpus(P, M)| < |terms(d)|
 9: steps ← thrash ∈ sig ? THRASH_STEPS : STALL_STEPS
10: return (sig, Render(sig, V, F, U, steps))     ▷ ≤ 4000 chars

Algorithm 4  Fan(π', n, α, m_small)               ▷ called by the agent inside line 7
 1: CheckGuards(π');  x_b ← HEAD
 2: create n detached worktrees W_1..W_n at x_b   ▷ serially
 3: parallel for i = 1..n with at most min(8, cpus−2) at once do
 4:     DriveAgent(α, π', τ) in W_i on model m_small   ▷ env: level+1, chain+sha(π')
 5:     a_i ← f(W_i) without recording;  Δ_i ← diffstat(W_i, x_b)
 6:     WriteManifest(i)
 7: remove W_i with Δ_i = ∅
 8: î ← argmax_{i : pass(a_i)} ν(a_i)            ▷ a hint only
 9: return results, î
    ── later, by the agent/operator ──
10: Promote(j): apply diff(W_j, x_b) to root tree (3-way fallback); then Commit(why)
```

For the article's LaTeX: Algorithm 1 is the outer loop, Algorithm 4 runs *inside* a variation step
(the agent decides when to call it), and Algorithm 3 is the supervisor. In the pi variant,
Algorithm 3 runs after every `avo_score` / `avo_commit` tool result inside the session, and its
directive is delivered mid-turn as a "steer" message, deduplicated by episode key.

---

## 7. Design choices compared with the paper

| Topic | Paper | avocode | Where |
| --- | --- | --- | --- |
| Population | "single-lineage continuous instantiation, leaving population-level branching and archive management to future extensions" (`avo-paper.md:47`) | same: single monotone lineage. Population branching is S10, "deferred, not scheduled" | `PLAN.md:621-623` |
| Parallel exploration | not described | `avo fan`: short-lived parallel probes from one parent; only one can be promoted into the single lineage. A local, ephemeral population, not an archive | `fan.ts`, `SKILL.md:94-96` |
| Commit rule | "passes correctness checks and matches or improves the benchmark score" (`avo-paper.md:43`) | vector rule, dominate-or-tie: `≥` on every shared config, `>` on one, symmetric noise floor; missing configs block. A pure tie does not commit | `compare.ts:91`, `architecture.md:135-152` |
| Supervisor | a supervisor that "reviews the overall evolutionary trajectory and steers" | deterministic detector (stall, thrash) and a cited template; no LLM call; threshold configurable (default 5, paper unpublished) | `supervise.ts`, `PLAN.md:660-665` |
| Steering delivery | not specified | two paths: between processes (`avo run`, any agent) and in-session (`avo-supervisor`, pi only) | `run.ts:678-685`, `supervisor.ts:236` |
| Agent | one internal agent | agent-agnostic: pi, Claude Code, Codex, or a custom template; skills are "the product" (invariant 9) | `agents.ts:66-142`, `architecture.md:184` |
| Agent continuity | one long agent session with "persistent memory" | one fresh process per turn; continuity only through `P_t`, attempt log, memory, prompt | `run.ts:5-8`, `313-334` |
| Model size | one model | "exploration is a small-model job, exploitation is a big-model job": probes on `AVO_PROBE_MODEL`, `avo run` on the agent default | `SKILL.md:35-41`, `run.ts:193` |
| Lineage store | "persisted as a git commit along with its score" | git commits with `Avo-Version` / `Avo-Score` trailers, `git notes --ref=avo`, `lineage/vNNN.md` | `architecture.md:154-163` |
| Trajectory | "unsuccessful intermediate attempts remain part of the agent's internal search trajectory" | made explicit and on disk: `.avo/attempts.jsonl`, `.avo/runs/`, `.avo/worktrees/`, all gitignored; the supervisor reads it | `architecture.md:154-163` |
| Interventions | supervisor "intervening during periods of stagnation" | every intervention recorded as a memory and in the run manifest, so a run can be audited | `run.ts:411-437`, `PLAN.md:308-312` |
| Scale | 7 days, 40 versions | longest recorded runs ~35 min each, 7 versions total, 0 interventions; the converged regime that would exercise the supervisor is not reached yet | `PLAN.md:489-619` |
| Sub-agents | n/a | OS processes + worktrees, not in-process sub-agents ("Do not attempt this") | `avo-pi.md:111-114`, `PLAN.md:59-74` |
| Recursion safety | n/a | depth cap 3 and prompt-hash cycle check shared by `avo fan` and `avo run` | `fan.ts:286-330` |

Points worth stating in the article:

1. **The harness never ranks ideas, only measurements.** The supervisor counts attempts and matches
   error signatures; idea novelty is left to the agent, which is given the evidence (prior
   versions, dead ends, unread docs) to judge it.
2. **`avo fan` returns a hint, not a choice.** Selection is `argmax` over passing probes, but the
   decision is the agent's and the commit rule re-measures in the root tree. This keeps
   invariant 1: `avo commit` is the only writer.
3. **The supervisor's thresholds are not tuned.** The real runs never stalled, so the default of 5
   is the sketch's value, not a measured one (`PLAN.md:660-665`).
4. **The loop has no cost or wall-clock budget** (#28). Only iteration count, per-turn timeout,
   `.avo/STOP`, and the 3-idle-turn stop bound it.
