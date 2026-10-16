import { doctorCommand } from "./doctor.ts";
import { fanCommand } from "./fan.ts";
import { initCommand } from "./init.ts";
import { installCommand } from "./install.ts";
import type { Io } from "./io.ts";
import { processIo } from "./io.ts";
import { knowCommand } from "./knowledge.ts";
import { bestCommand, commitCommand, lineageCommand } from "./lineage.ts";
import { memCommand } from "./mem.ts";
import { runCommand } from "./run.ts";
import { scoreCommand } from "./score.ts";
import { superviseCommand } from "./supervise.ts";
import { VERSION } from "./version.ts";

export const USAGE = `avo — an AVO-inspired agent harness

usage: avo <command> [options]

commands:
  init [options]    scaffold .avo/, lineage/ and beads in this repo (safe to re-run)
  install [...]     wire avo's skills + AGENTS.md into this repo for pi | claude | codex
  doctor [--json]   report dependency and API-key status; exits 1 if anything required is missing
  score [options]   run .avo/score (the f contract), validate it, record the attempt
  commit [options]  score, compare against the best version, persist it only if it wins
  lineage [...]     list P_t; 'show <n>' one version; 'diff <a> <b>' two of them
  best [--json]     the version every candidate is ranked against
  mem [...]         what the loop remembers; 'add "<insight>"' writes one; 'prime' for a session
  fan [options]     explore N directions at once, one git worktree + headless agent each
  run [options]     the continuous loop: agent turn -> commit -> supervise -> steer -> repeat
  know [...]        K: 'init', 'query "<q>"', 'add <url|path>', 'search "<q>"', 'reindex'
  supervise [...]   detect a stall or a thrash and emit a steering directive that cites P_t and K
  version           print the version
  help [<command>]  print this message, or one command's options (also: <command> --help)

avo score:
  --json            emit the normalized attempt as one JSON line
  --parallel        fan configs out concurrently (needs '.avo/score --configs')
  --timeout <s>     kill the scorer after s seconds (0 = no limit, the default)
  --init <template> scaffold .avo/score from templates/score/ (idempotent; --force to replace)
  --no-record       do not append to .avo/attempts.jsonl
  --cwd <dir>       treat dir as the repo root
  exit codes        0 = pass, 1 = ran but failed, 2 = harness error

avo init:
  --prefix <p>      beads issue prefix (default: the directory name)
  --scorer <t>      also scaffold .avo/score from templates/score/<t>.sh
  --json --cwd <dir>

avo install:
  --agent <a>       pi | claude | codex | all (default all; repeatable, comma-separated)
  --force           replace a symlink or file in the way; never replaces a real directory
  --json --cwd <dir>

avo mem:
  add "<insight>"   remember it (bd remember, or lineage/memory.jsonl without bd)
  --key <k>         explicit memory key, so re-writing it updates in place
  prime             the session-start context (bd prime, or our own digest)
  --json --cwd <dir>

avo know:
  init              index knowledge/ and lineage/ as qmd collections (folded into avo init)
  query "<q>"       search K; hybrid + rerank via qmd, or a local scan without it
  --lexical         BM25 only (qmd search) — no LLM expansion, no rerank
  -n <N>            max hits (default 5); -c <name> one collection; --min-score <s>
  add <url|path>    write knowledge/<slug>.md with provenance frontmatter, then qmd embed
  --name <slug>     name the doc; --force replace a differing one; --no-embed skip qmd embed
  reindex           re-scan the collections into qmd; needed after files land in lineage/
  search "<q>"      web search; --ingest also writes the pages into K (firecrawl only)
  --backend <b>     firecrawl (FIRECRAWL_API_KEY) | searxng (SEARXNG_URL) | ddgs (keyless)
  --json --cwd <dir> --timeout <s>
  exit codes        0 = ran, 1 = refused, 2 = harness error

avo fan:
  --n <k>           how many probes (default 3); they run min(8, cpus-2) at a time
  --prompt-file <f> | --prompt "<text>"   the task every probe is given
  --agent <a>       pi | claude | codex | a custom one from .avo/config.json
                    (default: $AVO_AGENT, the config, then the first on PATH)
  --model <m>       the probe model (default $AVO_PROBE_MODEL); small models are the point
  --timeout <s>     kill a probe's process group after s seconds (default 900, 0 = no limit)
  --keep            keep every worktree; by default the ones nothing changed are removed
  --no-score        do not run .avo/score in each worktree
  --promote <i>     apply probe i's diff to the working tree (--run <id> to pick an older run)
  --resume <id>     re-run the probes an interrupted fan-out never finished
  --list            the runs that survived; --clean <id|all> removes their worktrees
  --json --cwd <dir>
  exit codes        0 = ran, 1 = a guard refused or every probe failed, 2 = harness error
  guards            AVO_FAN_DEPTH (default 3) caps nesting; a repeated prompt is refused as a cycle

avo run:
  --prompt "<text>" | --prompt-file <f>   the task every iteration is given
  --max-iters <n>   how many turns at most (default 10)
  --agent <a>       pi | claude | codex | a custom one from .avo/config.json
                    (default: $AVO_AGENT, the config, then the first on PATH)
  --model <m>       the model each turn runs on (default: the agent's own)
  --timeout <s>     kill a turn's process group after s seconds (default 900, 0 = no limit)
  --stall <n> --thrash <k>   the supervisor's thresholds, as for avo supervise
  --dry-run         print the resolved plan and the first turn prompt; spawn nothing
  --json --cwd <dir>
  exit codes        0 = the loop ran, 1 = a guard refused or no turn got anywhere, 2 = harness error
  stops on          --max-iters, an .avo/STOP file, 3 unchanged iterations in a row, or an agent
                    binary that cannot be started

avo supervise:
  --stall <n>       attempts with no committed improvement before it steers
                    (default: .avo/config.json 'supervise.stall', then 5)
  --thrash <k>      consecutive failures with the same signature before it steers (default 3)
  --json --cwd <dir>
  exit codes        0 = no intervention needed, 1 = a signal fired and a directive was emitted,
                    2 = harness error

avo commit:
  --why <text>      the agent's rationale; lands in the commit body and lineage/vNNN.md
  --dry-run         report the decision without writing anything
  --json --parallel --timeout <s> --no-record --cwd <dir>   as for avo score
  exit codes        0 = committed or no-op, 1 = refused, 2 = harness error

avo lineage:
  show <n>          one version, with its rationale
  diff <a> <b>      the score delta and the patch between two versions
  --json --cwd <dir>
  exit codes        0 = ok, 2 = harness error

avo best:
  --json --cwd <dir>
  exit codes        0 = a best version exists, 1 = no version yet, 2 = harness error

avo doctor:
  --json            the report as one JSON line
  exit codes        0 = ready, 1 = a required dependency is missing, 2 = bad option

every command supports --json for agent consumption (invariant 3).
`;

/** One command's usage stanza, or null. */
export function commandUsage(cmd: string): string | null {
  const start = USAGE.indexOf(`\navo ${cmd}:\n`);
  if (start < 0) return null;
  const end = USAGE.indexOf("\n\n", start + 1);
  return `${USAGE.slice(start + 1, end)}\n`;
}

export async function main(argv: readonly string[], io: Io = processIo): Promise<number> {
  const [cmd, ...rest] = argv;
  // Help wins before any option parser.
  const stanza = cmd === undefined ? null : commandUsage(cmd);
  if (stanza !== null && rest.some((a) => a === "--help" || a === "-h")) {
    io.out(stanza);
    return 0;
  }
  switch (cmd) {
    case undefined:
    case "-h":
    case "--help":
      io.out(USAGE);
      return 0;
    case "help": {
      if (rest[0] === undefined) {
        io.out(USAGE);
        return 0;
      }
      const topic = commandUsage(rest[0]);
      if (topic === null) {
        io.err(`avo: no help for '${rest[0]}'\n\n${USAGE}`);
        return 2;
      }
      io.out(topic);
      return 0;
    }
    case "version":
    case "-v":
    case "--version":
      io.out(`${VERSION}\n`);
      return 0;
    case "init":
      return await initCommand(rest, io);
    case "install":
      return installCommand(rest, io);
    case "mem":
      return await memCommand(rest, io);
    case "know":
      return await knowCommand(rest, io);
    case "fan":
      return await fanCommand(rest, io);
    case "run":
      return await runCommand(rest, io);
    case "doctor":
      return doctorCommand(rest, io, VERSION);
    case "score":
      return await scoreCommand(rest, io);
    case "supervise":
      return await superviseCommand(rest, io);
    case "commit":
      return await commitCommand(rest, io);
    case "lineage":
      return await lineageCommand(rest, io);
    case "best":
      return await bestCommand(rest, io);
    default:
      io.err(`avo: unknown command '${cmd}'\n\n${USAGE}`);
      return 2;
  }
}
