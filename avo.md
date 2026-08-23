# AVO: Agentic Variation Operators

## Deconstructing the AVO Architecture

### The Limitations of Classical EVO
In classical Large Language Model-augmented evolutionary approaches (e.g., FunSearch, AlphaEvolve), the LLM is restricted to a `Generate` step. The framework handles `Sample` (selecting parents) and `Update` (evaluating and managing population). This single-turn generation prevents the LLM from:
* Proactively consulting reference documentation.
* Debugging compilation or correctness failures iteratively.
* Adapting its strategy based on profiling feedback before committing a candidate.

### The AVO Paradigm
AVO fuses sampling, generation, and evaluation into a continuous agent loop. The operator is defined as `Vary(P_t) = Agent(P_t, K, f)`, where:
* **`P_t` (Lineage):** The historical sequence of committed solutions and their performance scores.
* **`K` (Knowledge Base):** Domain-specific resources (CUDA/PTX docs, hardware specs, reference implementations).
* **`f` (Scoring Function):** Dual-metric evaluation covering numerical correctness and hardware throughput (TFLOPS).

### Continuous Evolution & Self-Supervision
To sustain multi-day optimization without human intervention, AVO relies on two components:
1. **Main Agent Loop:** Iteratively cycles through Planning, Implementation, Evaluation, and Bug-Fixing.
2. **Supervisor Agent:** A monitoring mechanism that detects evolutionary stagnation or unproductive edit cycles. Upon detection, it performs conditional intervention to redirect the main agent toward fresh optimization vectors.

---

## Implementing AVO via Pi (pi.dev) Extensions

Pi (pi.dev) is a minimal, highly extensible coding agent harness. By writing TypeScript extensions for Pi, we can map the AVO architecture directly into Pi's lifecycle and tool execution models. 

Below are the recommended approaches for building an AVO extension using the `ExtensionAPI`.

### Approach 1: Defining the AVO Tools
The AVO agent requires tools to fetch knowledge (`K`), read lineage (`P_t`), and evaluate kernels (`f`). 

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export default function (pi: ExtensionAPI) {
  
  // 1. Tool: Evaluate Candidate (f)
  pi.registerTool({
    name: "evaluate_kernel",
    description: "Compiles the current CUDA kernel and runs the scoring function to get TFLOPS and correctness.",
    inputSchema: Type.Object({
      source_file: Type.String({ description: "Path to the .cu file" })
    }),
    handler: async ({ source_file }) => {
      try {
        const { stdout } = await execAsync(`python3 benchmark_attn.py --kernel ${source_file}`);
        return { text: `Evaluation Results:\n${stdout}` };
      } catch (e) {
        return { text: `Compilation or Runtime Error:\n${e.message}` };
      }
    }
  });

  // 2. Tool: Query Knowledge Base (K)
  pi.registerTool({
    name: "query_hardware_docs",
    description: "Search Blackwell architecture and PTX ISA documentation.",
    inputSchema: Type.Object({
      query: Type.String()
    }),
    handler: async ({ query }) => {
      // Implementation of RAG lookup against CUDA/PTX docs
      return { text: `Search results for ${query}...` };
    }
  });
}
```

### Approach 2: Building the Supervisor Agent via Event Interception
AVO requires a "Supervisor" to prevent stagnation. In Pi, extensions can intercept the `tool_call` event to silently track the agent's progress. If the TFLOPS score hasn't improved in `N` turns, the extension can inject a steering message.

```typescript
export default function (pi: ExtensionAPI) {
  let bestScore = 0;
  let attemptsSinceImprovement = 0;

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "evaluate_kernel") {
      const result = await event.result;
      const currentScore = extractTflops(result.text); // User-defined helper
      
      if (currentScore > bestScore) {
        bestScore = currentScore;
        attemptsSinceImprovement = 0;
        ctx.ui.notify(`New Best Kernel: ${bestScore} TFLOPS!`, "success");
      } else {
        attemptsSinceImprovement++;
      }
      
      // Supervisor Intervention
      if (attemptsSinceImprovement >= 5) {
        ctx.ui.notify("Stagnation detected. Injecting Supervisor intervention.", "warn");
        // Force the agent to pivot using Pi's terminal UI commands
        await ctx.ui.runCommand("/steer Your recent attempts have plateaued. Please analyze the register allocation and pipeline overlap before making the next modification.");
        attemptsSinceImprovement = 0;
      }
    }
  });
}
```

### Approach 3: Delegated Sub-Agents (Using `pi-subagents` or `pi-crew`)

Do not attempt this approach. It's been tried and these extensions do not work well enough.

`pi-subagents` can be explored as inspiration.