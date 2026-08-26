# AVO: Agentic Variation Operators

## The AVO architecture

### The limits of classical EVO
In LLM-augmented evolutionary approaches (FunSearch, AlphaEvolve), the LLM is restricted to a
`Generate` step; the framework handles `Sample` and `Update`. Single-turn generation prevents the LLM
from:
* consulting reference documentation;
* debugging compilation or correctness failures iteratively;
* adapting its strategy on profiling feedback before committing a candidate.

### The AVO paradigm
AVO fuses sampling, generation and evaluation into one agent loop: `Vary(P_t) = Agent(P_t, K, f)`.
* **`P_t` (lineage):** committed solutions and their scores, in order.
* **`K` (knowledge base):** CUDA/PTX docs, hardware specs, reference implementations.
* **`f` (scoring function):** numerical correctness and throughput (TFLOPS).

### Continuous evolution and self-supervision
Two components sustain multi-day optimization without human intervention:
1. **Main agent loop:** plan, implement, evaluate, fix, repeat.
2. **Supervisor agent:** detects stagnation or unproductive edit cycles, then intervenes to redirect
   the main agent.

---

## Implementing AVO via Pi extensions

Pi (pi.dev) is a minimal, extensible coding agent harness. TypeScript extensions map the AVO
architecture onto Pi's lifecycle and tool execution models. Three approaches, using `ExtensionAPI`:

### Approach 1: define the AVO tools
The agent needs tools to fetch knowledge (`K`), read lineage (`P_t`) and evaluate kernels (`f`).

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

### Approach 2: build the supervisor via event interception
Extensions intercept the `tool_call` event to track progress silently. If the TFLOPS score has not
improved in `N` turns, inject a steering message.

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

### Approach 3: delegated sub-agents (`pi-subagents`, `pi-crew`)

**Do not attempt this.** It has been tried; these extensions do not work well enough. Read
`pi-subagents` for inspiration only.