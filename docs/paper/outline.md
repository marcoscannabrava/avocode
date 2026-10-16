# Paper outline

**Title:** An implementation of NVIDIA's Agentic Variation Operators (AVO) for Autonomous Evolutionary Search

**Format:** LaTeX article, two-column optional, `article` class, `amsmath`, `algorithm2e` or
`algorithmicx`, `booktabs`, `listings`, `hyperref`, `biblatex` or `natbib` with `references.bib`.

**Inputs from the research agents:**

| File | Owner | Feeds sections |
| --- | --- | --- |
| `avo-paper-notes.md` | paper agent | 2, 3 |
| `related-work.md`, `references.bib` | references agent | 2, 9 |
| `code-core.md` | core-code agent | 4, 5, 6 |
| `code-orchestration.md` | orchestration agent | 4, 7 |
| `evaluation.md` | benchmarks agent | 8, 10 |

## Brainstorm

Topics that could carry the paper, sorted by how much the code supports them.

**Strong (the repo has direct evidence):**

- The AVO formalism `Vary(P_t) = Agent(P_t, K, f)` is a *harness* claim, not a kernel claim. The
  paper's result is domain-specific; its harness is not. avocode extracts that harness.
- The commit rule as weak Pareto dominance over a score vector. The paper says "matches or
  improves"; avocode makes it strict on at least one config and adds a noise floor. This is an
  elitist (1+1)-EA with a vector acceptance test.
- Lineage vs trajectory: what persists (commits, trailers, git notes, `lineage/vNNN.md`) and what
  does not (attempt logs, worktrees). Git as the population store; no database.
- `f` as a contract: one JSON line, always exit 0, correctness as a gate (score = 0 in the paper,
  refusal in avocode). Defenses against reward hacking: protected files, "you cannot improve by
  measuring less", re-score at commit time.
- Memory of dead ends: refusals keyed by content, so a repeat attempt updates one record. Beads
  with a JSONL fallback.
- `K` as hybrid search over docs *and* the repo's own lineage (qmd: BM25 + vector + rerank).
  Provenance on ingest.
- Self-supervision made external: stall (N attempts with no gain) and thrash (K same failures).
  The directive cites prior versions and unread docs. Contrast with the paper's supervisor agent.
- Agent-agnosticism: skills as the product layer (Agent Skills standard), CLI as the only
  required interface, pi bindings as convenience. Same capability from `bash` for pi, Claude Code
  and Codex.
- `avo fan`: a bounded step toward the population branching the paper leaves as future work.
  Small model for exploration, large model for refinement. Recursion guards (depth, cycle,
  concurrency, timeout).
- Results: fuzzysearch 1810 ms to 0.231 ms (7837x) over 7 versions in two runs; run 1 alone
  5255x in about 34 min. Pigeonhole segment hashing discovered by the agent. About $2.73 per turn.
- ARC-AGI-3 bench: a second, non-speed domain with holdout scoring.

**Medium (worth a subsection or a paragraph):**

- Fresh agent process per turn: all state lives in the repo. Compare to long-context single
  sessions in the paper (7 days, 40 versions).
- The meta loop: the repo was built by a ralph loop with `PLAN.md`, `PROGRESS.jsonl` and
  `evidence/`. Self-hosting as a methodological note.
- Engineering for long runs: STOP file, no-change termination, process-group kills, the
  reparented-session incident (#33).
- Testing strategy: unit tests plus e2e evidence transcripts per slice.

**Weak or open (limitations and future work):**

- Strict monotone acceptance can stop short of ideas that need a worse first step ("digging for
  diamonds"). Candidates: simulated annealing style acceptance, archives, MAP-Elites.
- The supervisor has not fired in real runs because every fuzzysearch turn improved.
- No cost cap in `avo run`.
- Timing noise, single runs, no ablations, small number of benchmarks.
- No GPU kernel replication of the paper's headline result.

## Outline

### Abstract

One paragraph. AVO replaces fixed mutation and crossover with a coding agent. We present avocode,
an open, agent-agnostic implementation of the AVO harness. State the four objects, the vector
commit rule, the external supervisor, the fan-out probes, and the headline fuzzysearch result.

### 1. Introduction

- LLMs in evolutionary search: from candidate generator (FunSearch, AlphaEvolve) to variation
  operator (AVO).
- The gap: the AVO paper reports results, not a reusable harness. Its implementation is not public
  (verify in paper notes).
- Our thesis: the harness generalizes past attention kernels to any repo with a measurable score.
- Contributions (bulleted):
  1. A faithful mapping of `f`, `P_t`, `K`, Agent and Supervisor to git, a JSON contract and search.
  2. A precise commit rule (vector dominance with a noise floor) and its anti-gaming invariants.
  3. Externalized self-supervision with cited directives.
  4. Agent-agnostic delivery through portable skills.
  5. A bounded fan-out operator as a first step toward populations.
  6. An empirical case study and an honest list of limits.

### 2. Background and related work

- 2.1 Classical evolutionary computation: variation, selection, elitism, (1+1)-EA, Pareto
  dominance, quality diversity.
- 2.2 LLM-guided evolution: ELM, FunSearch, EvoPrompt, AlphaEvolve, OpenEvolve, ShinkaEvolve.
  The `Generate(Sample(P_t))` decomposition.
- 2.3 Coding agents and agent harnesses: SWE-agent, Reflexion, Voyager skill libraries, Claude
  Code, Codex, pi. Agent Skills standard.
- 2.4 LLMs for performance engineering: KernelBench, FlashAttention line, CUDA agents.
- 2.5 Evaluation integrity and reward hacking.

### 3. AVO in brief

- 3.1 Formulation: Eq. 3 vs Eq. 4. Definitions of `P_t`, `K`, vector `f`, zero-on-incorrect.
- 3.2 Anatomy of a variation step: edit, evaluate, diagnose cycle; commit on match-or-improve.
- 3.3 Continuous evolution and the supervisor.
- 3.4 Reported results (B200, MHA and GQA, numbers vs cuDNN and FA4).
- 3.5 What the paper leaves open: population branching, archive management, harness details.

### 4. System overview

- Figure: the loop (reuse `docs/img/loop.svg` converted to PDF).
- Table: AVO symbol to avocode artifact.
- Three layers: CLI, skills, bindings. Invariant: every capability reachable from `bash`.
- "One file, one contract" module map of `src/`.
- No build step; CLI and pi extension share `src/`.

### 5. The scoring function `f`

- The `.avo/score` contract: JSON fields, `ok`, `correct`, `primary`, `scores`, `unit`,
  `higher_is_better`; always exit 0; harness errors vs incorrect candidates.
- Configs and the score vector; reduction; noise floor.
- Templates: hyperfine, pytest, vitest.
- Guidance on scorer design: strict cheap correctness, determinism, speed budget.

### 6. The lineage `P_t`, memory and knowledge `K`

- 6.1 The commit rule. Formal definition with noise floor epsilon. Acceptance as weak Pareto
  dominance with strictness. Contrast to the paper's rule. Figure: `commit-rule.svg`.
- 6.2 Anti-gaming invariants: re-score at commit, protected files, no measuring less, scorer is
  read-only, only `avo commit` persists.
- 6.3 Persisting a version: trailers, git notes, `lineage/vNNN.md`. Figure:
  `lineage-records.svg`. Lineage vs trajectory.
- 6.4 Memory: parent links, dead ends keyed by content, beads vs JSONL.
- 6.5 Knowledge: qmd hybrid search over `knowledge/` and `lineage/`; local fallback; web ingest
  with provenance. Figure: `knowledge.svg`.

### 7. Orchestration

- 7.1 The variation step as a skill (`avo-vary`): read the past, one change per candidate,
  measure, commit.
- 7.2 `avo run`: fresh process per turn, prompt assembly, termination rules. Algorithm 1.
- 7.3 `avo supervise`: stall and thrash signals, thresholds, the directive. Algorithm 2.
- 7.4 `avo fan`: worktrees, probes, promotion, recursion guards. Selection rule as math.
  Figure: `fan.svg`.
- 7.5 Agent adapters: pi, Claude Code, Codex; pi tools and in-session supervisor.

### 8. Evaluation

- 8.1 Benchmarks: fuzzysearch (speed) and ARC-AGI-3 (score with holdout).
- 8.2 Setup: agent, model, budgets, hardware, scorer configs.
- 8.3 Results: table per version (version, technique, time, speedup). Figure: `results.svg`,
  `lineage-chain.svg`.
- 8.4 Case studies: pigeonhole segment hashing; the profiled phase that notes called negligible;
  the refused candidate between v4 and v5.
- 8.5 Cost and tokens.
- 8.6 Engineering validation: e2e evidence per slice, test counts, CI.

### 9. Discussion

- Fidelity to AVO: what matches, what differs, why (table).
- Single lineage vs populations; strict monotone acceptance and its cost.
- Fresh process per turn vs long-lived agent.
- Externalized memory as the real substrate of continuity.
- Self-hosting: the repo built by a similar loop.

### 10. Limitations and future work

- Supervisor untested on a plateau; no cost cap; timing noise; few benchmarks; no kernel
  replication.
- Future: population and archive (MAP-Elites), non-monotone acceptance, learned supervisor,
  GPU kernel replication, cost-aware scheduling.

### 11. Conclusion

### Appendices

- A. CLI reference table.
- B. `.avo/score` example scripts.
- C. Full fuzzysearch lineage and evidence excerpts.
- D. Skill file excerpt (`avo-vary`).

## Figures and tables plan

| Item | Source | Note |
| --- | --- | --- |
| Fig. loop | `docs/img/loop.svg` | convert with `rsvg-convert -f pdf` or redraw in TikZ |
| Fig. commit rule | `docs/img/commit-rule.svg` | |
| Fig. lineage records | `docs/img/lineage-records.svg` | |
| Fig. knowledge | `docs/img/knowledge.svg` | |
| Fig. fan | `docs/img/fan.svg` | |
| Fig. results | `docs/img/results.svg` | or pgfplots from the table |
| Fig. lineage chain | `docs/img/lineage-chain.svg` | |
| Tab. symbol map | architecture.md | |
| Tab. fidelity | paper notes + code notes | |
| Tab. results | evaluation.md | |
| Alg. 1 avocode loop | code-orchestration.md | |
| Alg. 2 supervisor | code-orchestration.md | |

## Open questions for synthesis

- Exact noise floor semantics in `compare.ts` (relative or absolute epsilon).
- Does the paper publish code or the supervisor's thresholds?
- Final fuzzysearch numbers per version and the run-1 vs run-2 split.
- ARC-AGI-3 outcome: did a run happen, and with what scores?
- No LaTeX compiler is installed locally; ship `.tex` + `.bib` and a `justfile`/Makefile target.
