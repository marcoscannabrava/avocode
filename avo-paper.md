# **AVO: Agentic Variation Operators for Autonomous Evolutionary Search** 

## **Abstract** 

Agentic Variation Operators (AVO) are a new family of evolutionary variation operators that replace the fixed mutation, crossover, and hand-designed heuristics of classical evolutionary search with autonomous coding agents. Rather than confining a language model to **candidate generation within a prescribed pipeline** , AVO instantiates **variation as a self-directed agent loop** that can consult the current lineage, a domain-specific knowledge base, and execution feedback to propose, repair, critique, and verify implementation edits. We evaluate AVO on **attention** , among the most aggressively optimized kernel targets in AI, on NVIDIA Blackwell (B200) GPUs. Over 7 days of continuous autonomous evolution on multi-head attention, AVO discovers kernels that outperform **cuDNN by up to 3.5%** and **FlashAttention-4 by up to 10.5%** across the evaluated configurations. The discovered optimizations transfer readily to grouped-query attention, requiring only **30 minutes** of additional autonomous adaptation and yielding gains of up to **7.0% over cuDNN** and **9.3% over FlashAttention-4** . Together, these results show that agentic variation operators move beyond prior LLM-in-the-loop evolutionary pipelines by elevating the agent from candidate generator to variation operator, and can discover performance-critical micro-architectural optimizations that produce kernels surpassing state-of-the-art expert-engineered attention implementations on today’s most advanced GPU hardware. 

Our contributions are as follows: 

- We introduce Agentic Variation Operators (AVO), a new family of evolutionary variation operators that elevate the agent from candidate generator to variation operator, autonomously exploring domain knowledge, implementing edits, and validating results through iterative interaction with the environment. 

- We achieve state-of-the-art MHA throughput on NVIDIA B200 GPUs across the benchmarked configurations, reaching up to 1668 TFLOPS and outperforming cuDNN by up to 3.5% and FlashAttention-4 by up to 10.5%. Furthermore, we show that the discovered optimizations readily transfer to GQA, requiring only 30 minutes of autonomous adaptation and yielding gains of up to 7.0% over cuDNN and 9.3% over FlashAttention-4. 

- We provide a detailed analysis of the micro-architectural optimizations discovered by the agent under the benchmarked settings, showing the agent performs genuine hardware-level reasoning rather than superficial code transformations. 

## **3 Agentic Variation Operators** 

AVO consolidates the sampling, generation, and evaluation stages of evolutionary search into a single autonomous agent run, eliminating the rigid pipeline that constrains existing approaches. Below we formalize this operator, detail what occurs within a single variation step, and describe the mechanism that enables multi-day autonomous exploration. 

### **3.1 Formulation** 

Previous evolutionary search approaches [3, 4] decompose the variation operator as: 

Vary(Pt) = Generate(Sample(Pt)), (3)

confining the LLM to the `Generate` step within a fixed pipeline. As illustrated in Figure 2, AVO replaces this decomposition with a single autonomous agent run: 

Vary(Pt) = Agent(Pt, K,f), (4)

where Pt = { ( x 1 , **f** ( x 1)) , . . . , ( xt, **f** ( xt )) } is the full lineage of solutions and their scores, K is a domain-specific knowledge base, and **f** is the scoring function. 

In our setting, each xi is a CUDA kernel implementation (source code with inline PTX), and **f** evaluates a candidate along two dimensions: numerical correctness against a reference implementation, and throughput in TFLOPS on the target hardware. In practice, **f** ( xi ) = ( f 1( xi ) , f 2( xi ) , . . . , fn ( xi )) is an n -dimensional vector and fj represents the score for test configuration j . A candidate xi that fails correctness is assigned zero score (i.e., fj ( xi ) = 0) regardless of throughput. The knowledge base K contains CUDA programming guides, PTX ISA documentation, Blackwell architecture specifications, and existing kernel implementations including FlashAttention-4 source code. 

AVO defines a family of agentic variation operators for evolutionary search. In this work, we instantiate AVO in a single-lineage autonomous run starting from a seed program x 0, producing a 

sequence of committed improvements x 1 , x 2 , . . . , xt . The accumulated lineage Pt serves as context for subsequent variation steps. 

### **3.2 Anatomy of a Variation Step** 

A single variation step in AVO, producing xt +1 from the current lineage Pt , is an autonomous agent loop. The agent is a general-purpose coding agent with planning, tool use, and persistent memory (details in Section 4), and a single step may involve numerous internal actions. 

We observe that the agent frequently examines multiple prior implementations in Pt within a single variation step, comparing their profiling characteristics to identify bottlenecks and opportunities, and consulting documentation in K to understand the relevant hardware constraints before implementing a candidate optimization. The agent then invokes **f** to test the result. When a candidate fails correctness checks or fails to improve on the current benchmark suite, the agent diagnoses the issue and revises its approach, repeating this edit-evaluate-diagnose cycle until it commits a satisfactory xt +1. This design allows the agent to adapt its optimization strategy as the search progresses: early steps may focus on structural changes informed by reference implementations in K , while later steps can shift toward micro-architectural tuning guided by profiling feedback from **f** and patterns observed across the accumulated lineage Pt . 

In our current implementation, we persist a new committed version only when it passes correctness checks and matches or improves the benchmark score relative to the best committed version so far; unsuccessful intermediate attempts remain part of the agent’s internal search trajectory but are not added to the committed lineage. 

### **3.3 Continuous Evolution** 

Although AVO is defined at the level of variation operators for evolutionary search, the present study evaluates a single-lineage continuous instantiation, leaving population-level branching and archive management to future extensions. The AVO agent operates as a continuous loop that periodically produces new solutions without human intervention. Each committed version xi is persisted as a git commit along with its score, maintaining full state continuity across the entire evolutionary process. 

In long-running autonomous optimization, two failure modes can impede progress: the agent may stall when it exhausts its current line of exploration, or it may enter unproductive cycles of edits that repeatedly fail to improve scores. To mitigate both, AVO incorporates a self-supervision mechanism that detects these scenarios and intervenes. Once triggered, the mechanism reviews the overall evolutionary trajectory and steers the search toward several candidate optimization directions. This conditional intervention effectively redirects exploration with fresh perspective when the current strategy has plateaued. 

The 7-day run that produced our final multi-head attention kernel spanned 40 successive versions. Throughout this process, the main agent autonomously decided when to attempt new optimizations, when to revisit earlier approaches in Pt , and when to shift strategy, while the supervisor maintained forward progress by intervening during periods of stagnation. 