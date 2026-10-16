# Related work

Source notes for the related-work section of *An implementation of NVIDIA's Agentic Variation
Operators (AVO) for Autonomous Evolutionary Search*. Each entry gives a short summary, then its
relation to AVO \cite{chen2026avo} and to avocode. The keys match `references.bib` in this folder.

**How we checked the citations (2026-10-14).**

- arXiv entries: we pulled the title, authors and year from the arXiv API. Every arXiv ID in
  this file resolves.
- DOI entries: we checked them against Crossref.
- Software and web entries: we checked that each URL resolves. Two repos moved: `codelion/openevolve`
  now redirects to `algorithmicsuperintelligence/openevolve`, and `steveyegge/beads` to
  `gastownhall/beads`. The bib uses the new URLs.
- Unverified items carry an **[unverified]** tag. Only one has it: the OpenAI Codex announcement URL.
  The AVO paper cites it, but the server blocks scripted requests, so we could not load it.

**Terms used below.**

- *Fixed pipeline*: a framework that owns sample, generate and evaluate. The LLM fills one slot.
- *Agent as operator*: the AVO view. One agent loop owns the whole variation step.
- *Population*: many candidates are kept at once (islands, MAP-Elites grids, databases).
- *Single lineage*: one monotone chain of accepted versions. This is AVO's and avocode's model.

---

## 0. The references of the AVO paper

AVO \cite{chen2026avo} has 24 references. The table maps each one to a key in `references.bib`.

| # | Work | Key |
|---|------|-----|
| 1 | O'Neill et al., Open issues in genetic programming (2010) | `oneill2010openissues` |
| 2 | Lehman et al., Evolution through Large Models (2022) | `lehman2022elm` |
| 3 | Romera-Paredes et al., FunSearch, *Nature* (2024) | `romeraparedes2024funsearch` |
| 4 | Novikov et al., AlphaEvolve (2025) | `novikov2025alphaevolve` |
| 5 | Chen, Dohan, So, EvoPrompting (2023) | `chen2023evoprompting` |
| 6 | Vaswani et al., Attention is all you need | `vaswani2017attention` |
| 7 | Dao et al., FlashAttention (2022) | `dao2022flashattention` |
| 8 | Dao, FlashAttention-2 (2023) | `dao2023flashattention2` |
| 9 | Shah et al., FlashAttention-3 (2024) | `shah2024flashattention3` |
| 10 | Zadouri et al., FlashAttention-4 (2026) | `zadouri2026flashattention4` |
| 11 | Chetlur et al., cuDNN (2014) | `chetlur2014cudnn` |
| 12 | Jimenez et al., SWE-bench (2024) | `jimenez2024swebench` |
| 13 | Yang et al., SWE-agent (2024) | `yang2024sweagent` |
| 14 | Wang et al., OpenHands (2025) | `wang2025openhands` |
| 15 | Anthropic, Claude 3.7 Sonnet and Claude Code (2025) | `anthropic2025claude37` |
| 16 | OpenAI, Introducing Codex (2025) | `openai2025codex` **[unverified URL]** |
| 17 | Xu et al., VibeTensor (2026) | `xu2026vibetensor` (arXiv 2601.16238; the AVO bib gives no ID) |
| 18 | Wan et al., LoongFlow (2025) | `wan2025loongflow` |
| 19 | Bäck, Fogel, Michalewicz, Handbook of Evolutionary Computation (1997) | `back1997handbook` |
| 20 | Ye et al., ReEvo (2024) | `ye2024reevo` |
| 21 | Mouret and Clune, MAP-Elites (2015) | `mouret2015mapelites` (arXiv 1504.04909; the AVO bib gives no ID) |
| 22 | Yuksekgonul et al., Learning to discover at test time (2026) | `yuksekgonul2026ttdiscover` |
| 23 | Silver et al., AlphaGo, *Nature* (2016) | `silver2016alphago` |
| 24 | Qwen3 technical report (2025) | `yang2025qwen3` |

The AVO paper does not cite these works: ShinkaEvolve, OpenEvolve, KernelBench, the AI CUDA
Engineer, Reflexion, Voyager, the AI Scientist or the Darwin Gödel Machine. Each one is close to
AVO. The sections below add them.

---

## 1. Classical evolutionary computation

### Holland, *Adaptation in Natural and Artificial Systems* — `holland1992adaptation`

Holland set out the genetic algorithm. A population of bit strings goes through selection,
crossover and mutation. The schema theorem explains why short, fit building blocks spread.
**Relation.** This is the "classical EVO" that AVO replaces. Mutation and crossover here are blind
syntactic operators. AVO swaps them for an agent that reads code and documents. avocode keeps the
evolutionary frame (a lineage, a fitness gate) but has no crossover and no population on `main`.

### Koza, *Genetic Programming* — `koza1992gp`

Koza evolved computer programs as trees. Crossover swaps subtrees, and fitness comes from
running the program on test cases. **Relation.** GP is the direct ancestor of "evolve code
against an executable fitness function". AVO's `f` and avocode's `.avo/score` play the same role
as Koza's fitness cases. GP's known problems were bloat, weak operators and poor scaling
\cite{oneill2010openissues}. A language model fixes the operator, because it can make edits that
mean something.

### O'Neill et al., *Open issues in genetic programming* — `oneill2010openissues`

A survey of the problems GP still had in 2010: locality of the operators, bloat, benchmarks,
generalization and how GP scales to large programs. **Relation.** AVO cites it to motivate
learned operators. The "locality" issue (a small syntactic change can make a large semantic
change) is what a code-reading agent solves.

### Bäck, Fogel, Michalewicz (eds.), *Handbook of Evolutionary Computation* — `back1997handbook`

The standard reference for evolution strategies, evolutionary programming, GAs and GP, with their
selection schemes. **Relation.** AVO cites it for the general sample, vary and update loop. The
handbook also defines (μ+λ) and (1+1) selection. avocode's commit rule is an elitist (1+λ)
scheme, as the next entries show.

### Droste, Jansen, Wegener, *On the analysis of the (1+1) evolutionary algorithm* — `droste2002oneplusone`

The (1+1)-EA keeps one parent. It mutates the parent and keeps the child only if the child is at
least as good. The paper gives runtime bounds for it on standard functions. **Relation.** This is
the closest classical model of avocode. `avo commit` keeps a single best version and accepts a
candidate only when it passes correctness and beats the best. `avo fan` makes it (1+λ): λ probes
run in parallel worktrees, and only the winner can be promoted. Two differences from the
textbook rule:

- avocode accepts on *dominate-or-tie* over a score vector, with a symmetric noise floor.
  It does not use a scalar `≥`.
- Ties without a strict gain do not commit. So neutral drift is not allowed.

### Hill climbing — `russell2020aima`

Hill climbing is local search that moves to a better neighbour and stops at a local optimum.
Common fixes are restarts, simulated annealing or a wider neighbourhood. **Relation.** A single
monotone lineage is a hill climber. Its known failure mode is stagnation. AVO adds a supervisor
agent that sees a stall and redirects the search. avocode does the same with `avo supervise`
(stall and thrash detection) and with fan-out probes that test far-apart directions.

### Mouret and Clune, *Illuminating search spaces by mapping elites* (MAP-Elites) — `mouret2015mapelites`

MAP-Elites splits the search space into a grid of behaviour cells and keeps the best solution in
each cell. The result is a map of diverse, high-quality solutions instead of a single best one.
**Relation.** AVO cites MAP-Elites as one of the population schemes that earlier LLM systems used.
FunSearch, AlphaEvolve and CodeEvolve use islands or MAP-Elites archives. AVO and avocode drop
the archive on purpose. The agent itself supplies diversity, because it reads the whole lineage.
The cost: avocode can lose stepping stones that a QD archive would keep. Its dead-end memory
(`avo mem add`) and fan-out are partial substitutes.

### Lehman and Stanley, *Abandoning Objectives: novelty search* — `lehman2011novelty`

Novelty search rewards behaviours that differ from earlier ones and ignores the objective. On
deceptive problems it can beat objective-driven search. **Relation.** It is the main argument
against a purely elitist lineage. avocode is objective-driven. It handles deception only through
the supervisor and through human-written directions for `avo fan`.

### Silver et al., *AlphaGo* — `silver2016alphago`

Deep networks guide a Monte Carlo tree search to play Go. **Relation.** AVO cites it as an example
of search guided by a learned prior. AVO moves the prior into the variation operator, not into a
value network.

---

## 2. LLM-guided evolution

### Lehman et al., *Evolution through Large Models* (ELM) — `lehman2022elm`

ELM uses a code LLM, trained on diffs, as the mutation operator inside MAP-Elites. It evolved
Sodarace walker programs. The LLM makes edits that a human might make, so mutations are much more
likely to be useful. **Relation.** ELM is the origin of "LLM as mutation operator". AVO goes one
step further. The operator is no longer one LLM call per mutation. It is a full agent loop that
can run tools, debug and verify before it proposes a candidate.

### Meyerson et al., *Language Model Crossover* (LMX) — `meyerson2024lmx`

LMX does crossover with few-shot prompts. Several parents go into the prompt, and the LLM writes a
child that mixes them. **Relation.** AVO keeps a form of crossover. The agent reads several
earlier versions from the lineage in one step (paper §3.2). avocode gets the same effect for free:
`lineage/vNNN.md` files are indexed by qmd, so the agent can retrieve and combine past versions.

### Chen, Dohan, So, *EvoPrompting* — `chen2023evoprompting`

EvoPrompting uses an LLM as the mutation and crossover operator for neural architecture search
in code, and it tunes the LLM with soft prompts during the search. **Relation.** AVO cites it as
one of the fixed-pipeline LLM-evolution methods.

### Guo et al., *EvoPrompt* — `guo2023evoprompt`

EvoPrompt connects LLMs to GA and differential evolution to optimize discrete prompts. The LLM does
the crossover and mutation on prompt text. **Relation.** Same pattern as EvoPrompting, but the
genome is a prompt. AVO and avocode evolve a code repository instead.

### Fernando et al., *Promptbreeder* — `fernando2023promptbreeder`

Promptbreeder evolves task prompts and also the "mutation prompts" that change them. So it is
self-referential. **Relation.** It is an early case of evolving the operator itself. avocode has a
similar idea in its meta loop. The operator's instructions are skills (`.agents/skills/`), and
humans and agents can improve them.

### Yang et al., *Large Language Models as Optimizers* (OPRO) — `yang2024opro`

OPRO puts past solutions and their scores into a prompt and asks the LLM for a better solution.
**Relation.** OPRO is the simplest "lineage in context" optimizer. AVO's `P_t` and avocode's
`avo best` and `avo lineage --json` are structured versions of the same idea.

### Romera-Paredes et al., *FunSearch* — `romeraparedes2024funsearch`

FunSearch pairs a pretrained code LLM with an automatic evaluator. An island-based program database
keeps diversity, and the LLM evolves one Python function at a time. It found new constructions for
the cap set problem and better bin-packing heuristics. **Relation.** FunSearch is the standard
example of the fixed pipeline AVO criticizes. The framework does sampling, prompt building,
evaluation and the database update. The LLM is used in one shot. FunSearch also introduced the
evaluator design that AVO and avocode keep: an executable, deterministic score, with failure as
the lowest score.

### Ye et al., *ReEvo* — `ye2024reevo`

ReEvo uses LLMs as hyper-heuristics. A reflection step compares good and bad heuristics and writes
a verbal "gradient" that guides the next generation. **Relation.** AVO cites ReEvo as a fixed
pipeline with reflection added. In AVO and avocode, reflection is not a separate stage. The agent
does it inside its own loop. avocode then stores the result as a memory (`avo mem add`).

### Novikov et al., *AlphaEvolve* — `novikov2025alphaevolve`

AlphaEvolve is a Gemini-based evolutionary coding agent. It evolves whole code files through diffs,
uses an LLM ensemble, a program database and parallel asynchronous evaluators. It improved Strassen
style 4×4 complex matrix multiplication and Google data-centre scheduling, and it sped up kernels
used to train Gemini. **Relation.** AlphaEvolve is the main baseline in the AVO paper. AVO keeps
its goals but changes who controls the loop. In AlphaEvolve the framework decides what to sample
and how to evaluate. In AVO the agent decides. avocode follows AVO but stays agent-agnostic: any
coding agent (pi, Claude Code, Codex) is the operator.

### Georgiev, Gómez-Serrano, Tao, Wagner, *Mathematical exploration and discovery at scale* — `georgiev2025mathexploration`

The authors run AlphaEvolve on 67 problems in analysis, combinatorics and geometry. It often
matches or improves known constructions, and the paper shows where it fails. **Relation.** It shows
that evaluator design decides what the search can find. This is the same reason avocode treats
`.avo/score` as a frozen contract.

### Sharma, *OpenEvolve* — `sharma2025openevolve`

An open-source re-implementation of AlphaEvolve: a prompt sampler, an LLM ensemble, an evaluator
pool and a MAP-Elites/island program database. It works with any OpenAI-compatible API.
**Relation.** OpenEvolve is a fixed-pipeline, population-based harness. avocode is the
agent-as-operator, single-lineage counterpart. Both are open source and both aim to separate a
paper's harness from its domain result.

### Lange, Imajuku, Cetin, *ShinkaEvolve* — `lange2025shinkaevolve`

ShinkaEvolve (Sakana AI) targets sample efficiency. It adds a balance of exploration and
exploitation for parent selection, a novelty filter that rejects near-duplicate code, and a bandit
that picks which LLM to use. It reached a new state of the art on circle packing with about 150
samples. **Relation.** ShinkaEvolve attacks the cost of a candidate with cleverer selection.
avocode attacks it differently. Cheap probes on small models (`avo fan`) explore, and only the
winning direction gets the expensive model.

### Assumpção et al., *CodeEvolve* — `assumpcao2025codeevolve`

CodeEvolve uses island-based search over a CVT-MAP-Elites archive, with inspiration-based crossover
and meta-prompting. It matches or beats the reported AlphaEvolve results on 5 of 9 problems.
**Relation.** It is a strong open population baseline that an avocode evaluation could compare
against.

### Wan et al., *LoongFlow* — `wan2025loongflow`

LoongFlow replaces random mutation with a plan, execute and summarize cycle. The summary feeds the
next plan. **Relation.** AVO cites it as a step toward agentic variation that still keeps a fixed
outer pipeline. The summarize stage is close to avocode's dead-end memory.

### Yu et al., *AlphaResearch* — `yu2025alpharesearch`

An agent that proposes ideas, programs them, and checks them. It mixes an execution-based reward
with a simulated peer-review reward. **Relation.** It shows that a non-executable reward (peer
review) can open a reward-hacking path. avocode allows only executable `f`.

### Yuksekgonul et al., *Learning to Discover at Test Time* — `yuksekgonul2026ttdiscover`

The model keeps training with reinforcement learning on one problem at test time, so it gets better
at that problem during the search. **Relation.** AVO cites it as an alternative: change the
operator's weights, not its context. avocode does not train models. It only changes the context
(lineage, memory, knowledge).

### Yan et al., *PACEvolve++* — `yan2026pacevolve`

A small "advisor" model, trained by RL at test time, picks hypotheses. A frontier model then writes
the code. **Relation.** It separates strategy from implementation. avocode's fan-out does a
similar split without training: small models probe, a large model implements.

### Agrawal et al., *GEPA* — `agrawal2025gepa`

GEPA evolves the prompts of a compound AI system. It reflects on full traces in natural language
and keeps a Pareto front of candidates. It can beat RL fine-tuning with far fewer rollouts.
**Relation.** Its Pareto front over many tasks is close to avocode's dominate-or-tie rule over
many scoring configs.

### Ma et al., *Eureka* — `ma2024eureka`

Eureka uses GPT-4 to write reward functions for robot RL as code. It improves them in an
evolutionary loop, using training statistics as feedback. **Relation.** Eureka evolves the
*evaluator*. avocode forbids this inside the loop. The agent must not edit `.avo/score`, because
an agent that can change its own fitness function will game it (see §4).

---

## 3. Agentic coding and autonomous research loops

### Chen et al., *Evaluating LLMs trained on code* (Codex, HumanEval) — `chen2021codex`

This paper introduced Codex and the HumanEval benchmark, scored by functional correctness with
unit tests. **Relation.** It set the "tests are the judge" standard. avocode's `correct` gate is a
direct descendant.

### Yao et al., *ReAct* — `yao2023react`

ReAct mixes reasoning traces and tool actions in one loop. **Relation.** Every coding agent that
avocode drives is a ReAct-style loop. AVO's main claim is that this loop is now a good enough
variation operator.

### Shinn et al., *Reflexion* — `shinn2023reflexion`

After a failed attempt, the agent writes a verbal reflection and stores it in an episodic memory.
The next attempt reads it. This improves results without changing weights. **Relation.** Reflexion
is the within-task memory that AVO's agent uses implicitly. avocode makes it explicit and makes it
last across sessions: `avo mem add` records insights and dead ends, and `avo mem prime` loads them
at the start of a new session.

### Madaan et al., *Self-Refine* — `madaan2023selfrefine`

One LLM writes, criticizes and refines its own output with no external signal. **Relation.**
Self-refine with no ground truth can drift. AVO and avocode tie every refinement to an external
`f`.

### Jimenez et al., *SWE-bench* — `jimenez2024swebench`

A benchmark of real GitHub issues. A patch must make the repository's hidden tests pass.
**Relation.** AVO cites it to show that agents now solve repository-scale tasks. That is the
condition for using them as variation operators.

### Yang et al., *SWE-agent* — `yang2024sweagent`

SWE-agent shows that the agent-computer interface (ACI) matters. Small, well-designed commands
for viewing, searching and editing raise SWE-bench scores a lot. **Relation.** avocode is an ACI
for evolution. Its CLI gives the agent a few commands with JSON output (`avo score --json`,
`avo commit`, `avo best`). Its skills describe when to use each one.

### Wang et al., *OpenHands* — `wang2025openhands`

An open platform for software agents. Agents act through code, a shell and a browser in a
sandbox. **Relation.** AVO cites it with Claude Code and Codex as possible operators. avocode
supports pi, Claude Code and Codex. OpenHands could be added with one command template.

### Anthropic, *Claude Code* — `anthropic2025claude37`, `anthropic2025claudecode`

Claude Code is a coding agent that runs in the terminal. It reads files, runs commands and edits
code, and it has a headless mode (`claude -p`). **Relation.** AVO names it as a possible operator.
avocode drives it headless for `avo fan` and `avo run`, and wires skills in with `avo install`.

### OpenAI, *Codex* and *Codex CLI* — `openai2025codex` **[unverified URL]**, `openai2025codexcli`

Codex is OpenAI's software-engineering agent. Codex CLI is an open-source terminal agent with a
non-interactive mode (`codex exec`). **Relation.** It is one of avocode's three supported
operators. Codex has no skill-discovery feature, so avocode lists the skills in `AGENTS.md`.

### Zechner, *pi* — `zechner2025pi`

pi is a minimal, extensible coding agent. Its core has four tools (read, write, edit, bash) and a
short system prompt. TypeScript extensions add tools, commands and event hooks. **Relation.** pi
is avocode's reference agent. avocode ships native pi extensions with six tools and an
in-session supervisor. The design rule is that the CLI comes first and bindings only add
convenience.

### Jiang et al., *AIDE* — `jiang2025aide`

AIDE treats ML engineering as a tree search over code. Each node is a script with its validation
score. The agent drafts, debugs or improves nodes. **Relation.** AIDE keeps a tree, avocode keeps a
chain. AIDE's tree is the trajectory. avocode separates the trajectory (gitignored attempts and
worktrees) from the lineage (committed versions).

### Chan et al., *MLE-bench* — `chan2025mlebench`

75 Kaggle competitions used to test ML-engineering agents. It also checks for plagiarism and
contamination. **Relation.** It is an example of a benchmark that defends against cheating. See
§4.

### Lu et al., *The AI Scientist*; Yamada et al., *The AI Scientist-v2* — `lu2024aiscientist`, `yamada2025aiscientistv2`

An end-to-end pipeline that generates ideas, writes code, runs experiments, writes a paper and
reviews it with an LLM. Version 2 adds agentic tree search, and one of its papers passed
workshop peer review. The authors report that the system sometimes edited its own time limits.
**Relation.** It is the broadest autonomous research loop. The edits to its own limits are a
well-known reward-hacking case. They are why avocode keeps `f` and the harness outside the
agent's write path.

### Schmidgall et al., *Agent Laboratory* — `schmidgall2025agentlab`

An LLM-agent workflow for literature review, experiments and report writing, with optional human
feedback at each stage. **Relation.** It is a staged pipeline, the opposite of AVO's single
agent loop.

### Zelikman et al., *STOP*; Yin et al., *Gödel Agent*; Hu et al., *ADAS* — `zelikman2023stop`, `yin2024godelagent`, `hu2025adas`

STOP improves a scaffolding program by running the scaffold on itself. Gödel Agent lets an agent
rewrite its own logic. ADAS has a meta agent that writes new agent designs in code and keeps an
archive of them. **Relation.** These systems improve the *operator*. AVO and avocode improve a
*target* with a fixed operator. avocode's meta loop (the agent improves avocode itself) is the
closest link to this line of work.

### Zhang et al., *Darwin Gödel Machine* — `zhang2025dgm`

DGM is a coding agent that edits its own code. An open-ended archive of agent variants is scored on
SWE-bench and Polyglot. SWE-bench goes from 20% to 50%. The authors report that some variants
faked tool-use logs to look successful. **Relation.** DGM joins population-based open-endedness
with agentic self-modification. Its reward-hacking report supports avocode's rule that the
evaluator must stay out of the agent's reach.

### Xu et al., *VibeTensor* — `xu2026vibetensor`

NVIDIA's team used coding agents to generate a full deep-learning runtime: a C++20 core, CUDA
allocator, autograd and Python bindings. Builds and tests were the main check. **Relation.** AVO
cites it as proof that agents can write systems code at scale. AVO adds an optimization objective
to the agents.

### Karpathy, *autoresearch* — `karpathy2026autoresearch`

A small repo (March 2026). A coding agent edits one training script, runs a 5-minute training job,
and keeps the change only if validation loss improves. Otherwise it reverts. The instructions live
in `program.md`. **Relation.** autoresearch is a minimal AVO-like loop: one lineage, git as the
store, an executable metric, keep-if-better. avocode generalizes it. avocode adds:

- any scorer through the `f` contract;
- a score vector with a noise floor;
- refusals that it records;
- searchable memory and knowledge;
- parallel probes and a supervisor.

### Qu and Lu, *Bilevel Autoresearch* — `qu2026bilevel`

An outer autoresearch loop reads the inner loop's code and traces and adds new search mechanisms.
On Karpathy's benchmark it gives a 5× larger improvement than the inner loop alone. **Relation.**
It is evidence that the harness matters as much as the model. This is avocode's premise.

### Zhang et al., *Agora: Git as Shared Memory for Collective AutoResearch* — `zhang2026agora`

Agents in separate sessions record results, insights and hypotheses as an append-only DAG of git
commits. Views show leading results and neglected branches. 13 workers ran for 12 days.
**Relation.** It is the closest design to avocode's lineage. Both use git as the store of
results. Agora is a DAG for many workers. avocode is a single monotone chain with a hard commit
rule.

### Chun et al., *Recovering Wasted Compute in Autoresearch Agents* — `chun2026wastedcompute`

Autoresearch agents fix the same bugs again and again, skip tuning, do not explore, and ignore
their own data analysis. **Relation.** These are the failure modes avocode's memory (dead ends),
supervisor (thrash detection) and fan-out (exploration) target.

### Suwandi, Yin, Murphy, *Kernel Autoresearch (Kernaut)* — `suwandi2026kernaut`

Coding agents write Gaussian-process kernels as programs. Construction contracts guarantee
validity, and a quality-diversity archive keeps distinct kernels. 22–58% of LLM kernels that
passed random-input checks failed at other scales. **Relation.** Its result is a warning about weak
correctness gates. A `correct` flag is only as good as its test inputs.

---

## 4. Benchmark and evaluation integrity (reward hacking)

### Manheim and Garrabrant, *Categorizing variants of Goodhart's Law* — `manheim2018goodhart`

The paper names four ways a proxy metric fails under optimization pressure: regressional,
extremal, causal and adversarial. **Relation.** An autonomous loop that runs for days applies
strong optimization pressure to `f`. avocode's rules map onto the variants:

- Dominate-or-tie over configs stops one config from paying for a regression on another (regressional).
- A config that the candidate omits blocks the commit, so a candidate cannot win by measuring less (adversarial).

### Amodei et al., *Concrete Problems in AI Safety* — `amodei2016concrete`

The paper lists reward hacking as a core accident risk. Proposed fixes include adversarial reward
functions and keeping the reward out of the agent's reach. **Relation.** avocode puts the reward
out of reach by policy and by checks. The agent must not edit `.avo/score`. The benches add a hash
gate, and `bench/init.sh --verify` audits it from outside.

### Lehman et al., *The Surprising Creativity of Digital Evolution* — `lehman2020surprising`

Many anecdotes in which evolution exploited bugs in simulators and fitness functions. **Relation.**
It shows that specification gaming is an old problem in evolutionary search, older than LLMs. An
agentic operator does the same thing faster and on purpose.

### Krakovna et al., *Specification gaming* — `krakovna2020specgaming`

A DeepMind essay and public list of agents that satisfy the letter of an objective but not its
intent. **Relation.** Background for the threat model.

### METR, *Recent Frontier Models Are Reward Hacking* — `metr2025rewardhacking`

METR reports that frontier models change tests, read the grader's answer, or patch the timer. In
one case, o3 had to write a fast Triton kernel. It took the reference answer from the call stack
and turned off CUDA synchronization so that the timing was wrong. **Relation.** This is the exact
threat for AVO-style kernel search. avocode's defences:

- `f` is a separate executable that always exits 0.
- Correctness gates the score.
- Edits to `f` are forbidden and audited.
- Only `avo commit` can write a version.

### Lange et al., *The AI CUDA Engineer*; *robust-kbench* — `lange2025aicudaengineer`, `lange2025robustkbench`

Sakana's AI CUDA Engineer translated PyTorch to CUDA and optimized it with evolutionary
meta-generation and an archive of good kernels. After release, users found that some reported
speedups came from a memory exploit in the evaluation code that skipped the correctness check.
Sakana withdrew those claims. The follow-up robust-kbench paper builds an evaluation that closes
these loopholes. **Relation.** This is the main case study for kernel-search integrity. The scorer
must check correctness on fresh inputs, keep outputs separate from inputs, and synchronize before
it times.

### Zhong, Raghunathan, Carlini, *ImpossibleBench* — `zhong2025impossiblebench`

Tasks whose tests contradict the specification, so any pass is a cheat. It measures how often
agents exploit tests. **Relation.** It is a possible check for avocode: does an agent under
`avo run` ever try to pass with an impossible `f`?

### Baker et al., *Monitoring Reasoning Models for Misbehavior* — `baker2025monitoring`

Another LLM can catch reward hacking by reading the chain of thought. But training against the
monitor teaches the model to hide its intent. **Relation.** avocode's supervisor watches progress,
not intent. The paper argues for keeping such monitors out of the optimization signal.

### Chollet, *On the Measure of Intelligence*; ARC Prize Foundation, *ARC-AGI-3* — `chollet2019measure`, `arcprize2026arcagi3`, `arcprize2026arcagi3web`

Chollet defines intelligence as skill-acquisition efficiency and introduces ARC. ARC-AGI-3 is an
interactive version. Agents play turn-based games with no instructions and must find the goal.
Humans solve all of them, and frontier AI scored below 1% in March 2026. **Relation.** avocode's
`arcagi3` bench evolves a game-playing policy against ten games. The scorer hides each game's
identity and uses a hash gate, so the agent cannot overfit to named games.

---

## 5. GPU kernel optimization with LLMs

### Dao et al., *FlashAttention* 1–4 — `dao2022flashattention`, `dao2023flashattention2`, `shah2024flashattention3`, `zadouri2026flashattention4`

1. FlashAttention computes exact attention in tiles held in on-chip SRAM, which cuts HBM traffic (IO-awareness).
2. FA-2 improves parallelism and work partitioning.
3. FA-3 uses Hopper asynchrony (warp specialization, TMA) and FP8.
4. FA-4 co-designs the algorithm and the kernel pipeline for Blackwell, where tensor-core throughput grows faster than other units.

**Relation.** FA-4 is AVO's main baseline. AVO reports up to +10.5% over FA-4 and +3.5% over
cuDNN on B200 after 7 days of autonomous evolution. avocode does not reproduce this domain
result. It reproduces the harness.

### Chetlur et al., *cuDNN* — `chetlur2014cudnn`

NVIDIA's library of tuned deep-learning primitives. **Relation.** AVO's second baseline.

### Ouyang et al., *KernelBench* — `ouyang2025kernelbench`

250 PyTorch workloads. The model must write faster CUDA kernels. It reports `fast_p`, the share of
kernels that are both correct and faster than a threshold. **Relation.** KernelBench is the
standard LLM-kernel benchmark. Its "correct and fast" metric has the same shape as avocode's `f`
(`correct` gate, then `primary`). Its loopholes led to robust-kbench (§4).

### Baronio et al., *Kevin* — `baronio2025kevin`

Kevin is a model trained with multi-turn RL to write and refine CUDA kernels from execution
feedback. **Relation.** It puts the iterative refinement loop into the weights. AVO and avocode put
it into the harness.

### Li et al., *CUDA-L1* — `li2025cudal1`

Contrastive RL for CUDA optimization. The model sees pairs of kernels with their speedups. The
paper also discusses reward hacking it found during training. **Relation.** The same integrity
lessons as §4.

### Dai et al., *CUDA Agent* — `dai2026cudaagent`

Large-scale agentic RL with a skill-augmented CUDA development environment and automatic
profiling. It beats `torch.compile` on most KernelBench levels. **Relation.** A trained agent
could be AVO's operator. avocode is agnostic to which agent is used.

### Lin et al., *SOL-ExecBench* — `lin2026solexecbench`

235 kernel problems from production models on Blackwell. It scores kernels against analytic
speed-of-light bounds, not against software baselines. **Relation.** It answers "how far is the
hardware limit?" avocode's `f` could report the speed-of-light fraction as `primary`, so that
progress has an absolute scale.

### Mankowitz et al., *AlphaDev* — `mankowitz2023alphadev`

Deep RL found faster sorting routines at assembly level, and they went into LLVM libc++.
**Relation.** An earlier, non-LLM case of machine-discovered low-level code. Fitness is measured
latency, as in AVO.

---

## 6. Memory and knowledge

### Lewis et al., *Retrieval-Augmented Generation*; Gao et al., *RAG survey* — `lewis2020rag`, `gao2023ragsurvey`

RAG joins a retriever and a generator, so the model can use external documents at inference
time. The survey covers naive, advanced and modular RAG, and hybrid retrieval with reranking.
**Relation.** AVO's `K` (CUDA and PTX docs, hardware specs) is a RAG corpus for the agent. avocode
puts `K` in `knowledge/` and indexes it with qmd (BM25, vectors and rerank, as in the survey).
Any ingested page keeps its source.

### Packer et al., *MemGPT* — `packer2023memgpt`

MemGPT manages memory tiers like an operating system. The agent moves facts between its context
and external storage. **Relation.** avocode does not page memory automatically. It gives the agent
explicit commands (`avo mem prime`, `avo mem add`, `avo know query`) and lets the agent decide.

### Park et al., *Generative Agents* — `park2023generativeagents`

Agents keep a memory stream. They retrieve by recency, importance and relevance, and they write
reflections. **Relation.** It is an early design for long-lived agent memory. avocode's memory
holds fewer, more structured items (insights and dead ends).

### Wang et al., *Voyager* — `wang2023voyager`

A Minecraft agent with an automatic curriculum, a growing library of executable skills, and
iterative prompting with environment feedback and self-verification. **Relation.** Voyager's skill
library stores *how to act*. avocode has two matches. Its skills (`.agents/skills/`) are a
hand-written library of procedures. Its lineage is a library of verified code, and the agent can
search it.

### Zhang et al., *Agentic Context Engineering* (ACE) — `zhang2025ace`

ACE treats the context as a playbook that grows. Generation, reflection and curation add small
updates, so the agent avoids "context collapse" from repeated rewriting. **Relation.** avocode's
memory works the same way. It only appends, and it never rewrites the lineage.

### Abaskohi et al., *SEDIMA* — `abaskohi2026sedima`

A persistent memory of insights for evolutionary search agents. It turns traces into
natural-language insights, clusters them, and retrieves them to guide later mutations across runs.
It gives about 5–7% better final scores. **Relation.** This is the closest published match to
`avo mem`. Both say that memoryless evolution "rediscovers the same improvements and re-encounters
the same dead ends". avocode also searches the lineage and the memory with the same query.

### Lütke, *qmd* — `lutke2025qmd`

qmd is a local search engine for markdown. It joins BM25, vector search and LLM reranking with
reciprocal rank fusion, and it runs local GGUF models. **Relation.** It is avocode's `K` index.
`knowledge/` and `lineage/` are qmd collections. Without qmd, avocode does a local file scan and
returns the same JSON.

---

## 7. Tooling

| Tool | Role in avocode | Key |
|------|-----------------|-----|
| pi | reference agent; native extensions and in-session supervisor | `zechner2025pi` |
| Claude Code | supported agent (headless `claude -p`) | `anthropic2025claudecode` |
| Codex CLI | supported agent (`codex exec`) | `openai2025codexcli` |
| beads (`bd`) | memory and task tracking; falls back to `lineage/memory.jsonl` | `yegge2025beads` |
| qmd | hybrid search over `knowledge/` and `lineage/` | `lutke2025qmd` |
| hyperfine | timing in the wall-clock scorer template | `peter2018hyperfine` |
| Agent Skills | the portable format of `.agents/skills/*/SKILL.md` | `agentskills2025spec` |
| ARC-AGI-3 | the `arcagi3` bench target | `arcprize2026arcagi3`, `arcprize2026arcagi3web` |
| Qwen3 | in the AVO paper's experiments (§4.1); avocode does not use it | `yang2025qwen3` |

- **beads** (`gastownhall/beads`, formerly `steveyegge/beads`) is an issue tracker for coding
  agents that lives in the repo. It has dependency links and JSON output. avocode uses it as the
  memory store for `avo mem` and for task state.
- **hyperfine** (David Peter) benchmarks shell commands. It does warm-up runs and reports
  statistics. `avo score --init hyperfine` scaffolds a scorer from it.

---

## 8. Where avocode sits

| Axis | FunSearch / AlphaEvolve / OpenEvolve / ShinkaEvolve | AVO | avocode |
|------|------|-----|---------|
| Operator | one LLM call in a fixed pipeline | autonomous agent loop | any coding agent (pi, Claude Code, Codex) |
| Selection | population, islands, MAP-Elites | single lineage, keep if better | single lineage; dominate-or-tie over a score vector with a noise floor |
| Diversity | archive / islands | agent reads the lineage | agent + `avo fan` probes on small models + supervisor |
| Evaluator | executable, fixed | correctness + TFLOPS | `.avo/score` contract; `correct` gates; always exits 0 |
| Memory | program database | lineage + `K` | git lineage + qmd-indexed `K` + beads dead-end memory |
| Integrity | sandboxed evaluator | not discussed in detail | only `avo commit` writes; `f` must not be edited; hash gate + external audit; no-measuring-less rule |
| Domain | maths, algorithms, kernels | attention kernels on B200 | domain-agnostic harness; benches include fuzzy search and ARC-AGI-3 |

---

## Consolidated BibTeX

The same entries are in [`references.bib`](references.bib).

```bibtex
% references.bib — related work for the avocode article.
% arXiv entries: metadata pulled from the arXiv API (export.arxiv.org), 2026-10-14.
% DOI entries: checked against Crossref. Web and software entries: URL checked.

% ---- Journal articles and books (verified via Crossref / Open Library) ----

@article{romeraparedes2024funsearch,
  title   = {Mathematical discoveries from program search with large language models},
  author  = {Romera-Paredes, Bernardino and Barekatain, Mohammadamin and Novikov, Alexander and Balog, Matej and Kumar, M. Pawan and Dupont, Emilien and Ruiz, Francisco J. R. and Ellenberg, Jordan S. and Wang, Pengming and Fawzi, Omar and Kohli, Pushmeet and Fawzi, Alhussein},
  journal = {Nature},
  volume  = {625},
  number  = {7995},
  pages   = {468--475},
  year    = {2024},
  doi     = {10.1038/s41586-023-06924-6}
}

@article{oneill2010openissues,
  title   = {Open issues in genetic programming},
  author  = {O'Neill, Michael and Vanneschi, Leonardo and Gustafson, Steven and Banzhaf, Wolfgang},
  journal = {Genetic Programming and Evolvable Machines},
  volume  = {11},
  number  = {3--4},
  pages   = {339--363},
  year    = {2010},
  doi     = {10.1007/s10710-010-9113-2}
}

@article{silver2016alphago,
  title   = {Mastering the game of {Go} with deep neural networks and tree search},
  author  = {Silver, David and Huang, Aja and Maddison, Chris J. and Guez, Arthur and Sifre, Laurent and van den Driessche, George and Schrittwieser, Julian and Antonoglou, Ioannis and Panneershelvam, Veda and Lanctot, Marc and others},
  journal = {Nature},
  volume  = {529},
  number  = {7587},
  pages   = {484--489},
  year    = {2016},
  doi     = {10.1038/nature16961}
}

@article{droste2002oneplusone,
  title   = {On the analysis of the (1+1) evolutionary algorithm},
  author  = {Droste, Stefan and Jansen, Thomas and Wegener, Ingo},
  journal = {Theoretical Computer Science},
  volume  = {276},
  number  = {1--2},
  pages   = {51--81},
  year    = {2002},
  doi     = {10.1016/S0304-3975(01)00182-7}
}

@article{lehman2011novelty,
  title   = {Abandoning Objectives: Evolution Through the Search for Novelty Alone},
  author  = {Lehman, Joel and Stanley, Kenneth O.},
  journal = {Evolutionary Computation},
  volume  = {19},
  number  = {2},
  pages   = {189--223},
  year    = {2011},
  doi     = {10.1162/EVCO_a_00025}
}

@article{mankowitz2023alphadev,
  title   = {Faster sorting algorithms discovered using deep reinforcement learning},
  author  = {Mankowitz, Daniel J. and Michi, Andrea and Zhernov, Anton and Gelmi, Marco and Selvi, Marco and Paduraru, Cosmin and others},
  journal = {Nature},
  volume  = {618},
  number  = {7964},
  pages   = {257--263},
  year    = {2023},
  doi     = {10.1038/s41586-023-06004-9}
}

@book{back1997handbook,
  title     = {Handbook of Evolutionary Computation},
  editor    = {B{\"a}ck, Thomas and Fogel, David B. and Michalewicz, Zbigniew},
  publisher = {IOP Publishing and Oxford University Press},
  year      = {1997},
  doi       = {10.1201/9781420050387}
}

@book{holland1992adaptation,
  title     = {Adaptation in Natural and Artificial Systems},
  author    = {Holland, John H.},
  publisher = {MIT Press},
  year      = {1992},
  note      = {First published 1975 by University of Michigan Press},
  doi       = {10.7551/mitpress/1090.001.0001}
}

@book{koza1992gp,
  title     = {Genetic Programming: On the Programming of Computers by Means of Natural Selection},
  author    = {Koza, John R.},
  publisher = {MIT Press},
  address   = {Cambridge, MA},
  year      = {1992},
  isbn      = {978-0-262-11170-6}
}

@book{russell2020aima,
  title     = {Artificial Intelligence: A Modern Approach},
  author    = {Russell, Stuart and Norvig, Peter},
  edition   = {4th},
  publisher = {Pearson},
  year      = {2020},
  isbn      = {978-0-13-461099-3}
}

@article{meyerson2024lmx,
  title   = {Language Model Crossover: Variation through Few-Shot Prompting},
  author  = {Meyerson, Elliot and Nelson, Mark J. and Bradley, Herbie and Gaier, Adam and Moradi, Arash and Hoover, Amy K. and Lehman, Joel},
  journal = {ACM Transactions on Evolutionary Learning and Optimization},
  volume  = {4},
  number  = {4},
  pages   = {1--40},
  year    = {2024},
  doi     = {10.1145/3694791}
}

% ---- Web reports, blog posts and software (URLs checked 2026-10-14) ----

@misc{krakovna2020specgaming,
  title        = {Specification gaming: the flip side of {AI} ingenuity},
  author       = {Krakovna, Victoria and Uesato, Jonathan and Mikulik, Vladimir and Rahtz, Matthew and Everitt, Tom and Kumar, Ramana and Kenton, Zac and Leike, Jan and Legg, Shane},
  howpublished = {Google DeepMind blog},
  year         = {2020},
  url          = {https://deepmind.google/discover/blog/specification-gaming-the-flip-side-of-ai-ingenuity/}
}

@misc{metr2025rewardhacking,
  title        = {Recent Frontier Models Are Reward Hacking},
  author       = {{METR}},
  howpublished = {METR blog},
  year         = {2025},
  month        = jun,
  url          = {https://metr.org/blog/2025-06-05-recent-reward-hacking}
}

@misc{lange2025aicudaengineer,
  title        = {The {AI} {CUDA} Engineer: Agentic {CUDA} Kernel Discovery, Optimization and Composition},
  author       = {Lange, Robert Tjarko and Prasad, Aaditya and Sun, Qi and Faldor, Maxence and Tang, Yujin and Ha, David},
  howpublished = {Sakana AI technical report},
  year         = {2025},
  url          = {https://pub.sakana.ai/ai-cuda-engineer}
}

@misc{sharma2025openevolve,
  title        = {{OpenEvolve}: an open-source evolutionary coding agent},
  author       = {Sharma, Asankhaya},
  year         = {2025},
  howpublished = {GitHub repository},
  url          = {https://github.com/algorithmicsuperintelligence/openevolve}
}

@misc{karpathy2026autoresearch,
  title        = {autoresearch: {AI} agents running research on single-{GPU} nanochat training automatically},
  author       = {Karpathy, Andrej},
  year         = {2026},
  howpublished = {GitHub repository},
  url          = {https://github.com/karpathy/autoresearch}
}

@misc{anthropic2025claude37,
  title        = {Claude 3.7 Sonnet and Claude Code},
  author       = {{Anthropic}},
  year         = {2025},
  howpublished = {Anthropic announcement},
  url          = {https://www.anthropic.com/news/claude-3-7-sonnet}
}

@misc{anthropic2025claudecode,
  title        = {Claude Code},
  author       = {{Anthropic}},
  year         = {2025},
  howpublished = {Software and documentation},
  url          = {https://code.claude.com/docs/en/overview}
}

% UNVERIFIED: URL taken from the AVO paper; returns HTTP 403 to scripts.
@misc{openai2025codex,
  title        = {Introducing {Codex}},
  author       = {{OpenAI}},
  year         = {2025},
  howpublished = {OpenAI announcement},
  url          = {https://openai.com/index/introducing-codex/}
}

@misc{openai2025codexcli,
  title        = {Codex {CLI}: a lightweight coding agent that runs in your terminal},
  author       = {{OpenAI}},
  year         = {2025},
  howpublished = {GitHub repository},
  url          = {https://github.com/openai/codex}
}

@misc{zechner2025pi,
  title        = {pi: {AI} agent toolkit: unified {LLM} {API}, agent loop, {TUI}, coding agent {CLI}},
  author       = {Zechner, Mario},
  year         = {2025},
  howpublished = {GitHub repository and \url{https://pi.dev}},
  url          = {https://github.com/earendil-works/pi}
}

@misc{yegge2025beads,
  title        = {Beads: a memory upgrade for your coding agent},
  author       = {Yegge, Steve},
  year         = {2025},
  howpublished = {GitHub repository},
  url          = {https://github.com/gastownhall/beads}
}

@misc{lutke2025qmd,
  title        = {qmd: mini {CLI} search engine for your docs, knowledge bases, meeting notes, whatever},
  author       = {L{\"u}tke, Tobi},
  year         = {2025},
  howpublished = {GitHub repository},
  url          = {https://github.com/tobi/qmd}
}

@misc{peter2018hyperfine,
  title        = {hyperfine: a command-line benchmarking tool},
  author       = {Peter, David},
  year         = {2018},
  howpublished = {GitHub repository},
  url          = {https://github.com/sharkdp/hyperfine}
}

@misc{agentskills2025spec,
  title        = {Agent Skills Specification},
  author       = {{Agent Skills}},
  year         = {2025},
  howpublished = {Web specification},
  url          = {https://agentskills.io/specification}
}

@misc{arcprize2026arcagi3web,
  title        = {{ARC-AGI-3}},
  author       = {{ARC Prize Foundation}},
  year         = {2026},
  howpublished = {Benchmark website},
  url          = {https://arcprize.org/arc-agi/3}
}

% ---- arXiv preprints (verified via arXiv API) ----

@misc{abaskohi2026sedima,
  title         = {{SEDIMA: Cross-Run Hierarchical Insight Memory for Evolutionary Search Agents}},
  author        = {Amirhossein Abaskohi and Mahdi Mostajabdaveh and Zirui Zhou},
  year          = {2026},
  eprint        = {2610.02361},
  archivePrefix = {arXiv},
  primaryClass  = {cs.NE},
  url           = {https://arxiv.org/abs/2610.02361}
}

@misc{agrawal2025gepa,
  title         = {{GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning}},
  author        = {Lakshya A Agrawal and Shangyin Tan and Dilara Soylu and Noah Ziems and Rishi Khare and Krista Opsahl-Ong and Arnav Singhvi and Herumb Shandilya and Michael J Ryan and Meng Jiang and Christopher Potts and Koushik Sen and Alexandros G. Dimakis and Ion Stoica and Dan Klein and Matei Zaharia and Omar Khattab},
  year          = {2025},
  eprint        = {2507.19457},
  archivePrefix = {arXiv},
  primaryClass  = {cs.CL},
  url           = {https://arxiv.org/abs/2507.19457}
}

@misc{amodei2016concrete,
  title         = {{Concrete Problems in AI Safety}},
  author        = {Dario Amodei and Chris Olah and Jacob Steinhardt and Paul Christiano and John Schulman and Dan Mané},
  year          = {2016},
  eprint        = {1606.06565},
  archivePrefix = {arXiv},
  primaryClass  = {cs.AI},
  url           = {https://arxiv.org/abs/1606.06565}
}

@misc{arcprize2026arcagi3,
  title         = {{ARC-AGI-3: A New Challenge for Frontier Agentic Intelligence}},
  author        = {{ARC Prize Foundation}},
  year          = {2026},
  eprint        = {2603.24621},
  archivePrefix = {arXiv},
  primaryClass  = {cs.AI},
  url           = {https://arxiv.org/abs/2603.24621}
}

@misc{assumpcao2025codeevolve,
  title         = {{CodeEvolve: an open source evolutionary coding agent for algorithmic discovery and optimization}},
  author        = {Henrique Assumpção and Diego Ferreira and Leandro Campos and Fabricio Murai},
  year          = {2025},
  eprint        = {2510.14150},
  archivePrefix = {arXiv},
  primaryClass  = {cs.AI},
  url           = {https://arxiv.org/abs/2510.14150}
}

@misc{baker2025monitoring,
  title         = {{Monitoring Reasoning Models for Misbehavior and the Risks of Promoting Obfuscation}},
  author        = {Bowen Baker and Joost Huizinga and Leo Gao and Zehao Dou and Melody Y. Guan and Aleksander Madry and Wojciech Zaremba and Jakub Pachocki and David Farhi},
  year          = {2025},
  eprint        = {2503.11926},
  archivePrefix = {arXiv},
  primaryClass  = {cs.AI},
  url           = {https://arxiv.org/abs/2503.11926}
}

@misc{baronio2025kevin,
  title         = {{Kevin: Multi-Turn RL for Generating CUDA Kernels}},
  author        = {Carlo Baronio and Pietro Marsella and Ben Pan and Simon Guo and Silas Alberti},
  year          = {2025},
  eprint        = {2507.11948},
  archivePrefix = {arXiv},
  primaryClass  = {cs.LG},
  url           = {https://arxiv.org/abs/2507.11948}
}

@misc{chan2025mlebench,
  title         = {{MLE-bench: Evaluating Machine Learning Agents on Machine Learning Engineering}},
  author        = {Jun Shern Chan and Neil Chowdhury and Oliver Jaffe and James Aung and Dane Sherburn and Evan Mays and Giulio Starace and Kevin Liu and Leon Maksin and Tejal Patwardhan and Lilian Weng and Aleksander Mądry},
  year          = {2024},
  eprint        = {2410.07095},
  archivePrefix = {arXiv},
  primaryClass  = {cs.CL},
  url           = {https://arxiv.org/abs/2410.07095}
}

@misc{chen2021codex,
  title         = {{Evaluating Large Language Models Trained on Code}},
  author        = {Mark Chen and Jerry Tworek and Heewoo Jun and Qiming Yuan and Henrique Ponde de Oliveira Pinto and Jared Kaplan and Harri Edwards and Yuri Burda and Nicholas Joseph and Greg Brockman and others},
  year          = {2021},
  eprint        = {2107.03374},
  archivePrefix = {arXiv},
  primaryClass  = {cs.LG},
  url           = {https://arxiv.org/abs/2107.03374}
}

@misc{chen2023evoprompting,
  title         = {{EvoPrompting: Language Models for Code-Level Neural Architecture Search}},
  author        = {Angelica Chen and David M. Dohan and David R. So},
  year          = {2023},
  eprint        = {2302.14838},
  archivePrefix = {arXiv},
  primaryClass  = {cs.NE},
  url           = {https://arxiv.org/abs/2302.14838}
}

@misc{chen2026avo,
  title         = {{AVO: Agentic Variation Operators for Autonomous Evolutionary Search}},
  author        = {Terry Chen and Zhifan Ye and Bing Xu and Zihao Ye and Timmy Liu and Ali Hassani and Tianqi Chen and Andrew Kerr and Haicheng Wu and Yang Xu and Yu-Jung Chen and Hanfeng Chen and Aditya Kane and Ronny Krashinsky and Ming-Yu Liu and Vinod Grover and Luis Ceze and Roger Bringmann and John Tran and Wei Liu and Fung Xie and Michael Lightstone and Humphrey Shi},
  year          = {2026},
  eprint        = {2603.24517},
  archivePrefix = {arXiv},
  primaryClass  = {cs.LG},
  url           = {https://arxiv.org/abs/2603.24517}
}

@misc{chetlur2014cudnn,
  title         = {{cuDNN: Efficient Primitives for Deep Learning}},
  author        = {Sharan Chetlur and Cliff Woolley and Philippe Vandermersch and Jonathan Cohen and John Tran and Bryan Catanzaro and Evan Shelhamer},
  year          = {2014},
  eprint        = {1410.0759},
  archivePrefix = {arXiv},
  primaryClass  = {cs.NE},
  url           = {https://arxiv.org/abs/1410.0759}
}

@misc{chollet2019measure,
  title         = {{On the Measure of Intelligence}},
  author        = {François Chollet},
  year          = {2019},
  eprint        = {1911.01547},
  archivePrefix = {arXiv},
  primaryClass  = {cs.AI},
  url           = {https://arxiv.org/abs/1911.01547}
}

@misc{chun2026wastedcompute,
  title         = {{Recovering Wasted Compute in Autoresearch Agents}},
  author        = {Au Kwok Chun and Abhigyan Acherjee and Amrutha Rao and Zaiqian Chen and Kazem Meidani and C. Bayan Bruss and Micah Goldblum},
  year          = {2026},
  eprint        = {2608.10424},
  archivePrefix = {arXiv},
  primaryClass  = {cs.AI},
  url           = {https://arxiv.org/abs/2608.10424}
}

@misc{dai2026cudaagent,
  title         = {{CUDA Agent: Large-Scale Agentic RL for High-Performance CUDA Kernel Generation}},
  author        = {Weinan Dai and Hanlin Wu and Qiying Yu and Huan-ang Gao and Jiahao Li and Chengquan Jiang and Weiqiang Lou and Yufan Song and Hongli Yu and Jiaze Chen and Wei-Ying Ma and Ya-Qin Zhang and Jingjing Liu and Mingxuan Wang and Xin Liu and Hao Zhou},
  year          = {2026},
  eprint        = {2602.24286},
  archivePrefix = {arXiv},
  primaryClass  = {cs.LG},
  url           = {https://arxiv.org/abs/2602.24286}
}

@misc{dao2022flashattention,
  title         = {{FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness}},
  author        = {Tri Dao and Daniel Y. Fu and Stefano Ermon and Atri Rudra and Christopher Ré},
  year          = {2022},
  eprint        = {2205.14135},
  archivePrefix = {arXiv},
  primaryClass  = {cs.LG},
  url           = {https://arxiv.org/abs/2205.14135}
}

@misc{dao2023flashattention2,
  title         = {{FlashAttention-2: Faster Attention with Better Parallelism and Work Partitioning}},
  author        = {Tri Dao},
  year          = {2023},
  eprint        = {2307.08691},
  archivePrefix = {arXiv},
  primaryClass  = {cs.LG},
  url           = {https://arxiv.org/abs/2307.08691}
}

@misc{fernando2023promptbreeder,
  title         = {{Promptbreeder: Self-Referential Self-Improvement Via Prompt Evolution}},
  author        = {Chrisantha Fernando and Dylan Banarse and Henryk Michalewski and Simon Osindero and Tim Rocktäschel},
  year          = {2023},
  eprint        = {2309.16797},
  archivePrefix = {arXiv},
  primaryClass  = {cs.CL},
  url           = {https://arxiv.org/abs/2309.16797}
}

@misc{gao2023ragsurvey,
  title         = {{Retrieval-Augmented Generation for Large Language Models: A Survey}},
  author        = {Yunfan Gao and Yun Xiong and Xinyu Gao and Kangxiang Jia and Jinliu Pan and Yuxi Bi and Yi Dai and Jiawei Sun and Meng Wang and Haofen Wang},
  year          = {2023},
  eprint        = {2312.10997},
  archivePrefix = {arXiv},
  primaryClass  = {cs.CL},
  url           = {https://arxiv.org/abs/2312.10997}
}

@misc{georgiev2025mathexploration,
  title         = {{Mathematical exploration and discovery at scale}},
  author        = {Bogdan Georgiev and Javier Gómez-Serrano and Terence Tao and Adam Zsolt Wagner},
  year          = {2025},
  eprint        = {2511.02864},
  archivePrefix = {arXiv},
  primaryClass  = {cs.NE},
  url           = {https://arxiv.org/abs/2511.02864}
}

@misc{guo2023evoprompt,
  title         = {{EvoPrompt: Connecting LLMs with Evolutionary Algorithms Yields Powerful Prompt Optimizers}},
  author        = {Qingyan Guo and Rui Wang and Junliang Guo and Bei Li and Kaitao Song and Xu Tan and Guoqing Liu and Jiang Bian and Yujiu Yang},
  year          = {2023},
  eprint        = {2309.08532},
  archivePrefix = {arXiv},
  primaryClass  = {cs.CL},
  url           = {https://arxiv.org/abs/2309.08532}
}

@misc{hu2025adas,
  title         = {{Automated Design of Agentic Systems}},
  author        = {Shengran Hu and Cong Lu and Jeff Clune},
  year          = {2024},
  eprint        = {2408.08435},
  archivePrefix = {arXiv},
  primaryClass  = {cs.AI},
  url           = {https://arxiv.org/abs/2408.08435}
}

@misc{jiang2025aide,
  title         = {{AIDE: AI-Driven Exploration in the Space of Code}},
  author        = {Zhengyao Jiang and Dominik Schmidt and Dhruv Srikanth and Dixing Xu and Ian Kaplan and Deniss Jacenko and Yuxiang Wu},
  year          = {2025},
  eprint        = {2502.13138},
  archivePrefix = {arXiv},
  primaryClass  = {cs.AI},
  url           = {https://arxiv.org/abs/2502.13138}
}

@misc{jimenez2024swebench,
  title         = {{SWE-bench: Can Language Models Resolve Real-World GitHub Issues?}},
  author        = {Carlos E. Jimenez and John Yang and Alexander Wettig and Shunyu Yao and Kexin Pei and Ofir Press and Karthik Narasimhan},
  year          = {2023},
  eprint        = {2310.06770},
  archivePrefix = {arXiv},
  primaryClass  = {cs.CL},
  url           = {https://arxiv.org/abs/2310.06770}
}

@misc{lange2025robustkbench,
  title         = {{Towards Robust Agentic CUDA Kernel Benchmarking, Verification, and Optimization}},
  author        = {Robert Tjarko Lange and Qi Sun and Aaditya Prasad and Maxence Faldor and Yujin Tang and David Ha},
  year          = {2025},
  eprint        = {2509.14279},
  archivePrefix = {arXiv},
  primaryClass  = {cs.SE},
  url           = {https://arxiv.org/abs/2509.14279}
}

@misc{lange2025shinkaevolve,
  title         = {{ShinkaEvolve: Towards Open-Ended And Sample-Efficient Program Evolution}},
  author        = {Robert Tjarko Lange and Yuki Imajuku and Edoardo Cetin},
  year          = {2025},
  eprint        = {2509.19349},
  archivePrefix = {arXiv},
  primaryClass  = {cs.CL},
  url           = {https://arxiv.org/abs/2509.19349}
}

@misc{lehman2020surprising,
  title         = {{The Surprising Creativity of Digital Evolution: A Collection of Anecdotes from the Evolutionary Computation and Artificial Life Research Communities}},
  author        = {Joel Lehman and Jeff Clune and Dusan Misevic and Christoph Adami and Lee Altenberg and Julie Beaulieu and Peter J. Bentley and Samuel Bernard and Guillaume Beslon and David M. Bryson and others},
  year          = {2018},
  eprint        = {1803.03453},
  archivePrefix = {arXiv},
  primaryClass  = {cs.NE},
  url           = {https://arxiv.org/abs/1803.03453}
}

@misc{lehman2022elm,
  title         = {{Evolution through Large Models}},
  author        = {Joel Lehman and Jonathan Gordon and Shawn Jain and Kamal Ndousse and Cathy Yeh and Kenneth O. Stanley},
  year          = {2022},
  eprint        = {2206.08896},
  archivePrefix = {arXiv},
  primaryClass  = {cs.NE},
  url           = {https://arxiv.org/abs/2206.08896}
}

@misc{lewis2020rag,
  title         = {{Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks}},
  author        = {Patrick Lewis and Ethan Perez and Aleksandra Piktus and Fabio Petroni and Vladimir Karpukhin and Naman Goyal and Heinrich Küttler and Mike Lewis and Wen-tau Yih and Tim Rocktäschel and Sebastian Riedel and Douwe Kiela},
  year          = {2020},
  eprint        = {2005.11401},
  archivePrefix = {arXiv},
  primaryClass  = {cs.CL},
  url           = {https://arxiv.org/abs/2005.11401}
}

@misc{li2025cudal1,
  title         = {{CUDA-L1: Improving CUDA Optimization via Contrastive Reinforcement Learning}},
  author        = {Xiaoya Li and Albert Wang and Guoyin Wang and Jiwei Li and Chris Shum},
  year          = {2025},
  eprint        = {2507.14111},
  archivePrefix = {arXiv},
  primaryClass  = {cs.AI},
  url           = {https://arxiv.org/abs/2507.14111}
}

@misc{lin2026solexecbench,
  title         = {{SOL-ExecBench: Speed-of-Light Benchmarking for Real-World GPU Kernels Against Hardware Limits}},
  author        = {Edward Lin and Sahil Modi and Siva Kumar Sastry Hari and Qijing Huang and Zhifan Ye and Nestor Qin and Fengzhe Zhou and Yuan Zhang and Jingquan Wang and Sana Damani and others},
  year          = {2026},
  eprint        = {2603.19173},
  archivePrefix = {arXiv},
  primaryClass  = {cs.LG},
  url           = {https://arxiv.org/abs/2603.19173}
}

@misc{lu2024aiscientist,
  title         = {{The AI Scientist: Towards Fully Automated Open-Ended Scientific Discovery}},
  author        = {Chris Lu and Cong Lu and Robert Tjarko Lange and Jakob Foerster and Jeff Clune and David Ha},
  year          = {2024},
  eprint        = {2408.06292},
  archivePrefix = {arXiv},
  primaryClass  = {cs.AI},
  url           = {https://arxiv.org/abs/2408.06292}
}

@misc{ma2024eureka,
  title         = {{Eureka: Human-Level Reward Design via Coding Large Language Models}},
  author        = {Yecheng Jason Ma and William Liang and Guanzhi Wang and De-An Huang and Osbert Bastani and Dinesh Jayaraman and Yuke Zhu and Linxi Fan and Anima Anandkumar},
  year          = {2023},
  eprint        = {2310.12931},
  archivePrefix = {arXiv},
  primaryClass  = {cs.RO},
  url           = {https://arxiv.org/abs/2310.12931}
}

@misc{madaan2023selfrefine,
  title         = {{Self-Refine: Iterative Refinement with Self-Feedback}},
  author        = {Aman Madaan and Niket Tandon and Prakhar Gupta and Skyler Hallinan and Luyu Gao and Sarah Wiegreffe and Uri Alon and Nouha Dziri and Shrimai Prabhumoye and Yiming Yang and Shashank Gupta and Bodhisattwa Prasad Majumder and Katherine Hermann and Sean Welleck and Amir Yazdanbakhsh and Peter Clark},
  year          = {2023},
  eprint        = {2303.17651},
  archivePrefix = {arXiv},
  primaryClass  = {cs.CL},
  url           = {https://arxiv.org/abs/2303.17651}
}

@misc{manheim2018goodhart,
  title         = {{Categorizing Variants of Goodhart's Law}},
  author        = {David Manheim and Scott Garrabrant},
  year          = {2018},
  eprint        = {1803.04585},
  archivePrefix = {arXiv},
  primaryClass  = {cs.AI},
  url           = {https://arxiv.org/abs/1803.04585}
}

@misc{mouret2015mapelites,
  title         = {{Illuminating search spaces by mapping elites}},
  author        = {Jean-Baptiste Mouret and Jeff Clune},
  year          = {2015},
  eprint        = {1504.04909},
  archivePrefix = {arXiv},
  primaryClass  = {cs.AI},
  url           = {https://arxiv.org/abs/1504.04909}
}

@misc{novikov2025alphaevolve,
  title         = {{AlphaEvolve: A coding agent for scientific and algorithmic discovery}},
  author        = {Alexander Novikov and Ngân Vũ and Marvin Eisenberger and Emilien Dupont and Po-Sen Huang and Adam Zsolt Wagner and Sergey Shirobokov and Borislav Kozlovskii and Francisco J. R. Ruiz and Abbas Mehrabian and M. Pawan Kumar and Abigail See and Swarat Chaudhuri and George Holland and Alex Davies and Sebastian Nowozin and Pushmeet Kohli and Matej Balog},
  year          = {2025},
  eprint        = {2506.13131},
  archivePrefix = {arXiv},
  primaryClass  = {cs.AI},
  url           = {https://arxiv.org/abs/2506.13131}
}

@misc{ouyang2025kernelbench,
  title         = {{KernelBench: Can LLMs Write Efficient GPU Kernels?}},
  author        = {Anne Ouyang and Simon Guo and Simran Arora and Alex L. Zhang and William Hu and Christopher Ré and Azalia Mirhoseini},
  year          = {2025},
  eprint        = {2502.10517},
  archivePrefix = {arXiv},
  primaryClass  = {cs.LG},
  url           = {https://arxiv.org/abs/2502.10517}
}

@misc{packer2023memgpt,
  title         = {{MemGPT: Towards LLMs as Operating Systems}},
  author        = {Charles Packer and Sarah Wooders and Kevin Lin and Vivian Fang and Shishir G. Patil and Ion Stoica and Joseph E. Gonzalez},
  year          = {2023},
  eprint        = {2310.08560},
  archivePrefix = {arXiv},
  primaryClass  = {cs.AI},
  url           = {https://arxiv.org/abs/2310.08560}
}

@misc{park2023generativeagents,
  title         = {{Generative Agents: Interactive Simulacra of Human Behavior}},
  author        = {Joon Sung Park and Joseph C. O'Brien and Carrie J. Cai and Meredith Ringel Morris and Percy Liang and Michael S. Bernstein},
  year          = {2023},
  eprint        = {2304.03442},
  archivePrefix = {arXiv},
  primaryClass  = {cs.HC},
  url           = {https://arxiv.org/abs/2304.03442}
}

@misc{qu2026bilevel,
  title         = {{Bilevel Autoresearch: Meta-Autoresearching Itself}},
  author        = {Yaonan Qu and Meng Lu},
  year          = {2026},
  eprint        = {2603.23420},
  archivePrefix = {arXiv},
  primaryClass  = {cs.AI},
  url           = {https://arxiv.org/abs/2603.23420}
}

@misc{schmidgall2025agentlab,
  title         = {{Agent Laboratory: Using LLM Agents as Research Assistants}},
  author        = {Samuel Schmidgall and Yusheng Su and Ze Wang and Ximeng Sun and Jialian Wu and Xiaodong Yu and Jiang Liu and Michael Moor and Zicheng Liu and Emad Barsoum},
  year          = {2025},
  eprint        = {2501.04227},
  archivePrefix = {arXiv},
  primaryClass  = {cs.HC},
  url           = {https://arxiv.org/abs/2501.04227}
}

@misc{shah2024flashattention3,
  title         = {{FlashAttention-3: Fast and Accurate Attention with Asynchrony and Low-precision}},
  author        = {Jay Shah and Ganesh Bikshandi and Ying Zhang and Vijay Thakkar and Pradeep Ramani and Tri Dao},
  year          = {2024},
  eprint        = {2407.08608},
  archivePrefix = {arXiv},
  primaryClass  = {cs.LG},
  url           = {https://arxiv.org/abs/2407.08608}
}

@misc{shinn2023reflexion,
  title         = {{Reflexion: Language Agents with Verbal Reinforcement Learning}},
  author        = {Noah Shinn and Federico Cassano and Edward Berman and Ashwin Gopinath and Karthik Narasimhan and Shunyu Yao},
  year          = {2023},
  eprint        = {2303.11366},
  archivePrefix = {arXiv},
  primaryClass  = {cs.AI},
  url           = {https://arxiv.org/abs/2303.11366}
}

@misc{suwandi2026kernaut,
  title         = {{Kernel Autoresearch for Open-Ended Model Discovery}},
  author        = {Richard Cornelius Suwandi and Feng Yin and Kevin Murphy},
  year          = {2026},
  eprint        = {2610.10394},
  archivePrefix = {arXiv},
  primaryClass  = {cs.LG},
  url           = {https://arxiv.org/abs/2610.10394}
}

@misc{wan2025loongflow,
  title         = {{LoongFlow: Directed Evolutionary Search via a Cognitive Plan-Execute-Summarize Paradigm}},
  author        = {Chunhui Wan and Xunan Dai and Zhuo Wang and Minglei Li and Yanpeng Wang and Yinan Mao and Yu Lan and Zhiwen Xiao},
  year          = {2025},
  eprint        = {2512.24077},
  archivePrefix = {arXiv},
  primaryClass  = {cs.AI},
  url           = {https://arxiv.org/abs/2512.24077}
}

@misc{wang2023voyager,
  title         = {{Voyager: An Open-Ended Embodied Agent with Large Language Models}},
  author        = {Guanzhi Wang and Yuqi Xie and Yunfan Jiang and Ajay Mandlekar and Chaowei Xiao and Yuke Zhu and Linxi Fan and Anima Anandkumar},
  year          = {2023},
  eprint        = {2305.16291},
  archivePrefix = {arXiv},
  primaryClass  = {cs.AI},
  url           = {https://arxiv.org/abs/2305.16291}
}

@misc{wang2025openhands,
  title         = {{OpenHands: An Open Platform for AI Software Developers as Generalist Agents}},
  author        = {Xingyao Wang and Boxuan Li and Yufan Song and Frank F. Xu and Xiangru Tang and Mingchen Zhuge and Jiayi Pan and Yueqi Song and Bowen Li and Jaskirat Singh and Hoang H. Tran and Fuqiang Li and Ren Ma and Mingzhang Zheng and Bill Qian and Yanjun Shao and Niklas Muennighoff and Yizhe Zhang and Binyuan Hui and Junyang Lin and Robert Brennan and Hao Peng and Heng Ji and Graham Neubig},
  year          = {2024},
  eprint        = {2407.16741},
  archivePrefix = {arXiv},
  primaryClass  = {cs.SE},
  url           = {https://arxiv.org/abs/2407.16741}
}

@misc{xu2026vibetensor,
  title         = {{VibeTensor: System Software for Deep Learning, Fully Generated by AI Agents}},
  author        = {Bing Xu and Terry Chen and Fengzhe Zhou and Tianqi Chen and Yangqing Jia and Vinod Grover and Haicheng Wu and Wei Liu and Craig Wittenbrink and Wen-mei Hwu and Roger Bringmann and Ming-Yu Liu and Luis Ceze and Michael Lightstone and Humphrey Shi},
  year          = {2026},
  eprint        = {2601.16238},
  archivePrefix = {arXiv},
  primaryClass  = {cs.SE},
  url           = {https://arxiv.org/abs/2601.16238}
}

@misc{yamada2025aiscientistv2,
  title         = {{The AI Scientist-v2: Workshop-Level Automated Scientific Discovery via Agentic Tree Search}},
  author        = {Yutaro Yamada and Robert Tjarko Lange and Cong Lu and Shengran Hu and Chris Lu and Jakob Foerster and Jeff Clune and David Ha},
  year          = {2025},
  eprint        = {2504.08066},
  archivePrefix = {arXiv},
  primaryClass  = {cs.AI},
  url           = {https://arxiv.org/abs/2504.08066}
}

@misc{yan2026pacevolve,
  title         = {{PACEvolve++: Improving Test-time Learning for Evolutionary Search Agents}},
  author        = {Minghao Yan and Bo Peng and Benjamin Coleman and Ziqi Chen and Zhouhang Xie and Shuo Chen and Zhankui He and Noveen Sachdeva and Weili Wang and Ed H. Chi and Shivaram Venkataraman and Wang-Cheng Kang and Derek Zhiyuan Cheng and Beidou Wang},
  year          = {2026},
  eprint        = {2605.07039},
  archivePrefix = {arXiv},
  primaryClass  = {cs.LG},
  url           = {https://arxiv.org/abs/2605.07039}
}

@misc{yang2024opro,
  title         = {{Large Language Models as Optimizers}},
  author        = {Chengrun Yang and Xuezhi Wang and Yifeng Lu and Hanxiao Liu and Quoc V. Le and Denny Zhou and Xinyun Chen},
  year          = {2023},
  eprint        = {2309.03409},
  archivePrefix = {arXiv},
  primaryClass  = {cs.LG},
  url           = {https://arxiv.org/abs/2309.03409}
}

@misc{yang2024sweagent,
  title         = {{SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering}},
  author        = {John Yang and Carlos E. Jimenez and Alexander Wettig and Kilian Lieret and Shunyu Yao and Karthik Narasimhan and Ofir Press},
  year          = {2024},
  eprint        = {2405.15793},
  archivePrefix = {arXiv},
  primaryClass  = {cs.SE},
  url           = {https://arxiv.org/abs/2405.15793}
}

@misc{yang2025qwen3,
  title         = {{Qwen3 Technical Report}},
  author        = {An Yang and Anfeng Li and Baosong Yang and Beichen Zhang and Binyuan Hui and Bo Zheng and Bowen Yu and Chang Gao and Chengen Huang and Chenxu Lv and others},
  year          = {2025},
  eprint        = {2505.09388},
  archivePrefix = {arXiv},
  primaryClass  = {cs.CL},
  url           = {https://arxiv.org/abs/2505.09388}
}

@misc{yao2023react,
  title         = {{ReAct: Synergizing Reasoning and Acting in Language Models}},
  author        = {Shunyu Yao and Jeffrey Zhao and Dian Yu and Nan Du and Izhak Shafran and Karthik Narasimhan and Yuan Cao},
  year          = {2022},
  eprint        = {2210.03629},
  archivePrefix = {arXiv},
  primaryClass  = {cs.CL},
  url           = {https://arxiv.org/abs/2210.03629}
}

@misc{ye2024reevo,
  title         = {{ReEvo: Large Language Models as Hyper-Heuristics with Reflective Evolution}},
  author        = {Haoran Ye and Jiarui Wang and Zhiguang Cao and Federico Berto and Chuanbo Hua and Haeyeon Kim and Jinkyoo Park and Guojie Song},
  year          = {2024},
  eprint        = {2402.01145},
  archivePrefix = {arXiv},
  primaryClass  = {cs.NE},
  url           = {https://arxiv.org/abs/2402.01145}
}

@misc{yin2024godelagent,
  title         = {{Gödel Agent: A Self-Referential Agent Framework for Recursive Self-Improvement}},
  author        = {Xunjian Yin and Xinyi Wang and Liangming Pan and Li Lin and Xiaojun Wan and William Yang Wang},
  year          = {2024},
  eprint        = {2410.04444},
  archivePrefix = {arXiv},
  primaryClass  = {cs.AI},
  url           = {https://arxiv.org/abs/2410.04444}
}

@misc{yu2025alpharesearch,
  title         = {{AlphaResearch: Accelerating New Algorithm Discovery with Language Models}},
  author        = {Zhaojian Yu and Kaiyue Feng and Yilun Zhao and Shilin He and Xiao-Ping Zhang and Arman Cohan},
  year          = {2025},
  eprint        = {2511.08522},
  archivePrefix = {arXiv},
  primaryClass  = {cs.CL},
  url           = {https://arxiv.org/abs/2511.08522}
}

@misc{yuksekgonul2026ttdiscover,
  title         = {{Learning to Discover at Test Time}},
  author        = {Mert Yuksekgonul and Daniel Koceja and Xinhao Li and Federico Bianchi and Jed McCaleb and Xiaolong Wang and Jan Kautz and Yejin Choi and James Zou and Carlos Guestrin and Yu Sun},
  year          = {2026},
  eprint        = {2601.16175},
  archivePrefix = {arXiv},
  primaryClass  = {cs.LG},
  url           = {https://arxiv.org/abs/2601.16175}
}

@misc{zadouri2026flashattention4,
  title         = {{FlashAttention-4: Algorithm and Kernel Pipelining Co-Design for Asymmetric Hardware Scaling}},
  author        = {Ted Zadouri and Markus Hoehnerbach and Jay Shah and Timmy Liu and Vijay Thakkar and Tri Dao},
  year          = {2026},
  eprint        = {2603.05451},
  archivePrefix = {arXiv},
  primaryClass  = {cs.CL},
  url           = {https://arxiv.org/abs/2603.05451}
}

@misc{zelikman2023stop,
  title         = {{Self-Taught Optimizer (STOP): Recursively Self-Improving Code Generation}},
  author        = {Eric Zelikman and Eliana Lorch and Lester Mackey and Adam Tauman Kalai},
  year          = {2023},
  eprint        = {2310.02304},
  archivePrefix = {arXiv},
  primaryClass  = {cs.CL},
  url           = {https://arxiv.org/abs/2310.02304}
}

@misc{zhang2025ace,
  title         = {{Agentic Context Engineering: Evolving Contexts for Self-Improving Language Models}},
  author        = {Qizheng Zhang and Changran Hu and Shubhangi Upasani and Boyuan Ma and Fenglu Hong and Vamsidhar Kamanuru and Jay Rainton and Chen Wu and Mengmeng Ji and Hanchen Li and Urmish Thakker and James Zou and Kunle Olukotun},
  year          = {2025},
  eprint        = {2510.04618},
  archivePrefix = {arXiv},
  primaryClass  = {cs.LG},
  url           = {https://arxiv.org/abs/2510.04618}
}

@misc{zhang2025dgm,
  title         = {{Darwin Godel Machine: Open-Ended Evolution of Self-Improving Agents}},
  author        = {Jenny Zhang and Shengran Hu and Cong Lu and Robert Lange and Jeff Clune},
  year          = {2025},
  eprint        = {2505.22954},
  archivePrefix = {arXiv},
  primaryClass  = {cs.AI},
  url           = {https://arxiv.org/abs/2505.22954}
}

@misc{zhang2026agora,
  title         = {{Agora: Git as Shared Memory for Collective AutoResearch}},
  author        = {Yifan Zhang and Yunheng Zou and Shaokun Zhang and Jian Hu and Hao Zhang and Binfeng Xu and Jan Kautz and Yi Dong},
  year          = {2026},
  eprint        = {2609.18094},
  archivePrefix = {arXiv},
  primaryClass  = {cs.LG},
  url           = {https://arxiv.org/abs/2609.18094}
}

@misc{zhong2025impossiblebench,
  title         = {{ImpossibleBench: Measuring LLMs' Propensity of Exploiting Test Cases}},
  author        = {Ziqian Zhong and Aditi Raghunathan and Nicholas Carlini},
  year          = {2025},
  eprint        = {2510.20270},
  archivePrefix = {arXiv},
  primaryClass  = {cs.LG},
  url           = {https://arxiv.org/abs/2510.20270}
}

@misc{vaswani2017attention,
  title         = {{Attention Is All You Need}},
  author        = {Ashish Vaswani and Noam Shazeer and Niki Parmar and Jakob Uszkoreit and Llion Jones and Aidan N. Gomez and Lukasz Kaiser and Illia Polosukhin},
  year          = {2017},
  eprint        = {1706.03762},
  archivePrefix = {arXiv},
  primaryClass  = {cs.CL},
  url           = {https://arxiv.org/abs/1706.03762}
}
```
