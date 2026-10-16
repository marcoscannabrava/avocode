# Plan: Craftax as an avocode bench (`bench/craftax`)

Research date: 2026-10-16. Measurements come from this machine (24 CPUs, 46 GB RAM, no GPU,
`craftax` 1.6.1, `jax` 0.11.2 CPU). Lines marked **(inference)** are my reading, not a source.

## 1. Summary

- Craftax is a 2D survival game in JAX: Minecraft-style crafting on top of a 9-floor dungeon. It
  has 67 achievements worth 226 points. The standard score is "points earned as a % of 226".
- rekursiv.ai pointed LLM "AI scientists" at the RL training recipe. In 3 weeks and 4,805 runs they
  took a 15M-parameter PPO agent from 49% to 73% (and 80% after a boss fine-tune). Each run is about
  11 h on one H100/H200. That loop is far too expensive for avocode on this machine.
- A different shape fits avocode well: the agent writes a **scripted policy** (`src/policy.py`).
  `f` plays fixed procedural worlds on CPU and returns achievement points per world set. A random
  policy scores 0.86%. Public RL scores 18% at 1B steps and 73% at 20B steps. So the headroom is large.
- The game is a tech tree with hard steps (iron, diamonds, the dungeon ladder, darkness, spells).
  Progress comes in jumps with long flat parts between them. This is the shape that fires `stall`.
- On CPU, full Craftax steps at about 1,600 steps/s per process. So a full score is about 1 minute
  on 24 cores. Fixed keys make it bit-identical from run to run.
- **Verdict: good fit.** Build it as fallback B of `PLAN_ARCAGI.md`, or in parallel with it. It has
  better visuals, a natural holdout (new seeds) and a public reference curve.

## 2. What rekursiv / priml did

### 2.1 Sources

- Blog post: <https://rekursiv.ai/blog/craftax/> (2026-10-07; Kondratyuk, Chiu, Lao, Dillon).
- Code: <https://github.com/rekursiv-ai/priml/tree/main/priml/baselines/craftax>, cloned at depth 1
  into the scratch dir. File refs below are relative to that folder.
- Craftax: <https://github.com/MichaelTMatthews/Craftax>, paper <https://arxiv.org/abs/2402.16801>.

### 2.2 What priml is

priml is rekursiv's library of "ML building blocks for training experiments" (`README.md`): models,
optimizers, losses, a train loop, data, and `priml/baselines/<dataset>` pipelines. Each baseline has
`exp000` (a frozen control) and later `expNNN` files. Each one makes one named change on a named
parent, with the hypothesis and results in its docstring (`priml/baselines/__init__.py`). Configs use
`configgle`. Research records go to Trackinizer, their "epistemic knowledge graph".

### 2.3 What was optimized, and by whom

- **What:** the training recipe of a tabula-rasa RL agent. The agent is a MinGRU policy trained with
  PPO and Muon. The game is PufferLib's C port of Craftax (rules differ a little from JAX Craftax;
  see `docs/differences.md`).
- **By whom:** LLM agents ("AI scientists"). Each one had its own copy of the code and GPU access.
  Each question, run and verdict went to Trackinizer. People "set the goal and the rules and
  suggested some training settings" (blog). The blog's "plot twist" is that GPT-6 Astra was one of
  those AI scientists.
- **The port:** `game/` is the game in Numba on CPU, bit-identical to PufferLib's C. Policy and
  learner are torch + Triton in CUDA graphs. Training runs 1.46x faster than PufferLib
  (`README.md` "Speed"). Every run needs CUDA, `exp_smoke` too.

### 2.4 The six changes they found (blog; `experiments.py` `exp002`..`exp004`)

1. A board encoder: a small CNN reads the 9x11 map. Removing it drops 74.1% to 51.1%.
2. An action-effect head: the agent also predicts if an action changes what it sees.
3. Rewards divided by 8, not clipped to [-1, 1].
4. Frontier practice (after Go-Explore): save states at new score levels; restart 20% of training
   games from them.
5. A stall cap: a training game ends 10,000 steps after its last reward.
6. A boss-fight reward for a 3B-step fine-tune: +1 per boss hit, +1.5 per final-floor kill,
   discount 0.9998.

### 2.5 Results (perf = % of 226 points, about 10,000 eval episodes)

| Run | Score | Steps | Time | Source |
| --- | ---: | ---: | --- | --- |
| Random policy (my measurement, 64 episodes) | 0.86% | — | 16 s CPU | §3.2 |
| Craftax_Baselines PPO (`exp010`) | 12.37% | 1B | 50 min, H200 | `README.md` |
| PPO-RNN / PQN / GTrXL (`exp012/13/15`) | 16.7 / 16.3 / 17.4% | 1B | 1.6–3 h | `README.md` |
| PufferLib recipe, 1 GPU (`exp000`) | 47.20% | 3.49B | 31 min | `README.md` |
| PufferLib public run, 8 GPUs | 55% / 61% | 20B / 120B | — | blog |
| `exp002` board encoder | 52.76% (4 seeds) | 20B | 12 h | `README.md` |
| `exp003` recipe (3 seeds in port; 8 seeds in blog) | 72.48% / 73% ±1.9 | 20B | 11 h | `README.md`, blog |
| `exp004` boss fine-tune | 80.06%, 43.5% boss wins | +3B | ~1.7 h | `README.md` |
| GPT-6 Astra playing directly (Roger Creus Castanyer) | 1 win in 75 games, ~1 day per win | — | — | blog |

Noise: "same-seed runs spread by up to about 9 points" (`README.md`). Across 8 seeds `exp003`'s
reference spans 70.54% to 77.04% (`experiments.py`, `exp003` docstring).

Lessons that transfer to avocode **(inference)**:

- Their best wins came from **diagnosis**, not from tuning. Example: they saved 100 games where the
  ladder had just opened and replayed each under 12 conditions. Steering to the ladder rescued 47 of
  90. Restoring health rescued 0. So the problem was finding the way down, not fighting.
- Their tooling had a bug (the scorer kept each agent's shortest game and hid wins). Our `f` must
  be dumb, protected and tested.
- Their record of runs (Trackinizer) is what `K` + `avo mem` + lineage should be for us.

## 3. Feasibility on this machine

### 3.1 Compute

- No GPU (`nvidia-smi` not found). 24 CPUs, 46 GB RAM, `uv` and Python 3.14 present.
- `uv venv -p 3.12` + `uv pip install craftax` took **3.4 s** (cached wheels). It pulls `jax`
  0.11.2 CPU. JAX finds `CpuDevice(id=0)`.
- The priml RL pipeline needs CUDA + Triton. It cannot run here. RL training is **out of scope**.

### 3.2 Timing (measured; scripts in the scratch dir `timing.py`, `t2.py`, `t3.py`, `t4.py`)

| What | Result |
| --- | --- |
| Classic, single env, Python loop over jitted `step` (auto-reset on) | 982 steps/s |
| Classic, `vmap` B=64 inside `lax.scan`, random actions | 4,881 steps/s (compile 4 s) |
| Classic, B=256 | 6,809 steps/s |
| Full, single env, Python loop, auto-reset **on** | 286 steps/s |
| Full, single env, Python loop, auto-reset **off** | **1,627 steps/s** |
| Full, `vmap` B=64 `scan`, auto-reset on | 1,256 steps/s (compile ~11 s) |
| Full, `step` first compile | 7.3 s |
| Full, pixel render 16 px (208x176 RGB), jitted | 1,072 frames/s; first call 48 s (texture cache, once) |
| Full, `render_craftax_text` | 0.82 s per frame (too slow for a policy) |
| Full, random policy, 64 episodes to death | mean 1.95 pts (0.86%), sd 1.01, max 5; mean length 273 steps; 16 s wall |

Notes:

- Auto-reset is costly. It builds a new 9-floor world on every step and then selects. The harness
  must use `auto_reset=False` and reset by hand.
- Random play unlocks only `COLLECT_WOOD` 34%, `COLLECT_SAPLING` 27%, `PLACE_PLANT` 19%,
  `COLLECT_DRINK` 12%, `PLACE_TABLE` 6%, `EAT_COW` 2% and `WAKE_UP` 95%.
- A faster engine exists: priml's Numba `game/` (bit-identical to PufferLib's C, CPU-only). I did
  not time it. Its API is buffer-based and it needs priml's private deps (`treekle`). It also has
  PufferLib's rules, not JAX Craftax's. Keep JAX Craftax 1.6.1 as the reference engine.

### 3.3 Wall time per score (estimate from §3.2)

6 configs x 16 worlds, cap 10,000 steps per episode. One process per config, all in parallel.

- An early policy lives ~1,000–3,000 steps: ~16–48k steps per config, ~15–35 s.
- A late policy plays to the cap: 160k steps per config, ~100–120 s.
- Add ~10 s of JIT per process. Use JAX's persistent compile cache
  (`jax_compilation_cache_dir`) to cut it.

So a full score is **~30 s early, ~2 min late**. `.avo/score --config w3` (one world set) is the
fast inner loop. CFX-3 measures the real numbers, policy overhead included.

### 3.4 Determinism and noise

- Craftax is a pure function of `(key, state, action)`. The repeat runs of the `scan` jobs were
  **bit-identical** (`deterministic=True` in every case).
- The harness derives each world's reset key and each step's key from `(world seed, step index)`.
  They never depend on the policy. So two policies see the same random numbers (common random
  numbers), and `f` is a pure function of `src/`.
- Noise is still real between **behaviourally close** policies. A small change moves the player one
  tile. Mob moves then diverge, and the episode follows a new path (chaos). Per-episode points of
  the random policy have sd/mean = 52%. With 16 worlds per config the standard error is about 13%
  of the mean **(inference: a scripted policy should vary less)**. CFX-4 measures it as `arcagi3`
  did: two policies with the same behaviour but a different tie-break order.
- Pin `jax`, `jaxlib` and `craftax` in `requirements.txt`. Cross-CPU float drift in XLA is a risk
  (mob logic is mostly integer). CFX-4 checks two machines.

## 4. Bench design: `bench/craftax`

### 4.1 Layout (materialized target)

```
src/policy.py            # THE candidate. Only src/ is editable.
bench/run.py             # PROTECTED. Episode harness, metric, sandbox, one JSON line per config.
bench/worker.py          # PROTECTED. Policy subprocess: gets obs, returns actions.
bench/view.py            # PROTECTED. Decodes the symbolic obs into named numpy fields.
bench/worlds.lock        # PROTECTED. Config -> world seeds; engine versions.
bench/setup.sh           # PROTECTED. Builds .venv (python 3.12, pinned craftax/jax).
bench/render.py          # PROTECTED. Replays a logged episode to GIF / PNG strip (for the agent too).
bench/probe.py           # PROTECTED. Diagnosis: replay to step t, dump obs, try a scenario.
test/test_policy.py      # PROTECTED. Contract suite.
requirements.txt         # PROTECTED.
task.md, README.md       # the rules and measured facts, as in arcagi3.
.avo/score, .avo/config.json, .avo/protected.txt
```

The ladder, the holdout seeds and the report tooling stay in avocode under `test/fixtures/craftax/`.
They never go into the template (same rule as `fuzzysearch`).

### 4.2 The candidate

```python
class Policy:
    def __init__(self, rng: random.Random): ...   # seeded by the harness
    def reset(self) -> None: ...                  # new episode
    def act(self, view: View) -> int: ...         # one of 43 actions
```

- `View` comes from `bench/view.py`: `blocks[9,11]`, `items[9,11]`, `mobs[k,9,11]`, `light[9,11]`,
  inventory, intrinsics (health, food, drink, energy, mana), `floor`, `ladder_open`, and more. The
  agent can still read the raw vector `view.raw` (8,268 floats).
- No network. No LLM calls. No JAX. Pure Python + numpy. The policy may keep any memory it wants
  (a map of seen tiles, a plan, a state machine).
- Why a scripted policy, not RL: no GPU here, and RL results swing ±9 points per seed. A per-seed
  swing that large would make `floor` meaningless. A scripted policy keeps `f` cheap and exact.
- Variant for later (not now): `craftax-rl`, where the agent edits a PPO recipe under a fixed
  budget. It needs a GPU and ≥ 4 seeds per score. See §8.

### 4.3 `f`

- **Engine:** `Craftax-Symbolic-v1` (the full game), `auto_reset=False`, episode cap
  `MAX_STEPS = 10_000` (the game's own cap is 100,000).
- **Configs:** 6 world sets, `w0`..`w5`, 16 worlds each (96 worlds). The seeds are in
  `bench/worlds.lock`.
- **Per-config score:** mean over its 16 episodes of achievement points / 226 x 100. An achievement
  counts once per episode. This is the community metric, and it is finer than "success": 67
  achievements, weighted 1/3/5/8.
- **primary:** mean of the 6 config scores. `higher_is_better: true`, `unit: "%226"`.
- **Rule:** `"reduce": "dominate"`, as the other benches.
- **floor:** start at **0.05**. Set it from CFX-4: floor ≥ 2x the median per-config disagreement of
  two behaviour-equal policies. If that comes out above 0.1, raise worlds per config to 24.
- **Extras (not in the vector):** per episode, the unlock bitmask, the deepest floor, the length,
  the cause of death, and the action list. `run.py` writes them to
  `.avo/artifacts/episodes/<config>.jsonl` (gitignored). The action list plus the seed replays the
  episode exactly, so GIFs need no second policy run.
- **Baseline shipped:** a random-walk policy that also presses `DO` when it faces a tree or water.
  Every config must be clearly above 0 (`arcagi3` lesson: a near-zero config vetoes every commit).
  Target: 1.5–3% per config. CFX-2 checks it.

### 4.4 Correctness gates (in order; any failure is `correct:false` with a named log line)

1. Hash gate over the protected files (`.avo/gate.sha256`).
2. Engine pin: `craftax`, `jax`, `jaxlib` versions match `bench/worlds.lock`. A wrong env is
   `ok:false` (harness), not `correct:false`.
3. Contract suite `test/test_policy.py`: the import works, `act` returns an `int` in `[0, 43)` on
   recorded views, and the same views give the same actions twice (determinism).
4. Episode gates: no sandbox breach, no exception in `act`, mean `act` time ≤ 5 ms, config wall time
   ≤ 300 s.
5. Size gate: `src/` ≤ 256 KB, and no binary or data files (`*.npy`, `*.pkl`, `*.bin`, ...). This
   limits lookup tables keyed on world layout.

Gates 4 and 5 give clear, repeatable failure signatures: `act-timeout`, `sandbox:import craftax`,
`size-gate`. Those are what `thrash` needs.

### 4.5 Protected files (`avo/protected.txt`)

`bench/run.py`, `bench/worker.py`, `bench/view.py`, `bench/worlds.lock`, `bench/setup.sh`,
`bench/render.py`, `bench/probe.py`, `test/test_policy.py`, `requirements.txt`, `.avo/score`,
`.avo/protected.txt`. The list protects itself, as in the other targets.

### 4.6 Anti-gaming

The main risk is a policy that reads the hidden game state (the full 48x48 map of each floor, mob
health, ladder position).

1. **Process isolation.** The policy runs in `bench/worker.py`, a subprocess. It gets only the
   `View` over a pipe. The harness keeps the `EnvState` in the parent. In-process, a policy could
   find the state with `gc.get_objects()`, and an audit hook cannot stop that. A separate process
   can. **(inference: IPC cost is ~20–50 µs per step, small next to ~600 µs per env step.)**
2. **Audit hook in the worker** (as `arcagi3`), armed from the policy import onward. It refuses
   `import` of `craftax`, `jax`, `jaxlib`; `open` of anything under `bench/` or `.venv/.../craftax`;
   all socket and subprocess events. It raises `Cheated(BaseException)` and sets a flag the parent
   checks.
3. **No seeds or world ids reach the policy.** The policy RNG seed is a harness constant plus the
   episode index, as in `arcagi3`.
4. **Memorisation.** The world seeds sit in a protected file inside the repo, so at dev time an agent
   could generate the 96 worlds and hard-code routes. Defences: the size gate (4.4 #5), the world
   count, and the **holdout** below. Reading the craftax source at **dev** time is allowed: those are
   the rules, and GPT-6 Astra knew them too. It is the policy at **run** time that may not look.

### 4.7 Holdout and external checks (outside `f`)

- `test/fixtures/craftax/holdout.lock`: 64 new world seeds, never in the template.
  `score-holdout.sh <target>` runs the target's own `bench/run.py --seeds-file`. `verify-run.sh
  --target craftax` reports train vs holdout per version.
- Pass: the holdout moves the same way as train for each version, within 2x floor. A train gain
  with a flat holdout is memorisation, and the report says so.
- Optional: a "long" eval on the best version with `MAX_STEPS = 100_000` and the deepest floor
  histogram, to compare with the blog's Figure 3.

### 4.8 Why it will plateau and fire the supervisor

- **Discrete tech tree.** 25 basic achievements are worth 1 point each (25 points = 11%). The rest
  need hard steps: find iron in dark caves, then diamonds, then the down ladder. On floors 1+ the
  ladder opens only after 8 kills on that floor (`game_logic.py`: `MONSTERS_KILLED_TO_CLEAR_LEVEL`).
  Next come torches for dark floors, spells from books, enchanting, and floor-specific mobs. For
  example, pigmen are hurt mainly by ice. Each step is a new subsystem of code. Small tweaks between
  steps barely move points. **(inference)**
- **Long horizon.** A good episode is thousands of steps. One early error (a skeleton in the dark,
  lava, thirst) costs the whole tail. Fixes for one death cause often add another.
- **Dominate over 6 world sets.** A change on the shared path (movement, the fight logic) changes
  every trajectory. It has to beat the noise on all six sets. `arcagi3` already showed this
  refusal shape (cell clicks: `mm01` -100%, refused). Expect many refusals in a row: that is `stall`.
- **Repeatable hard failures.** Search-heavy policies (A* over a remembered map, lookahead) hit the
  5 ms `act` cap and the 300 s config cap. They also hit the sandbox when they reach for the engine.
  The same failure three times is `thrash`.
- **Reference points prove headroom far above any scripted ceiling:** RL gets 73–80%. Astra, an LLM
  that knew the rules, still needed a day per win.

Pilot pass (as G2/G3 in `PLAN_ARCAGI.md`): in 10 turns, ≥ 2 versions and ≥ 1 turn with no version.
In 40 turns, ≥ 1 stall and ≥ 1 thrash.

## 5. The learning loop for the agent

Ship it in `task.md` and as K docs. Map each step onto avocode.

| Step | What the agent does | Tool / avocode part |
| --- | --- | --- |
| 1. Read the past | `avo mem prime`, `avo best`, `avo lineage`, `bd ready` | memory, `P_t`, beads |
| 2. Analyse | Read `.avo/artifacts/episodes/*.jsonl`: cause of death per world, unlock times, the deepest floor, where steps go. Look at 2–3 frame strips (`bench/render.py`). The model can read PNGs. | episode logs, renders |
| 3. World model | Keep `knowledge/craftax-model.md`: rules as facts with source refs (craftax source, measured probes), e.g. "iron needs a stone pickaxe; seen at depth ≥ ...". Each fact is marked *read* or *measured*. | `K` (`avo know add`) |
| 4. Hypothesis | One bead per hypothesis: claim, mechanism, the configs it should move, the expected size. E.g. "37% of deaths are thirst on floor 1; carry water -> +1–2% on w1, w4". | `bd create` |
| 5. Experiment | Change `src/`. Test a mechanism first on the worlds where it matters with `bench/probe.py` (replay to step t, then the new policy). Then `.avo/score --config wN`, then the full vector. | `probe.py`, `avo score` |
| 6. Decide | `avo commit --why "<bead id>: <result>"`. The rule decides, not the agent. | `avo commit` |
| 7. Update | Commit or refusal: `avo mem add` with the measured vector. Close or refute the bead. Fix the world model doc if a fact was wrong. | memory, beads, K |

Two rules from rekursiv's campaign:

- **Diagnose before you vary.** Counterfactual probes ("restore health at step t", "teleport to
  the ladder") answer "what is the bottleneck" in one run. `bench/probe.py` gives this to the agent.
  It runs in the harness (it may touch the state). It is never part of `f`.
- **Distrust the tool.** Each analysis script the agent writes goes in `src/tools/` and gets a
  one-line check against a known episode.

Supervisor directives should cite: open beads with no experiment, K docs no version names (e.g.
"lava bridging", "torches on dark floors", "kill 8 to open the ladder"), and the top death cause in
the last episode logs. **(inference: a death-cause histogram is the best "fresh direction" this game
offers.)**

## 6. Visuals

Use the `artifacts` field and `avo report` from `plan/visuals.md`. Craftax adds these files:

| File | Made by | Content |
| --- | --- | --- |
| `.avo/artifacts/episodes/<cfg>.jsonl` | `bench/run.py` (each score) | per episode: seed, length, points, unlock bits, floors, death cause, actions (base64 bytes) |
| `.avo/artifacts/rollout-<cfg>.gif` | `bench/render.py` (best episode of each config; on commit only) | 16 px frames 208x176, 1 frame per 4 steps, ≤ 1,500 frames, HUD line with step and points |
| `.avo/artifacts/strip-<cfg>.png` | `bench/render.py` | 12 frames, one at each new unlock, labelled with its name |
| `.avo/artifacts/achievements.json` | `bench/run.py` | 67 unlock rates for this candidate |
| `viz/heatmap.svg` (+ `.csv`) | `test/fixtures/craftax/report.py` after a run | versions (rows) x 67 achievements (cols), cell = unlock rate, cols grouped by tier |
| `viz/floors.svg` | same | per version, share of episodes that reach each floor (like the blog's Figure 3) |
| `viz/deaths.svg` | same | per version, death-cause bars |
| `viz/ghosts-<cfg>.png` | same | one world's overworld map with the path of every version, coloured by version (like the blog's ghosts) |
| `viz/curve.svg` | `avo report` (AVO-10/11) | attempts as dots, best-so-far step line, versions as diamonds, red/amber rules at stall/thrash, holdout as a second line |

Rules:

- `f` writes only small JSON. GIFs and PNGs are made after a commit, by replay, so they never slow
  `f`. The 48 s texture build happens once in `bench/setup.sh`.
- `verify-run.sh --target craftax` builds `viz/` and links it from the evidence file. The page can
  be published as an artifact.

## 7. Tasks

| Id | Title | Goal | Acceptance | Size | Deps |
| --- | --- | --- | --- | --- | --- |
| CFX-1 | Engine pin and setup | `bench/setup.sh` builds `.venv` (py3.12, pinned `craftax==1.6.1`, `jax`, `jaxlib`, `numpy`, `imageio`) and warms the texture and compile caches | fresh run ≤ 2 min; `--check` reports what is missing; `.avo/score` gives `ok:false` without it | S | — |
| CFX-2 | Harness and worker | `bench/run.py`, `bench/worker.py`, `bench/view.py`: keys from (seed, t), `auto_reset=False`, cap, subprocess policy, audit hook, one JSON line per config | random policy scores; 3 runs bit-identical; `--list`, `--config`, `--seeds-file` work | M | CFX-1 |
| CFX-3 | Speed budget | measure steps/s with policy + IPC; choose worlds per config and `MAX_STEPS` | full score ≤ 60 s for the baseline, ≤ 180 s for a policy at the cap; numbers in README | S | CFX-2 |
| CFX-4 | Noise and floor | two behaviour-equal policies (different tie-break order); two machines | median per-config disagreement measured; floor set to ≥ 2x it; cross-machine result recorded | S | CFX-3 |
| CFX-5 | Scorer and gates | `.avo/score` with the 5 gates of §4.4, `--configs`/`--config` without Python | each gate has a fixture that trips it with a distinct log line; `avo score --parallel` works | M | CFX-2 |
| CFX-6 | Anti-gaming suite | cheat fixtures: `gc` scan, `import craftax`, read `bench/worlds.lock`, socket, `except BaseException` swallow, a binary lookup table | each one gives `correct:false`; `init.sh --verify` catches a scorer edit | M | CFX-5 |
| CFX-7 | Scripted ladder | `test/fixtures/craftax/policy-v1..v6.py`: v1 survive (drink, eat, sleep in a dug nook, flee), v2 wood tier (table, wood tools, sapling), v3 stone tier (stone tools, furnace, coal, torches), v4 iron and diamond search with a remembered map, v5 descend (ladder, 8 kills, enter dungeon, floor 1 survival), v6 a shared-path change made to be **refused** | `test/e2e-craftax.sh` replays them: v1–v5 commit, v6 refused with the config named; headroom ≥ 5x over baseline (target ≥ 10% of 226) | L | CFX-5 |
| CFX-8 | Holdout | `holdout.lock` (64 seeds), `score-holdout.sh` | the ladder moves the holdout the same way as train within 2x floor | S | CFX-7 |
| CFX-9 | Render and probe tools | `bench/render.py` (GIF, strip from an episode log), `bench/probe.py` (replay to t, dump `View`, scenario overrides) | a ladder episode renders in ≤ 10 s; probe replays bit-identical to the logged episode | M | CFX-2 |
| CFX-10 | Episode logs and artifacts | `run.py` writes `episodes/*.jsonl` and `achievements.json`; `artifacts` field per `plan/visuals.md` | `avo score` lists the files; replay of a logged action list gives the same points | S | CFX-2, AVO-11 |
| CFX-11 | Report panels | `report.py`: heatmap, floors, deaths, ghosts; hooks into `verify-run.sh --target craftax` | panels render for the ladder lineage with no hand edits | M | CFX-7, CFX-9, AVO-10 |
| CFX-12 | Task text and seed K | `task.md`, `README.md` (measured facts); 5–8 K notes (rules digest, death causes, Crafter/Craftax papers, SPRING-style LLM-written plans, Go-Explore, the rekursiv post) that do **not** hold the ladder | an agent with only `task.md` can run a score and read an episode log in its first turn | S | CFX-7 |
| CFX-13 | `e2e-craftax.sh` and CI | the suite in `test/`, Python half `SKIP`ped without a set-up target (like `e2e-arcagi3.sh`) | CI green; evidence file `evidence/craftax-e2e.txt` | S | CFX-6, CFX-7 |
| CFX-14 | Pilot run | `avo run`, 10 turns, stall 5, thrash 3 | G2-style gate: ≥ 2 versions, ≥ 1 turn with no version, cost per turn recorded; holdout checked | M | CFX-12, CFX-13 |
| CFX-15 | Campaign | 40 turns, then an ablation with `--supervise off` (AVO-4) | ≥ 1 stall and ≥ 1 thrash in the record; on/off curves on one chart | L | CFX-14 |

## 8. Risks, open questions, and comparison with ARC-AGI-3

### 8.1 Risks

| Risk | Effect | Response |
| --- | --- | --- |
| Chaos noise above floor | lucky commits, or every shared-path change refused | CFX-4; more worlds per config; split configs by world type if needed |
| Score too slow late in a run (policies reach the cap) | few attempts per turn | lower `MAX_STEPS` to 5,000; numba engine; B>1 `vmap` per config |
| Scripted ceiling is low (stuck at ~10%) | a plateau with no exit, every turn refused | a good stall test, but bad for the curve. Add scenario configs (start on floor 1 with kit) later. Keep them out of `dominate` until they are non-zero. |
| Agent memorises worlds | train gains, holdout flat | size gate, holdout, report flags it |
| JAX version drift | scores move with no code change | pin and hash versions; engine gate is `ok:false` |
| Agent spends turns on tools, not policy | slow curve | ship `render.py`/`probe.py`; protect them |
| GIF size | big artifacts | cap frames; GIF only for committed versions |

### 8.2 Open questions

1. Full Craftax or Classic? Classic (22 achievements, 1 floor, ~5x faster) has a lower ceiling.
   It may saturate for a scripted policy. Plan: full game; Classic only if CFX-3 fails the budget.
2. Should `probe.py` scenario starts (e.g. "at the floor-1 ladder") become configs? They give a
   gradient on late skills but risk near-zero configs. Decide after CFX-7.
3. Is reading craftax source at dev time fair? This plan says yes (rules are knowledge). The runtime
   sandbox stays strict.
4. Is `act` ≤ 5 ms right? It blocks deep search. Measure on ladder v4 (map memory + BFS).
5. Does Pareto per config fit a game where world sets differ by luck? An alternative is one config
   per tier (points from basic, intermediate, advanced). Each tier moves for a different reason, which
   may make `dominate` more meaningful. Try both on the ladder.

### 8.3 Craftax vs ARC-AGI-3

| | ARC-AGI-3 (`bench/arcagi3`) | Craftax (`bench/craftax`) |
| --- | --- | --- |
| Status | built, gated, 1-rung ladder, no agent run | plan only |
| Score time | ~20 s | ~30 s early, ~2 min late (est.) |
| Metric grain | levels per game (coarse; 24 rollouts to tame noise) | 226 points over 67 achievements per episode (fine) |
| Worlds | fixed layouts (seed is a no-op), so memorisation is easy | procedural; new seeds give a clean holdout |
| Plateau shape | per-game jumps; may stall early and stay there | tech-tree jumps; long flat parts; known far ceiling |
| Thrash sources | sandbox, contract | sandbox, contract, act and wall caps, size gate |
| Visuals | 64x64 frames, games x levels heatmap | game sprites, GIFs, achievement heatmap, floors, ghost paths |
| Outside reference | ARC Prize leaderboard (official API, needs a key) | public RL and LLM numbers (12–18%, 73%, 80%; Astra 1/75) |
| Deps | ARC toolkit, pinned games | `craftax` + JAX CPU (3.4 s install) |

Recommendation: run the ARC-AGI-3 pilot first, because it is built and costs least to try. Build
Craftax CFX-1..CFX-7 now, in parallel. It is the better long-term showcase and the stronger
generalisation test. Switch to it by the go/no-go rule in `PLAN_ARCAGI.md` §8, or sooner if the ARC
pilot shows memorisation.
