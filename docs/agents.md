# Agents: the agent-agnostic layer

avocode drives any coding agent. Nothing in the loop is specific to one — that is invariant 9:
*if a workflow only works in Pi, it is unfinished.*

The layer has two halves. The **skills** (`avo install`) are the portable one, and they are the
product. The **native pi extensions** are bindings on top: the same commands, one process closer.
Everything they do is reachable from `bash avo ...` in any agent (invariant 8).

---

## `avo install` — wiring the skills in

The skills are the layer that makes `avo` agent-agnostic. They live in `.agents/skills/`, the
[Agent Skills](https://agentskills.io/specification) shared location, and `avo install` wires each
agent's discovery to them **without copying** — one source of truth, no drift.

```bash
avo install                        # all three agents (the default)
avo install --agent pi             # or one; repeatable, and --agent pi,codex works too
avo install --agent all --json
avo install --force                # replace a symlink or file in the way
```

| Skill | Read it when |
| --- | --- |
| `avo-vary` | performing one variation step: read the past, change the code, score it, commit it |
| `avo-score` | authoring or repairing `.avo/score`; the frozen `f` contract |
| `avo-lineage` | reading `P_t`, or understanding why a candidate was refused |
| `avo-knowledge` | searching `K` and growing it from the web |
| `avo-fanout` | exploring several directions at once when reading cannot tell you which is best |

What each agent gets:

| Agent | Wiring | Why |
| --- | --- | --- |
| pi | project `.agents/skills/` is discovered natively, so only two things are wired: `.pi/settings.json` gets `defaultTools` (including `bash`) and `enableSkillCommands`, and `.pi/extensions/{avo,avo-supervisor}` are linked at the native tools and the in-session supervisor | `avo`, `bd` and `qmd` are CLIs; an agent without `bash` cannot drive any of them. The extension is a shortcut past `bash`, not a capability the others lack |
| claude | `.claude/skills` → `.agents/skills`, one directory symlink | a skill added later needs no re-install |
| codex | the `AGENTS.md` skills index | Codex has no skill-discovery mechanism; naming the files *is* the wiring |

`AGENTS.md` is written for every agent, not just Codex: it carries the rules that hold whether or
not a skill was loaded (`avo commit` is the only writer of a version; measure before you claim;
`bd` for task state, never markdown TODO lists). Only the block between
`<!-- BEGIN avo -->` and `<!-- END avo -->` belongs to `avo install` — anything you write outside it
survives every re-run, and an `AGENTS.md` that already exists is appended to, never rewritten.

**One trap worth knowing:** pi ignores project-local skills and settings until the project is
trusted, and headless runs (`-p`, `--mode json`) never prompt. Pass `--approve`, run `pi` once
interactively and answer the prompt, or set `defaultProjectTrust: "always"` in
`~/.pi/agent/settings.json` — otherwise an installed harness silently does nothing in exactly the
mode `avo fan` will drive it in. `avo install` says so every time it wires pi.

`avo install` never deletes anything. A real directory in the way is reported and left alone: an
existing `.claude/skills` full of your own skills gets avo's linked *inside* it instead. A symlink
or file in the way needs `--force`.

## The native `pi` extensions — the same commands, one process closer

Every capability is reachable from `bash` first (invariant 8); the extensions are *bindings*, not new
behaviour. `avo install --agent pi` links `.pi/extensions/avo` and `.pi/extensions/avo-supervisor`
at avocode's `pi/extensions/`, which is where pi discovers a project-local extension. Two, not one,
because they are useful apart: the tools without the supervisor is a session that steers itself, and
an operator already running `avo run` wants exactly that.

A pi session in that repo gets six tools:

| Tool | Wraps | Notes |
| --- | --- | --- |
| `avo_score` | `avo score` | measures the working tree; records the attempt the supervisor reads |
| `avo_commit` | `avo commit` | the only writer of a version. `why` is **required** here |
| `avo_lineage` | `avo lineage` / `avo best` | the table, or one version in full with its rationale |
| `avo_know_query` | `avo know query` | hybrid search over `K` and the rendered lineage |
| `avo_know_add` | `avo know add` | ingest a URL or file into `K` with provenance |
| `avo_fan` | `avo fan` | N worktrees, N small-model probes, each scored |

Three rules the tools follow, each for a reason worth keeping:

- **A refusal is not an error.** Pi flags a tool result as failed only when `execute` throws, so
  only a *harness* error throws — no scorer, malformed output, a guard refusal. `avo_commit`
  declining a candidate comes back as an ordinary result, because it is a measurement the model is
  meant to read and act on. Same split as the CLI's exit codes (2 = harness error, 1 = refused).
- **`details` is always populated.** Pi rebuilds extension state from tool-result details when a
  session branches, so every tool returns the CLI's structured result there and the CLI's own
  rendering in `content` — the model reads exactly what a human reads.
- **The repo comes from the session, never from the model.** No tool takes a `cwd`: an agent that
  can retarget the repo can write a version into a repo nobody is watching.

### `avo-supervisor` — S7's steering, inside the session

`avo run` supervises by polling: turn, `avo commit`, `avo supervise`, splice the directive into the
next prompt. That works for any agent and costs a process per check. The supervisor extension does
the same thing natively — it subscribes to `tool_result`, and on `avo_score` or `avo_commit` (the
only two that can move a counter; `avo_fan` scores in disposable worktrees) it calls the same
`supervise()` the CLI calls and injects the directive with `pi.sendMessage`. A live footer reads
`v12 · 1668 TFLOPS · 3 since best`, and a landed version is announced.

- **It counts the attempt log, not the session.** State comes from `.avo/attempts.jsonl` and the git
  lineage every time, so an operator running `avo run` in one terminal and `pi` in another cannot be
  steered twice for one stall by two counters that drifted.
- **One episode, one directive.** A stall is named by the best version it is stuck under; a thrash by
  its failure signature and where the streak began. Re-injecting the same advice on every attempt
  burns context and teaches the model to skim the one message meant to change its mind. A *new* best,
  or a thrash appearing during a stall, is new information and does steer.
- **A branch that never saw the directive still gets one.** The answered episodes are reconstructed
  from the injected messages on the current branch, so branching rewinds the supervisor with the
  conversation.
- **It re-implements nothing.** No commit rule, no thresholds, no directive text: `.avo/config.json`
  decides `stall` and `thrash` exactly as it does for the CLI. Every steer is also written down as an
  intervention memory, the same record `avo run` leaves.

The same trust rule applies as for skills — pi ignores a project-local extension until the project
is trusted, and headless runs never prompt. `--approve` or `defaultProjectTrust: "always"`.

Nothing is lost without it: `claude` and `codex` reach every one of these through `bash avo ...`.

