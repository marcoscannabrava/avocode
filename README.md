# avocode

**Point a coding agent at a number you want to improve. It improves it, and only the improvements
are kept.**

You write one script that measures your code. avocode runs an agent in a loop — change something,
measure it, keep it only if it is genuinely better, and notice when the agent starts going in
circles.

| | Jump to |
| --- | --- |
| 🧠 | [What is this?](#what-is-this) |
| 📦 | [Install](#install-2-minutes) |
| 🚀 | [Quickstart](#quickstart-5-minutes) |
| 🔧 | [The commands](#the-commands) |
| 🗺️ | [How the code is structured](#how-the-code-is-structured) |
| ✅ | [Run the tests](#run-the-tests) |
| 📚 | [Docs](#docs) |

---

## What is this?

An [AVO](docs/avo-paper.md)-inspired agent harness. AVO replaces the classical evolutionary
variation operator with an autonomous coding agent — `Vary(P_t) = Agent(P_t, K, f)`. avocode
extracts that harness and makes it general and **agent-agnostic** (pi, Claude Code, Codex — all
three, from the same skills).

**The four pieces:**

| | | avocode's version |
| --- | --- | --- |
| `f` | what "better" means | `.avo/score`, an executable printing one JSON line |
| `P_t` | the versions that survived | git commits with score trailers — a monotone lineage |
| `K` | what the agent may consult first | `knowledge/` + the repo's own history, semantically searchable |
| Agent | the thing that changes the code | any coding agent, driven by five portable skills |

**The loop:**

```
agent changes the code  →  avo score  →  avo commit  →  avo supervise  →  repeat
                           measure it     keep it ONLY     stuck? cite the
                                          if it's better   past and steer
```

**Why it is not just a for-loop around an agent:**

- 🔒 **A regression can never land.** `avo commit` compares the whole score *vector*: a big win on
  one config cannot pay for a loss on another, and you cannot improve by measuring less.
- 📉 **A stalling agent is caught from outside.** From inside one turn, re-deriving an old idea
  looks exactly like progress. `avo supervise` reads the lineage and says otherwise — citing the
  actual prior versions and the docs nobody has read.
- 🧾 **Every dead end is written down.** A refusal you do not record is a refusal the next session
  earns again.
- 🌱 **Exploration is cheap.** `avo fan` runs N directions in N throwaway worktrees on a *small*
  model, scores each, and promotes one.

**Does it actually work?** Pointed at [`bench/fuzzysearch`](docs/bench.md), one 35-minute
`avo run --agent claude` committed four versions for a **5255x** speedup — including a technique
the hand-written reference ladder does not contain.

---

## Install (2 minutes)

**Needs:** Node ≥ 22, `git`, `jq`, and at least one coding agent (`pi`, `claude` or `codex`).

```sh
git clone https://github.com/marcoscannabrava/avocode
cd avocode
./install.sh
```

That is the whole thing. It installs dependencies and links `avo` into `~/.local/bin`, then prints
a dependency report. **Re-running it is always safe.**

```sh
avo doctor        # did it work? what's missing?
```

<details>
<summary>Options — different PATH dir, uninstall, PATH not set up</summary>

```sh
./install.sh --bin-dir /usr/local/bin   # or set AVO_BIN_DIR
./install.sh --force                    # replace whatever occupies <bin-dir>/avo
./install.sh --skip-doctor
./install.sh --uninstall                # removes the link; never touches the checkout
```

If `~/.local/bin` is not on your `PATH`, the installer says so and prints the exact line to paste.
Full details, including every optional dependency and what it degrades to:
**[docs/install.md](docs/install.md)**.

</details>

---

## Quickstart (5 minutes)

### 1. Set up the repo you want to make better

```sh
cd /your/repo
avo init                     # .avo/, lineage/, knowledge/ — safe to re-run
avo install                  # wire your agent (pi | claude | codex) to avo's skills
```

### 2. Define what "better" means

This is the only part that is really yours. `.avo/score` runs your benchmark or eval and prints
**one JSON line**:

```sh
avo score --init hyperfine   # scaffold it (or: pytest, vitest) — then edit it
avo score                    # run it
```

```json
{"ok":true,"correct":true,"primary":356.0,"unit":"ms","higher_is_better":false,
 "scores":{"small":155.7,"large":556.4}}
```

`correct` is the gate — a candidate that fails it can never commit, no matter how fast it is.
[Authoring guide →](templates/score/README.md)

### 3. Change something, and let the rule decide

```sh
# ...edit the code...
avo commit --why "hoisted the bounds check out of the loop"
```

```
  scored       8 bytes
  best         v1 (28940fc)
  *            34 -> 8  +76.47%  improved

committed v2 as 219a215 — '*' improved (best: * +76.47%) and nothing regressed
```

Not better? It refuses, and tells you exactly why. Nothing is lost — the refusal becomes a recorded
dead end.

### 4. Read where you are

```sh
avo lineage        # the score curve so far
avo best --json    # what the next candidate must beat
avo mem            # what the loop learned, including the dead ends
```

### 5. Hand the whole loop over

```sh
avo run --prompt-file task.md --max-iters 20 --dry-run   # what it WOULD do; spawns nothing
avo run --prompt-file task.md --max-iters 20             # for real
touch .avo/STOP                                          # the brake, from anywhere
```

Each iteration is: agent turn → `avo commit` → `avo supervise` → inject the directive → repeat, one
fresh process per turn.

---

## The commands

Full reference with every flag and exit code: **[docs/commands.md](docs/commands.md)**.

| Command | What it does |
| --- | --- |
| `avo init` | scaffold `.avo/`, `knowledge/`, `lineage/` in a repo |
| `avo install` | wire pi / claude / codex to avo's skills, without copying them |
| `avo doctor` | dependency and API-key status (presence only — never values) |
| `avo score` | run `f`, validate it, record the attempt |
| `avo commit` | **the only thing that creates a version.** Scores, compares, commits or refuses |
| `avo lineage` / `avo best` | read `P_t` — the curve, one version, a diff between two |
| `avo mem` | insights, versions and dead ends; `avo mem prime` is the session-start context |
| `avo know` | search `K` and grow it — local docs, the repo's own history, and the web |
| `avo fan` | N directions at once: N worktrees, N small-model probes, each scored, one promoted |
| `avo supervise` | is the loop still making progress? Exit 1 means it printed a directive |
| `avo run` | the continuous loop: turn → commit → supervise → steer, repeat |

Every command takes `--json`. Exit codes are consistent: **0** = fine, **1** = ran but
failed/refused, **2** = harness error.

---

## How the code is structured

```
bin/avo        →  src/main.ts  →  src/cli.ts  →  one file per contract
   bash shim        no build step        dispatch
```

| Where | What lives there |
| --- | --- |
| `src/` | the CLI. One file per contract: `score.ts` is `f`, `lineage.ts` is `P_t`, `knowledge.ts` is `K`, `compare.ts` is the commit rule, `fan.ts`/`run.ts`/`supervise.ts` are the loop |
| `.agents/skills/` | **the agent-agnostic layer — the product.** Five portable markdown skills |
| `pi/extensions/` | native pi bindings. Convenience only; everything is reachable from `bash` |
| `templates/score/` | reference scorers + the `f` authoring guide |
| `bench/` | a real optimization target, so the loop can be judged on a curve |
| `test/` | `node:test` unit suites + `e2e-*.sh` scripts that drive the real `bin/avo` |
| `evidence/` | transcripts proving user-facing behavior actually works |
| `PLAN.md` | the slice order, the invariants, the open questions |

**The one distinction to keep in your head:** *lineage* (the versions that survived — git commits)
vs. *trajectory* (how they were reached — `.avo/attempts.jsonl`, worktrees, run logs, all
gitignored). The record of how a version was reached never lands inside the version.

Full map, the `f` contract, the commit rule and the nine invariants:
**[docs/architecture.md](docs/architecture.md)**.

---

## Run the tests

```sh
just check     # lint + typecheck + unit tests  — seconds. Run this first, always.
just e2e       # the end-to-end suites          — minutes. Drives the real bin/avo.
just all       # both
```

No `just`?

```sh
node_modules/.bin/tsx --test test/*.test.ts     # unit tests
node_modules/.bin/tsc --noEmit                  # typecheck
node_modules/.bin/oxlint src test pi bench && ./test/lint-sh.sh   # lint
```

One file while you work on it: `node_modules/.bin/tsx --test test/compare.test.ts`.

What each suite covers, the unskippable shellcheck gate, and CI:
**[docs/testing.md](docs/testing.md)**.

---

## Docs

| | |
| --- | --- |
| [docs/install.md](docs/install.md) | installing, dependencies, PATH, uninstalling |
| [docs/architecture.md](docs/architecture.md) | the design, the code map, the `f` contract, the invariants |
| [docs/commands.md](docs/commands.md) | every command, every flag, every exit code |
| [docs/agents.md](docs/agents.md) | the skills, `avo install`, the native pi extensions |
| [docs/testing.md](docs/testing.md) | test suites, the lint gate, CI |
| [docs/bench.md](docs/bench.md) | the real target, its three correctness gates, the headroom proof |
| [docs/meta-loop.md](docs/meta-loop.md) | how this repo builds itself |
| [PLAN.md](PLAN.md) | slice order, composition decisions, open questions |

---

## Status

Slices **S0–S8 are done**: scoring, lineage, memory, knowledge, agent-agnostic skills, concurrency,
the supervisor and continuous loop, and the native pi implementation. Every command listed above
works, and a pi session in a wired repo additionally gets six native tools plus an in-session
supervisor.

**S9 (end-to-end validation) is in progress.** S9a proved the bench target has real headroom (a
hand-written ladder walks 385x). S9b-1 put `avo run --agent claude` on it: **5255x in 35 minutes**,
four committed versions, `f` verifiably unedited. Next is S9b-2 — the same target under `pi`, to
find out whether the native supervisor earns its complexity.
