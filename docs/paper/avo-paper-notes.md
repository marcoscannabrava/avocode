# AVO paper notes

Notes on the source paper for the avocode article. The paper is the authority. All numbers come
from the arXiv v1 PDF (7 pages + references + appendix, 12 pages in total). Read on 2026-10-14.

Legend: **[verbatim]** = copied from the paper. **[derived]** = we computed it from paper numbers.
**[uncertain]** = we could not confirm it from the paper text. **[not in paper]** = our addition.

---

## 1. Bibliographic information

| Field | Value |
| --- | --- |
| Title | AVO: Agentic Variation Operators for Autonomous Evolutionary Search |
| Authors | Terry Chen\*, Zhifan Ye\*, Bing Xu\*, Zihao Ye, Timmy Liu, Ali Hassani, Tianqi Chen, Andrew Kerr, Haicheng Wu, Yang Xu, Yu-Jung Chen, Hanfeng Chen, Aditya Kane, Ronny Krashinsky, Ming-Yu Liu, Vinod Grover, Luis Ceze, Roger Bringmann, John Tran, Wei Liu, Fung Xie, Michael Lightstone, Humphrey Shi |
| Equal contribution | Terry Chen, Zhifan Ye, Bing Xu (marked \*) |
| Affiliation | NVIDIA (single affiliation line on the title page) |
| arXiv id | 2603.24517 (v1 is the only version as of 2026-10-14) |
| Primary class | cs.LG (Machine Learning) |
| Submitted | Wed, 25 Mar 2026, 16:55:04 UTC (v1, 302 KB), submitter Zhifan Ye |
| Venue | None. The PDF footer says "Preprint." No journal-ref or conference on the arXiv page. |
| Code release | None. The paper gives no code or repository link for AVO itself. |
| URLs | https://arxiv.org/abs/2603.24517, https://arxiv.org/pdf/2603.24517, https://arxiv.org/html/2603.24517 |

```bibtex
@misc{chen2026avo,
  title         = {{AVO}: Agentic Variation Operators for Autonomous Evolutionary Search},
  author        = {Chen, Terry and Ye, Zhifan and Xu, Bing and Ye, Zihao and Liu, Timmy and
                   Hassani, Ali and Chen, Tianqi and Kerr, Andrew and Wu, Haicheng and Xu, Yang and
                   Chen, Yu-Jung and Chen, Hanfeng and Kane, Aditya and Krashinsky, Ronny and
                   Liu, Ming-Yu and Grover, Vinod and Ceze, Luis and Bringmann, Roger and
                   Tran, John and Liu, Wei and Xie, Fung and Lightstone, Michael and Shi, Humphrey},
  year          = {2026},
  month         = mar,
  eprint        = {2603.24517},
  archivePrefix = {arXiv},
  primaryClass  = {cs.LG},
  url           = {https://arxiv.org/abs/2603.24517},
  note          = {Preprint}
}
```

### Paper structure

1 Introduction · 2 Background (2.1 Evolutionary Search and Variation Operators; 2.2 Attention
Kernels on Modern GPUs) · 3 Agentic Variation Operators (3.1 Formulation; 3.2 Anatomy of a
Variation Step; 3.3 Continuous Evolution) · 4 Experiments (4.1 Setup; 4.2 Multi-Head Attention;
4.3 Grouped-Query Attention; 4.4 Evolution Trajectory) · 5 Analysis of Agent-Discovered
Optimizations (5.1–5.3, 5.4 Discussion) · 6 Conclusion · Acknowledgement · References (24) ·
Appendix A Comparison Using FA4-Reported Baseline Performance.

Figures: Fig. 1 EVO vs AVO; Fig. 2 AVO illustration; Fig. 3 MHA results; Fig. 4 GQA results;
Fig. 5 causal trajectory; Fig. 6 non-causal trajectory; Fig. 7 (App. A) vs FA4-reported
baselines. Table 1: ablations. **There is no algorithm box or pseudocode in the paper.**

---

## 2. Problem statement and motivation

- LLMs already serve in evolutionary search as learned mutation operators: ELM [2], FunSearch [3],
  AlphaEvolve [4], EvoPrompting [5]. A surrounding framework, "usually heuristic-based", does
  parent sampling, evaluation and population management (§1).
- The problem: confining the LLM to candidate generation "fundamentally limits what the LLM can
  discover". It makes one output per call. It cannot consult references, test, read feedback, or
  revise before it commits a candidate (§1).
- This limit is worst for heavily hand-tuned code, where progress needs "deep, iterative
  engineering" (§1).
- Test domain: attention [6]. The FlashAttention line [7–10] and cuDNN [11] are near hardware
  limits. FA4 and cuDNN each took "months of manual optimization" on Blackwell (§1).
- Enabler: "deep agents" [12–16] (SWE-bench, SWE-agent, OpenHands, Claude Code, Codex) with
  planning, persistent memory and tool use; plus VibeTensor [17] (same NVIDIA group) as proof that
  agents can generate deep learning system software (§1).
- Proposal: make the deep agent the variation operator itself. It replaces mutation and crossover
  from single-turn LLM work [3–5] or fixed workflows [18, LoongFlow] (§1).

---

## 3. Formalism (exact transcription)

### 3.1 Notation

| Symbol | Meaning in the paper |
| --- | --- |
| $\mathcal{P}$, $\mathcal{P}_t$ | Population = set of solution–score pairs; in §3, "the full lineage of solutions and their scores" |
| $x_i$ | A candidate solution. In the experiments: "a CUDA kernel implementation (source code with inline PTX)" |
| $x_0$ | Seed program |
| $\mathbf{f}$ | Scoring function. Vector valued in practice |
| $f_j$ | Score for test configuration $j$ |
| $\mathcal{K}$ | Domain-specific knowledge base |
| $\mathrm{Vary}$ | Variation operator |
| $\mathrm{Update}$ | Adds the new solution to the population, "possibly pruning low-score members to maintain a bounded archive" |
| $\mathrm{Sample}$, $\mathrm{Generate}$ | The two stages of prior work's Vary |
| $\mathrm{Agent}$ | The AVO agent run that replaces Sample∘Generate (and evaluation) |

Note on typography: the PDF typesets $\mathcal{P}$ and $\mathcal{K}$ in calligraphic font in
Fig. 2, and $\mathbf{f}$ in bold. In the running text the extraction shows plain `P`, `K`, bold
`f`. We use `\mathcal{P}_t`, `\mathcal{K}`, `\mathbf{f}`.

### 3.2 Equations

Eq. (1), §2.1, generic evolutionary search:

$$
\mathcal{P}_{t+1} = \mathrm{Update}\big(\mathcal{P}_t,\ (x_{t+1}, \mathbf{f}(x_{t+1}))\big),
\qquad x_{t+1} = \mathrm{Vary}(\mathcal{P}_t) \tag{1}
$$

Population definition (§2.1): $\mathcal{P} = \{(x_i, \mathbf{f}(x_i))\}$.

Eq. (2), §2.1, prior LLM-augmented methods (FunSearch, AlphaEvolve, [2, 20, 5]):

$$
\mathrm{Vary}(\mathcal{P}_t) = \mathrm{Generate}\big(\mathrm{Sample}(\mathcal{P}_t)\big) \tag{2}
$$

Eq. (3), §3.1, the same decomposition restated, attributed to [3, 4]:

$$
\mathrm{Vary}(\mathcal{P}_t) = \mathrm{Generate}(\mathrm{Sample}(\mathcal{P}_t)) \tag{3}
$$

Eq. (4), §3.1, AVO:

$$
\mathrm{Vary}(\mathcal{P}_t) = \mathrm{Agent}(\mathcal{P}_t, \mathcal{K}, \mathbf{f}) \tag{4}
$$

Lineage (§3.1):

$$
\mathcal{P}_t = \{(x_1, \mathbf{f}(x_1)), \ldots, (x_t, \mathbf{f}(x_t))\}
$$

Vector score (§3.1):

$$
\mathbf{f}(x_i) = \big(f_1(x_i), f_2(x_i), \ldots, f_n(x_i)\big)
$$

Correctness gate (§3.1): a candidate that fails correctness gets $f_j(x_i) = 0$ for every $j$,
"regardless of throughput".

Attention (§2.2): $O = \mathrm{softmax}(QK^\top/\sqrt{d})\,V$, $d$ = head dimension,
$S = QK^\top$ is $N \times N$; $P = \mathrm{softmax}(S)$.

### 3.3 Selection / update rule (as stated in prose, §3.2)

> "In our current implementation, we persist a new committed version only when it passes
> correctness checks and matches or improves the benchmark score relative to the best committed
> version so far; unsuccessful intermediate attempts remain part of the agent's internal search
> trajectory but are not added to the committed lineage." (§3.2)

What the paper does **not** specify [uncertain]:

- How "matches or improves" is judged on a vector $\mathbf{f}$. The trajectory figures (Figs. 5–6)
  plot the **geometric mean** across configurations as "running best", so a scalar geomean is the
  likely reduction, but §3.2 never says so.
- Any noise tolerance for "matches". They ran benchmarks 10 times for mean and std (§4.1), but
  the acceptance threshold is not given.
- Whether causal and non-causal are one score vector or separate runs. Figs. 5 and 6 both say
  "40 kernel versions over 7 days", which suggests one lineage scored on both [uncertain].

In our words, the implicit update rule is elitist and monotone: $\mathcal{P}_{t+1} =
\mathcal{P}_t \cup \{(x_{t+1}, \mathbf{f}(x_{t+1}))\}$ iff $x_{t+1}$ is correct and its score
$\ge$ the best so far; else $\mathcal{P}_{t+1} = \mathcal{P}_t$. Nothing is pruned. [derived]

### 3.4 Pseudocode

The paper has **no** pseudocode. Below is a reconstruction from §3.1–3.3 and §4.1, for our
article to cite as "our reading of the paper". [derived]

```text
Algorithm: AVO, single-lineage continuous instantiation (reconstructed)
Input: seed x0, knowledge base K, scoring function f
P ← {(x0, f(x0))}                       # assumption: seed scored as baseline
loop forever (no human intervention):
    # one variation step = one autonomous agent run: Vary(P) = Agent(P, K, f)
    repeat:
        agent inspects prior versions in P (code, profiles), consults K
        agent plans and edits a candidate x'
        s ← f(x')                       # correctness check + TFLOPS per config
        if x' incorrect or s < best(P): agent diagnoses, revises
    until agent commits x' with correct(x') and s ≥ best(P)
    P ← P ∪ {(x', s)}                   # persisted as a git commit with its score
    if supervisor detects stall or unproductive cycles:
        supervisor reviews whole trajectory, proposes several new directions
```

---

## 4. System architecture

### 4.1 The agent (§3.2, §4.1)

- "an internally-developed general-purpose coding agent powered by frontier LLMs" (§4.1).
  **The LLMs are not named.** No model, size, context length, token count or cost is reported.
- Tools: "autonomous code editing, shell command execution, file system navigation, and
  documentation retrieval" (§4.1).
- Memory: "persistent memory through its conversation history, which accumulates the full context
  of prior edits, compiler outputs, profiling results, and reasoning across the evolutionary
  process" (§4.1). How this history fits in a context window over 7 days is not described
  [uncertain: compaction/summarization not mentioned].
- No task-specific changes: "the same agent used for general software engineering tasks is
  deployed here" (§4.1).
- Note: §3.2 says "details in Section 4", and the only details are the §4.1 paragraph above.

### 4.2 Inside one variation step (§3.2, Fig. 2)

- A step may involve "numerous internal actions".
- The agent often examines several prior versions in $\mathcal{P}_t$, compares their profiling
  characteristics, and reads $\mathcal{K}$ for hardware limits before it implements.
- Then it calls $\mathbf{f}$. On failure (incorrect, or no improvement) it diagnoses and revises:
  the "edit-evaluate-diagnose cycle".
- Strategy shifts over time: early steps make structural changes from reference code in
  $\mathcal{K}$; later steps do micro-architectural tuning from profiling and lineage patterns.
- Fig. 2 labels the loop stages: **Planning** ("Propose Edits (using $\mathcal{K}$ &
  $\mathcal{P}_t$)"), **Implementation** ("Apply Code Modifications"), **Evaluation** ("Evaluate
  Performance (Using $\mathbf{f}$)"), **Bug-Fixing** ("Diagnose, Repair, and Adapt Plan"). The
  centre is "AI Agent" with "Tools", "Memory", "Reasoning". Input: Population $\mathcal{P}_t$,
  Knowledge Base $\mathcal{K}$ ("CUDA & PTX Documents", "Reference GPU Kernel Codebases"),
  Scoring Function $\mathbf{f}$ ("Correctness Check", "Throughput Measurement"). Output:
  $(x_{t+1}, \mathbf{f}(x_{t+1}))$.
- Fig. 1 contrasts "EVO: Classical Evolutionary Search Frameworks" (Previous Solutions →
  Sampling → LLM → Evaluation; "Single-Turn or Predefined Workflow") with "AVO" ("Agent Loop:
  Planning, Implementing, Testing, Debugging"; AI Agent with Tools and Memory, plus Previous
  Solutions and Evaluation Utility).

### 4.3 Knowledge base $\mathcal{K}$ (§3.1)

"CUDA programming guides, PTX ISA documentation, Blackwell architecture specifications, and
existing kernel implementations including FlashAttention-4 source code." No retrieval mechanism
(vector index, grep, etc.) is described beyond the "documentation retrieval" tool [uncertain].

### 4.4 Scoring function $\mathbf{f}$ (§3.1, §4.1)

- Two dimensions: numerical correctness vs a reference implementation, and TFLOPS on target
  hardware.
- One component per test configuration; incorrect ⇒ all zero.
- Timing: the FA4 repo's `benchmarks/benchmark_attn.py`, with the FA4 paper's warm-up and repeat
  counts. Experiments repeated 10 times for mean and std. "The same setup is used both for agent
  evolution and for benchmarking the final evolved kernels against the baselines." (§4.1)
- The correctness tolerance is not given [uncertain].

### 4.5 Lineage (§3.1, §3.3)

- Single lineage from seed $x_0$: $x_1, x_2, \ldots, x_t$ committed improvements.
- "Each committed version $x_i$ is persisted as a git commit along with its score, maintaining
  full state continuity across the entire evolutionary process." (§3.3)
- Failed attempts stay in the agent's internal trajectory, not in the lineage (§3.2).
- The lineage is context for later steps (§3.1).

### 4.6 Continuous evolution and self-supervision (§3.3, Fig. 2)

- "The AVO agent operates as a continuous loop that periodically produces new solutions without
  human intervention." (§3.3)
- Two failure modes: (a) stall when the agent "exhausts its current line of exploration";
  (b) "unproductive cycles of edits that repeatedly fail to improve scores".
- Remedy: a "self-supervision mechanism that detects these scenarios and intervenes". When
  triggered it "reviews the overall evolutionary trajectory and steers the search toward several
  candidate optimization directions." This is a "conditional intervention".
- Fig. 2 draws it as a separate **"AVO Supervisor Agent"** box that does "Monitor Stagnation"
  and sends "Conditional Intervention" to the main loop. §3.3 also calls it "the supervisor".
- **Not specified** [uncertain]: detection thresholds, how stagnation is measured, whether the
  supervisor is a separate LLM process or a prompt, how many times it fired, and how its
  directions enter the main agent (new session vs injected message).
- Division of labour (§3.3): the main agent decided when to try new ideas, when to revisit earlier
  versions in $\mathcal{P}_t$, and when to switch strategy; the supervisor kept forward progress
  during stagnation.

### 4.7 Population structure

- "AVO is orthogonal to the choice of population structure: the agentic operator can in principle
  be used within archive-based, island-based, or single-lineage evolutionary regimes. In this
  paper we study the single-lineage setting to isolate the effect of the operator itself." (§2.1)
- Population branching and archive management are left to "future extensions" (§3.3).

---

## 5. Experimental setup and results

### 5.1 Setup (§4.1)

| Item | Value |
| --- | --- |
| Hardware | NVIDIA B200 GPUs (Blackwell), following the FA4 setup |
| Software | CUDA 13.1, PyTorch 2.10.0 |
| Baseline 1 | cuDNN 9.19.1 (closed source, "includes custom optimizations for Blackwell") |
| Baseline 2 | FlashAttention-4, official implementation, commit `71bf77c` |
| Workload | Forward prefill, head dim 128, BF16 |
| Sequence lengths | {4096, 8192, 16384, 32768}, total tokens fixed at 32768 (bs = 8, 4, 2, 1) |
| MHA | 16 heads, causal and non-causal |
| GQA | 32 Q heads / 4 KV heads (group 8, Qwen3-30B-A3B); 32 Q heads / 8 KV heads (group 4, Qwen3-8B) |
| Timing | FA4 repo `benchmark_attn.py`; FA4 paper warm-up and repeat counts; 10 runs, mean and std |
| Evolution | 7 days continuous; 40 committed versions; "over 500" directions explored |
| Kernel language | CUDA source with inline PTX |
| Agent | internal, general-purpose, "frontier LLMs" (unnamed) |
| GQA adaptation | the agent was "prompted" to adapt the MHA kernel; about 30 minutes, no human guidance |

The seed $x_0$ is not described except as "a naive implementation" implied by §4.4 ("closing the
gap between a naive implementation and the well-optimized baselines") [uncertain]. Number of GPUs
used during evolution is not stated.

### 5.2 MHA results (Fig. 3, §4.2)

Forward TFLOPS, B200, head dim 128, 16 heads, BF16. Values are the bar labels in Fig. 3. We
mapped labels to series by x position in the PDF; the mapping is confirmed because the geomeans
match the Fig. 5/6 legend values (see 5.5). Gains are [derived].

**Non-causal**

| seq (bs) | cuDNN | FA4 | AVO | AVO vs cuDNN | AVO vs FA4 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4K (8) | 1573 | 1578 | 1573 | +0.0% | −0.3% |
| 8K (4) | 1609 | 1614 | 1615 | +0.4% | +0.1% |
| 16K (2) | 1626 | 1637 | 1664 | +2.3% | +1.6% |
| 32K (1) | 1638 | 1651 | **1668** | +1.8% | +1.0% |

**Causal**

| seq (bs) | cuDNN | FA4 | AVO | AVO vs cuDNN | AVO vs FA4 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4K (8) | 1344 | 1259 | 1392 | +3.6% | +10.6% |
| 8K (4) | 1477 | 1412 | 1482 | +0.3% | +5.0% |
| 16K (2) | 1551 | 1502 | 1582 | +2.0% | +5.3% |
| 32K (1) | 1590 | 1550 | 1637 | +3.0% | +5.6% |

Paper text (§4.2) [verbatim numbers]: causal "+0.4% to +3.5% over cuDNN and +5.0% to +10.5% over
FA4"; non-causal "+1.8% to +2.4% over cuDNN at sequence lengths larger than 16384" (sic; the two
points that fit are 16K and 32K) "but is within measurement noise of both baselines at shorter
sequences". Small gaps vs our derived values (e.g. 0.3 vs 0.4, 3.6 vs 3.5, 2.3 vs 2.4) come from
rounded bar labels; quote the paper's figures, not ours. Peak: **1668 TFLOPS** (non-causal,
32K, bs=1). Std devs are not printed as numbers in the text [uncertain whether figures carry
error bars].

### 5.3 GQA results (Fig. 4, §4.3)

Forward TFLOPS, B200, 32 Q heads, head dim 128, BF16. Same mapping method. Gains [derived].

**Group 8 (4 KV heads), non-causal**

| seq (bs) | cuDNN | FA4 | AVO | vs cuDNN | vs FA4 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4K (8) | 1590 | 1602 | 1646 | +3.5% | +2.7% |
| 8K (4) | 1620 | 1633 | 1677 | +3.5% | +2.7% |
| 16K (2) | 1607 | 1643 | 1663 | +3.5% | +1.2% |
| 32K (1) | 1441 | 1472 | 1528 | +6.0% | +3.8% |

**Group 8, causal**

| seq (bs) | cuDNN | FA4 | AVO | vs cuDNN | vs FA4 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4K (8) | 1377 | 1342 | 1467 | +6.5% | +9.3% |
| 8K (4) | 1503 | 1471 | 1511 | +0.5% | +2.7% |
| 16K (2) | 1571 | 1541 | 1618 | +3.0% | +5.0% |
| 32K (1) | 1603 | 1530 | 1625 | +1.4% | +6.2% |

**Group 4 (8 KV heads), non-causal**

| seq (bs) | cuDNN | FA4 | AVO | vs cuDNN | vs FA4 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4K (8) | 1586 | 1601 | 1633 | +3.0% | +2.0% |
| 8K (4) | 1617 | 1627 | 1673 | +3.5% | +2.8% |
| 16K (2) | 1626 | 1624 | 1679 | +3.3% | +3.4% |
| 32K (1) | 1477 | 1460 | 1526 | +3.3% | +4.5% |

**Group 4, causal**

| seq (bs) | cuDNN | FA4 | AVO | vs cuDNN | vs FA4 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4K (8) | 1368 | 1344 | 1464 | +7.0% | +8.9% |
| 8K (4) | 1497 | 1470 | 1506 | +0.6% | +2.4% |
| 16K (2) | 1568 | 1536 | 1603 | +2.2% | +4.4% |
| 32K (1) | 1601 | 1517 | 1647 | +2.9% | +8.6% |

Paper text (§4.3) [verbatim numbers]: "AVO outperforms both baselines across all
configurations. On causal GQA, AVO achieves up to +7.0% over cuDNN and +9.3% over FA4. On
non-causal GQA, gains reach up to +6.0% over cuDNN and +4.5% over FA4." The maxima match our
derived tables: +7.0% (g4 causal 4K), +9.3% (g8 causal 4K), +6.0% (g8 non-causal 32K), +4.5%
(g4 non-causal 32K).

### 5.4 Appendix A: vs FA4-paper-reported baselines (Fig. 7)

Motivation: "minor system-level differences (driver versions, thermal conditions, clock
frequencies) can affect absolute TFLOPS". AVO measured on their hardware; cuDNN and FA4 values
taken from the FA4 paper [10]. MHA, head dim 128, 16 heads, BF16. Gains [derived].

**Non-causal**

| seq (bs) | cuDNN (FA4 paper) | FA4 (FA4 paper) | AVO | vs cuDNN | vs FA4 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4K (8) | 1552 | 1532 | 1573 | +1.4% | +2.7% |
| 8K (4) | 1585 | 1579 | 1615 | +1.9% | +2.3% |
| 16K (2) | 1609 | 1601 | 1664 | +3.4% | +3.9% |
| 32K (1) | 1613 | 1613 | 1668 | +3.4% | +3.4% |

**Causal**

| seq (bs) | cuDNN (FA4 paper) | FA4 (FA4 paper) | AVO | vs cuDNN | vs FA4 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4K (8) | 1295 | 1279 | 1392 | +7.5% | +8.8% |
| 8K (4) | 1430 | 1426 | 1482 | +3.6% | +3.9% |
| 16K (2) | 1509 | 1526 | 1582 | +4.8% | +3.7% |
| 32K (1) | 1540 | 1576 | 1637 | +6.3% | +3.9% |

Paper text: non-causal "+1.4% to +3.4% over cuDNN and +2.3% to +3.9% over FA4"; causal "+3.6% to
+7.5% over cuDNN and +3.7% to +8.8% over FA4, with the largest gains observed at shorter
sequences (bs=8, seq=4096). These results are broadly consistent with the comparisons in
Section 4." Our derived ranges match exactly.

### 5.5 Evolution trajectory (Figs. 5–6, §4.4)

| | AVO v40 geomean | cuDNN geomean | FA4 geomean |
| --- | ---: | ---: | ---: |
| Causal MHA (Fig. 5) | 1520 | 1488 | 1426 |
| Non-causal MHA (Fig. 6) | 1630 | 1611 | 1620 |

Check [derived]: geomeans of the Fig. 3 bars are 1520.3 / 1487.5 / 1426.3 (causal) and
1629.5 / 1611.3 / 1619.8 (non-causal). This confirms the bar-to-series mapping in 5.2. So v40
geomean gain: causal +2.2% vs cuDNN, +6.6% vs FA4; non-causal +1.2% vs cuDNN, +0.6% vs FA4
[derived].

Per-version values for v1–v39 are only plotted, not printed. The y axes start at 1100 (causal)
and 1300 (non-causal); v1's value is not legible from text [uncertain]. Do not quote per-version
numbers.

Observations (§4.4):

- **Scale of exploration.** 40 committed versions are "only the successful outcomes of a much
  larger search"; "over 500 candidate optimization directions" explored, including ones that
  failed correctness, regressed, or were dropped after profiling. Claim: "far exceeds what a
  human engineer could accomplish in the same timeframe."
- **Discrete jumps.** Progress comes in steps between plateaus. The five largest gains:
  v8 QK-PV interleaving with bitmask causal masking; v13 restructured single-pass softmax;
  v20 branchless accumulator rescaling with a lighter memory fence for unmasked iterations;
  v30 correction/MMA pipeline overlap; v33 register rebalancing across warp groups.
- **Diminishing returns.** v1–v20 give the largest absolute gains per version (closing the gap to
  baselines); v21–v40 give smaller compounding gains from cycle-level scheduling and resource
  allocation.

Rough rate [derived]: 40 commits / 7 days ≈ 5.7 commits per day; ≥ 500 directions / 40 commits
⇒ ≥ 12.5 directions per commit, i.e. under 8% of directions committed.

### 5.6 Ablations (Table 1, §5) [verbatim]

Geomean TFLOPS gain over the preceding version, across all benchmark configurations.

| Optimization | Versions | Non-causal | Causal |
| --- | --- | ---: | ---: |
| Branchless accumulator rescaling | v19 → v20 | +8.1% | +1.6% |
| Correction/MMA pipeline overlap | v29 → v30 | +1.1% | +0.4% |
| Register rebalancing across warp groups | v32 → v33 | +2.1% | ∼ 0% |

Details:

- **5.1 Branchless rescaling.** v19 checked per warp whether any thread needed O rescaled and
  skipped otherwise; the branch caused warp sync overhead each key-block iteration and blocked
  lighter fences. v20 always computes the factor and uses a predicated select of 1.0. No
  divergence ⇒ a blocking memory fence is replaced by a non-blocking ordering fence. "the largest
  single optimization in the evolution". Asymmetry: applies only to fully unmasked iterations;
  causal keeps the branched path for masked blocks.
- **5.2 Pipeline overlap.** Dual Q-stage. v29 made the correction warp wait for both PV GEMMs.
  v30 lets it normalize stage 1 as soon as its PV GEMM ends, overlapping with stage 2's PV GEMM.
- **5.3 Register rebalancing.** Budget "2048 warp-registers per SM". v32 used FA4's split: 192
  (8 softmax warps) / 80 (4 correction warps) / 48 (other 4 warps). Profiling showed spills in the
  correction group. v33 moved 8 registers from softmax to each other group: **184/88/56**. Viable
  because softmax uses small fragments with packed arithmetic. Builds on 5.2: correction now sits
  on the critical path.
- **5.4 Discussion.** Each change needs joint reasoning over several hardware subsystems
  (synchronization and memory ordering, pipeline scheduling, register allocation), not one
  parameter.

Consistency check [derived]: 8 × 192 + 4 × 80 + 4 × 48 = 2048 and 8 × 184 + 4 × 88 + 4 × 56 =
2048, so the budget figure is self-consistent.

---

## 6. Contributions, limitations, future work

### 6.1 Claimed contributions (§1, verbatim bullets)

1. "We introduce Agentic Variation Operators (AVO), a new family of evolutionary variation
   operators that elevate the agent from candidate generator to variation operator, autonomously
   exploring domain knowledge, implementing edits, and validating results through iterative
   interaction with the environment."
2. "We achieve state-of-the-art MHA throughput on NVIDIA B200 GPUs across the benchmarked
   configurations, reaching up to 1668 TFLOPS and outperforming cuDNN by up to 3.5% and
   FlashAttention-4 by up to 10.5%. Furthermore, we show that the discovered optimizations
   readily transfer to GQA, requiring only 30 minutes of autonomous adaptation and yielding gains
   of up to 7.0% over cuDNN and 9.3% over FlashAttention-4."
3. "We provide a detailed analysis of the micro-architectural optimizations discovered by the
   agent under the benchmarked settings, showing the agent performs genuine hardware-level
   reasoning rather than superficial code transformations."

### 6.2 Limitations

The paper has **no limitations section**. Limits it states or implies:

- Stated: single-lineage only; population branching and archive management are future work
  (§2.1, §3.3).
- Stated: non-causal MHA gains at 4K and 8K are "within measurement noise of both baselines"
  (§4.2).
- Stated: trajectories show committed versions only, not the internal search tree (§4.4).
- Stated: absolute TFLOPS can vary with driver, thermals, clocks (App. A).

Limits we observe [not in paper; for our article's discussion]:

- Agent and LLMs are internal and unnamed; no code, prompts, or harness released. Not
  reproducible by third parties.
- Supervisor thresholds, trigger counts and mechanics are not given.
- No ablation of AVO against a classical LLM-evolution baseline (e.g. AlphaEvolve-style
  Sample+Generate) on the same budget. The "operator vs generator" claim is argued, not measured.
- No ablation of $\mathcal{K}$ or the supervisor.
- One run (one lineage) of the 7-day evolution; no variance across evolution runs.
- No compute, token, or cost figures; number of GPUs not stated.
- Forward pass only; head dim 128 and BF16 only; one GPU type.
- The evolution benchmark and the final evaluation use the same configurations (§4.1), so MHA
  results are in-distribution; GQA is the only transfer test, and it involved a further 30-min
  agent adaptation.
- Acceptance rule ("matches or improves") on a vector score is underspecified.
- Correctness tolerance not stated.
- Agent memory is "conversation history" over 7 days; the paper does not say how it manages
  context limits.

### 6.3 Future work (§3.3, §6)

- "leaving population-level branching and archive management to future extensions" (§3.3).
- "it points toward a broader path for autonomous optimization beyond attention kernels,
  including other performance-critical software systems on diverse hardware platforms, and
  engineering or scientific domains that demand extended autonomous exploration." (§6)

---

## 7. Quotable sentences

All verbatim from arXiv v1.

- Abstract: "Agentic Variation Operators (AVO) are a new family of evolutionary variation operators
  that replace the fixed mutation, crossover, and hand-designed heuristics of classical
  evolutionary search with autonomous coding agents."
- Abstract: "Rather than confining a language model to candidate generation within a prescribed
  pipeline, AVO instantiates variation as a self-directed agent loop that can consult the current
  lineage, a domain-specific knowledge base, and execution feedback to propose, repair, critique,
  and verify implementation edits."
- Abstract: "agentic variation operators move beyond prior LLM-in-the-loop evolutionary pipelines
  by elevating the agent from candidate generator to variation operator"
- §1: "However, confining the LLM to candidate generation within a prescribed pipeline
  fundamentally limits what the LLM can discover: it produces a single output per invocation,
  with no ability to proactively consult reference materials, test its changes, interpret
  feedback, or revise its approach before committing a candidate."
- §1: "rather than confining them within a fixed pipeline, we can elevate a deep agent to serve as
  the variation operator itself."
- §1: "The AVO agent has access to all prior solutions, a domain-specific knowledge base, and the
  evaluation utility. It autonomously decides what to consult, what to edit, and when to
  evaluate, enabling continuous improvements over extended time horizons."
- §2.1: "We call Vary the variation operator: the mechanism by which new candidates are produced
  from existing ones."
- §2.1: "In all these approaches, the LLM only participates in Generate: the sampling strategy,
  evaluation protocol, population management, and the order of operations are all determined by
  the framework, not by the LLM."
- §2.1: "the agentic variation operator we introduce in Section 3 replaces the entire Vary with a
  self-directed agent that subsumes Sample, Generate, and evaluation into a single autonomous
  loop."
- §2.1: "AVO is orthogonal to the choice of population structure [...] In this paper we study the
  single-lineage setting to isolate the effect of the operator itself."
- §3: "AVO consolidates the sampling, generation, and evaluation stages of evolutionary search
  into a single autonomous agent run, eliminating the rigid pipeline that constrains existing
  approaches."
- §3.1: "A candidate $x_i$ that fails correctness is assigned zero score (i.e., $f_j(x_i) = 0$)
  regardless of throughput."
- §3.1: "The accumulated lineage $\mathcal{P}_t$ serves as context for subsequent variation steps."
- §3.2: "When a candidate fails correctness checks or fails to improve on the current benchmark
  suite, the agent diagnoses the issue and revises its approach, repeating this
  edit-evaluate-diagnose cycle until it commits a satisfactory $x_{t+1}$."
- §3.2: "we persist a new committed version only when it passes correctness checks and matches or
  improves the benchmark score relative to the best committed version so far; unsuccessful
  intermediate attempts remain part of the agent's internal search trajectory but are not added
  to the committed lineage."
- §3.3: "Each committed version $x_i$ is persisted as a git commit along with its score,
  maintaining full state continuity across the entire evolutionary process."
- §3.3: "the agent may stall when it exhausts its current line of exploration, or it may enter
  unproductive cycles of edits that repeatedly fail to improve scores."
- §3.3: "Once triggered, the mechanism reviews the overall evolutionary trajectory and steers the
  search toward several candidate optimization directions."
- §3.3: "the main agent autonomously decided when to attempt new optimizations, when to revisit
  earlier approaches in $\mathcal{P}_t$, and when to shift strategy, while the supervisor
  maintained forward progress by intervening during periods of stagnation."
- §4.1: "No task-specific modifications are made to the agent for kernel optimization; the same
  agent used for general software engineering tasks is deployed here"
- §4.4: "Note that these trajectories visualize the committed sequence, rather than the full
  internal search tree explored between the commits."
- §4.4: "Over the 7-day evolution, the agent explored over 500 candidate optimization directions
  internally, including attempts that failed correctness checks, regressed throughput, or were
  abandoned after profiling."
- §5.4: "each requires jointly reasoning about multiple hardware subsystems [...] rather than
  tuning any single parameter in isolation."
- §6: "Because AVO operates at the level of variation operators rather than being tied to a
  specific domain, it points toward a broader path for autonomous optimization beyond attention
  kernels"

---

## 8. References

### 8.1 All 24 references, as numbered in the paper

| # | Reference | Centrality for our article |
| --- | --- | --- |
| [1] | O'Neill, Vanneschi, Gustafson, Banzhaf. Open issues in genetic programming. *GPEM* 11(3):339–363, 2010. | Medium (hand-crafted mutation operators) |
| [2] | Lehman, Gordon, Jain, Ndousse, Yeh, Stanley. Evolution through large models (ELM). arXiv:2206.08896, 2022. | **High** |
| [3] | Romera-Paredes et al. Mathematical discoveries from program search with large language models (FunSearch). *Nature* 625:468–475, 2024. | **High** |
| [4] | Novikov et al. AlphaEvolve: A coding agent for scientific and algorithmic discovery. arXiv:2506.13131, 2025. | **High** |
| [5] | Chen, Dohan, So. EvoPrompting: Language models for code-level neural architecture search. arXiv:2302.14838, 2023. | **High** (note: EvoPrompt*ing*, not EvoPrompt) |
| [6] | Vaswani et al. Attention is all you need. arXiv:1706.03762 (paper cites "2023"). | Low |
| [7] | Dao, Fu, Ermon, Rudra, Ré. FlashAttention. arXiv:2205.14135, 2022. | Low–medium |
| [8] | Dao. FlashAttention-2. arXiv:2307.08691, 2023. | Low |
| [9] | Shah, Bikshandi, Zhang, Thakkar, Ramani, Dao. FlashAttention-3. arXiv:2407.08608, 2024. | Low |
| [10] | Zadouri, Hoehnerbach, Shah, Liu, Thakkar, Dao. FlashAttention-4: Algorithm and kernel pipelining co-design for asymmetric hardware scaling. arXiv:2603.05451, 2026. | Medium (baseline) |
| [11] | Chetlur et al. cuDNN: Efficient primitives for deep learning. arXiv:1410.0759, 2014. | Low–medium (baseline) |
| [12] | Jimenez et al. SWE-bench. arXiv:2310.06770, 2024. | Medium |
| [13] | Yang et al. SWE-agent. arXiv:2405.15793, 2024. | Medium–high (agent harness) |
| [14] | Wang et al. OpenHands. arXiv:2407.16741, 2025. | Medium |
| [15] | Anthropic. Claude 3.7 Sonnet and Claude Code. Web, Feb 2025. | **High for us** (avocode targets Claude Code) |
| [16] | OpenAI. Introducing Codex. Web, May 2025. | **High for us** (avocode targets Codex) |
| [17] | Xu, Chen, Zhou, Chen, Jia, Grover, Wu, Liu, Wittenbrink, Hwu, Bringmann, Liu, Ceze, Lightstone, Shi. VibeTensor: System software for deep learning, fully generated by AI agents. 2026. (No URL in paper; arXiv:2601.16238.) | Low–medium |
| [18] | Wan et al. LoongFlow: Directed evolutionary search via a cognitive plan-execute-summarize paradigm. arXiv:2512.24077, 2025. | **High** (fixed-workflow foil) |
| [19] | Bäck, Fogel, Michalewicz. Handbook of evolutionary computation. 1997. | Medium (EC background) |
| [20] | Ye et al. ReEvo: Large language models as hyper-heuristics with reflective evolution. arXiv:2402.01145, 2024. | Medium–high |
| [21] | Mouret, Clune. Illuminating search spaces by mapping elites (MAP-Elites). 2015 (arXiv:1504.04909). | **High** (archive future work) |
| [22] | Yuksekgonul et al. Learning to discover at test time (TTT-Discover). arXiv:2601.16175, 2026. | Medium–high |
| [23] | Silver et al. Mastering the game of Go with deep neural networks and tree search. *Nature* 529(7587):484–489, 2016. | Low (PUCT) |
| [24] | Yang et al. Qwen3 technical report. arXiv:2505.09388, 2025. | Low (GQA configs) |

**Most central to an article on an AVO implementation:** [3] FunSearch, [4] AlphaEvolve,
[2] ELM, [5] EvoPrompting, [18] LoongFlow, [20] ReEvo, [22] TTT-Discover (the paper's own
"related work" in §2.1), [21] MAP-Elites (future-work direction), [13] SWE-agent and
[15]/[16] Claude Code/Codex (the agent side).

**Not cited by the paper** [not in paper]: OpenEvolve, ShinkaEvolve, EvoPrompt (Guo et al.),
KernelBench, Reflexion, Voyager. Our article may cite them as its own related work, but must not
say the AVO paper discusses them.

### 8.2 BibTeX for cited references

arXiv metadata for [4], [10], [17], [18], [21], [22] was checked against the arXiv API on
2026-10-14. Others are transcribed from the paper's reference list.

```bibtex
@article{oneill2010open,
  title   = {Open issues in genetic programming},
  author  = {O'Neill, Michael and Vanneschi, Leonardo and Gustafson, Steven and Banzhaf, Wolfgang},
  journal = {Genetic Programming and Evolvable Machines},
  volume  = {11}, number = {3}, pages = {339--363}, year = {2010}
}

@misc{lehman2022elm,
  title         = {Evolution through Large Models},
  author        = {Lehman, Joel and Gordon, Jonathan and Jain, Shawn and Ndousse, Kamal and
                   Yeh, Cathy and Stanley, Kenneth O.},
  year          = {2022}, eprint = {2206.08896}, archivePrefix = {arXiv}
}

@article{romeraparedes2024funsearch,
  title   = {Mathematical discoveries from program search with large language models},
  author  = {Romera-Paredes, Bernardino and Barekatain, Mohammadamin and Novikov, Alexander and
             Balog, Matej and Kumar, M. Pawan and Dupont, Emilien and Ruiz, Francisco J. R. and
             Ellenberg, Jordan S. and Wang, Pengming and Fawzi, Omar and Kohli, Pushmeet and
             Fawzi, Alhussein},
  journal = {Nature}, volume = {625}, pages = {468--475}, year = {2024},
  doi     = {10.1038/s41586-023-06924-6}
}

@misc{novikov2025alphaevolve,
  title         = {{AlphaEvolve}: A coding agent for scientific and algorithmic discovery},
  author        = {Novikov, Alexander and V{\~u}, Ng{\^a}n and Eisenberger, Marvin and
                   Dupont, Emilien and Huang, Po-Sen and Wagner, Adam Zsolt and
                   Shirobokov, Sergey and Kozlovskii, Borislav and Ruiz, Francisco J. R. and
                   Mehrabian, Abbas and Kumar, M. Pawan and See, Abigail and
                   Chaudhuri, Swarat and Holland, George and Davies, Alex and
                   Nowozin, Sebastian and Kohli, Pushmeet and Balog, Matej},
  year          = {2025}, eprint = {2506.13131}, archivePrefix = {arXiv}
}

@misc{chen2023evoprompting,
  title         = {{EvoPrompting}: Language Models for Code-Level Neural Architecture Search},
  author        = {Chen, Angelica and Dohan, David M. and So, David R.},
  year          = {2023}, eprint = {2302.14838}, archivePrefix = {arXiv}
}

@misc{vaswani2017attention,
  title         = {Attention Is All You Need},
  author        = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob and
                   Jones, Llion and Gomez, Aidan N. and Kaiser, Lukasz and Polosukhin, Illia},
  year          = {2017}, eprint = {1706.03762}, archivePrefix = {arXiv}
}

@misc{dao2022flashattention,
  title         = {{FlashAttention}: Fast and Memory-Efficient Exact Attention with {IO}-Awareness},
  author        = {Dao, Tri and Fu, Daniel Y. and Ermon, Stefano and Rudra, Atri and R{\'e}, Christopher},
  year          = {2022}, eprint = {2205.14135}, archivePrefix = {arXiv}
}

@misc{dao2023flashattention2,
  title         = {{FlashAttention-2}: Faster Attention with Better Parallelism and Work Partitioning},
  author        = {Dao, Tri},
  year          = {2023}, eprint = {2307.08691}, archivePrefix = {arXiv}
}

@misc{shah2024flashattention3,
  title         = {{FlashAttention-3}: Fast and Accurate Attention with Asynchrony and Low-precision},
  author        = {Shah, Jay and Bikshandi, Ganesh and Zhang, Ying and Thakkar, Vijay and
                   Ramani, Pradeep and Dao, Tri},
  year          = {2024}, eprint = {2407.08608}, archivePrefix = {arXiv}
}

@misc{zadouri2026flashattention4,
  title         = {{FlashAttention-4}: Algorithm and Kernel Pipelining Co-Design for Asymmetric
                   Hardware Scaling},
  author        = {Zadouri, Ted and Hoehnerbach, Markus and Shah, Jay and Liu, Timmy and
                   Thakkar, Vijay and Dao, Tri},
  year          = {2026}, eprint = {2603.05451}, archivePrefix = {arXiv}
}

@misc{chetlur2014cudnn,
  title         = {{cuDNN}: Efficient Primitives for Deep Learning},
  author        = {Chetlur, Sharan and Woolley, Cliff and Vandermersch, Philippe and Cohen, Jonathan and
                   Tran, John and Catanzaro, Bryan and Shelhamer, Evan},
  year          = {2014}, eprint = {1410.0759}, archivePrefix = {arXiv}
}

@misc{jimenez2024swebench,
  title         = {{SWE-bench}: Can Language Models Resolve Real-World {GitHub} Issues?},
  author        = {Jimenez, Carlos E. and Yang, John and Wettig, Alexander and Yao, Shunyu and
                   Pei, Kexin and Press, Ofir and Narasimhan, Karthik},
  year          = {2024}, eprint = {2310.06770}, archivePrefix = {arXiv}
}

@misc{yang2024sweagent,
  title         = {{SWE-agent}: Agent-Computer Interfaces Enable Automated Software Engineering},
  author        = {Yang, John and Jimenez, Carlos E. and Wettig, Alexander and Lieret, Kilian and
                   Yao, Shunyu and Narasimhan, Karthik and Press, Ofir},
  year          = {2024}, eprint = {2405.15793}, archivePrefix = {arXiv}
}

@misc{wang2025openhands,
  title         = {{OpenHands}: An Open Platform for {AI} Software Developers as Generalist Agents},
  author        = {Wang, Xingyao and Li, Boxuan and Song, Yufan and Xu, Frank F. and Tang, Xiangru and
                   Zhuge, Mingchen and Pan, Jiayi and Song, Yueqi and Li, Bowen and Singh, Jaskirat and
                   Tran, Hoang H. and Li, Fuqiang and Ma, Ren and Zheng, Mingzhang and Qian, Bill and
                   Shao, Yanjun and Muennighoff, Niklas and Zhang, Yizhe and Hui, Binyuan and
                   Lin, Junyang and Brennan, Robert and Peng, Hao and Ji, Heng and Neubig, Graham},
  year          = {2025}, eprint = {2407.16741}, archivePrefix = {arXiv}
}

@misc{anthropic2025claudecode,
  title        = {Claude 3.7 Sonnet and Claude Code},
  author       = {{Anthropic}},
  year         = {2025}, month = feb,
  howpublished = {\url{https://www.anthropic.com/news/claude-3-7-sonnet}}
}

@misc{openai2025codex,
  title        = {Introducing Codex},
  author       = {{OpenAI}},
  year         = {2025}, month = may,
  howpublished = {\url{https://openai.com/index/introducing-codex/}}
}

@misc{xu2026vibetensor,
  title         = {{VibeTensor}: System Software for Deep Learning, Fully Generated by {AI} Agents},
  author        = {Xu, Bing and Chen, Terry and Zhou, Fengzhe and Chen, Tianqi and Jia, Yangqing and
                   Grover, Vinod and Wu, Haicheng and Liu, Wei and Wittenbrink, Craig and
                   Hwu, Wen-mei and Bringmann, Roger and Liu, Ming-Yu and Ceze, Luis and
                   Lightstone, Michael and Shi, Humphrey},
  year          = {2026}, eprint = {2601.16238}, archivePrefix = {arXiv}
}

@misc{wan2025loongflow,
  title         = {{LoongFlow}: Directed Evolutionary Search via a Cognitive Plan-Execute-Summarize Paradigm},
  author        = {Wan, Chunhui and Dai, Xunan and Wang, Zhuo and Li, Minglei and Wang, Yanpeng and
                   Mao, Yinan and Lan, Yu and Xiao, Zhiwen},
  year          = {2025}, eprint = {2512.24077}, archivePrefix = {arXiv}
}

@book{back1997handbook,
  title     = {Handbook of Evolutionary Computation},
  author    = {B{\"a}ck, Thomas and Fogel, David B. and Michalewicz, Zbigniew},
  publisher = {IOP Publishing and Oxford University Press},
  year      = {1997}
}

@misc{ye2024reevo,
  title         = {{ReEvo}: Large Language Models as Hyper-Heuristics with Reflective Evolution},
  author        = {Ye, Haoran and Wang, Jiarui and Cao, Zhiguang and Berto, Federico and Hua, Chuanbo and
                   Kim, Haeyeon and Park, Jinkyoo and Song, Guojie},
  year          = {2024}, eprint = {2402.01145}, archivePrefix = {arXiv}
}

@misc{mouret2015mapelites,
  title         = {Illuminating search spaces by mapping elites},
  author        = {Mouret, Jean-Baptiste and Clune, Jeff},
  year          = {2015}, eprint = {1504.04909}, archivePrefix = {arXiv}
}

@misc{yuksekgonul2026ttt,
  title         = {Learning to Discover at Test Time},
  author        = {Yuksekgonul, Mert and Koceja, Daniel and Li, Xinhao and Bianchi, Federico and
                   McCaleb, Jed and Wang, Xiaolong and Kautz, Jan and Choi, Yejin and Zou, James and
                   Guestrin, Carlos and Sun, Yu},
  year          = {2026}, eprint = {2601.16175}, archivePrefix = {arXiv}
}

@article{silver2016alphago,
  title   = {Mastering the game of Go with deep neural networks and tree search},
  author  = {Silver, David and Huang, Aja and Maddison, Chris J. and Guez, Arthur and Sifre, Laurent and
             van den Driessche, George and Schrittwieser, Julian and Antonoglou, Ioannis and
             Panneershelvam, Veda and Lanctot, Marc and others},
  journal = {Nature}, volume = {529}, number = {7587}, pages = {484--489}, year = {2016}
}

@misc{yang2025qwen3,
  title         = {Qwen3 Technical Report},
  author        = {Yang, An and others},
  year          = {2025}, eprint = {2505.09388}, archivePrefix = {arXiv}
}
```

Notes on the BibTeX: the paper's [19] entry reads "Release, 97(1):B1, 1997", an odd Google
Scholar artifact; we give the book form instead. The publisher field for [19] is from general
knowledge [uncertain]. The paper gives no year-accurate arXiv id for [21]; 1504.04909 was
checked.

### 8.3 Related work the paper does not cite [not in paper]

Checked against the arXiv API / GitHub API on 2026-10-14.

```bibtex
@inproceedings{guo2024evoprompt,
  title         = {{EvoPrompt}: Connecting {LLMs} with Evolutionary Algorithms Yields Powerful
                   Prompt Optimizers},
  author        = {Guo, Qingyan and Wang, Rui and Guo, Junliang and Li, Bei and Song, Kaitao and
                   Tan, Xu and Liu, Guoqing and Bian, Jiang and Yang, Yujiu},
  booktitle     = {International Conference on Learning Representations (ICLR)},
  year          = {2024}, eprint = {2309.08532}, archivePrefix = {arXiv}
}

@misc{lange2025shinkaevolve,
  title         = {{ShinkaEvolve}: Towards Open-Ended and Sample-Efficient Program Evolution},
  author        = {Lange, Robert Tjarko and Imajuku, Yuki and Cetin, Edoardo},
  year          = {2025}, eprint = {2509.19349}, archivePrefix = {arXiv}
}

@misc{sharma2025openevolve,
  title        = {{OpenEvolve}: an open-source implementation of {AlphaEvolve}},
  author       = {Sharma, Asankhaya},
  year         = {2025},
  howpublished = {\url{https://github.com/algorithmicsuperintelligence/openevolve}},
  note         = {GitHub repository, created 2025-05-15; formerly codelion/openevolve}
}
```

EvoPrompt's ICLR 2024 venue and OpenEvolve's author are from general knowledge [uncertain];
the arXiv titles, authors, ids and the GitHub repo/creation date were checked.

---

## 9. Discrepancies with `docs/avo-paper.md`

The repo summary is a partial, mostly verbatim copy of the abstract, contributions and §3. It
matches the paper where it overlaps. Gaps and nits:

1. It stops after §3.3. It omits §2 (with Eqs. (1) and (2), and the Update operator), §4
   (setup, all results), §5 (ablations), §6, and Appendix A.
2. It keeps the paper's equation numbers (3) and (4) but drops (1) and (2), so a reader may
   wonder where (1)–(2) went.
3. It loses the typography: $\mathcal{P}_t$, $\mathcal{K}$ become plain "Pt", "K"; subscripts
   flatten ("xt +1", "f 1( xi )"). Bold emphasis was added that is not in the paper (e.g.
   "**cuDNN by up to 3.5%**").
4. It drops the §2.1 sentence that AVO is "orthogonal to the choice of population structure",
   which matters for our "single lineage" framing.
5. It drops the §4.1 agent description (unnamed internal agent, "frontier LLMs", tools, memory as
   conversation history). Our article should cite §4.1 for these.
6. It drops Fig. 2's naming of a separate "AVO Supervisor Agent" with "Monitor Stagnation".
7. No factual errors found in the parts it copies.

## 10. Answers to open questions in `docs/paper/outline.md`

- "Does the paper publish code or the supervisor's thresholds?" **No.** No code link, no prompts,
  no thresholds, no trigger counts. The agent is "internally-developed"; its LLMs are unnamed.
- "Its implementation is not public (verify)": confirmed for arXiv v1.
- The paper's supervisor is drawn as a separate agent (Fig. 2) and called "self-supervision
  mechanism" / "the supervisor" in §3.3.
- The paper's acceptance rule is "matches or improves" vs best so far (§3.2), with no stated
  noise floor or vector rule. Any stricter rule in avocode (strict dominance, noise floor) is a
  departure to declare in the fidelity table.
