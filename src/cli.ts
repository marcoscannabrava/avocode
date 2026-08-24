import { doctorCommand } from "./doctor.ts";
import { initCommand } from "./init.ts";
import { installCommand } from "./install.ts";
import type { Io } from "./io.ts";
import { processIo } from "./io.ts";
import { knowCommand } from "./knowledge.ts";
import { bestCommand, commitCommand, lineageCommand } from "./lineage.ts";
import { memCommand } from "./mem.ts";
import { scoreCommand } from "./score.ts";
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
  know [...]        K: 'init', 'query "<q>"', 'add <url|path>', 'search "<q>"', 'reindex'
  version           print the version
  help              print this message

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

avo commit:
  --why <text>      the agent's rationale; lands in the commit body and lineage/vNNN.md
  --dry-run         report the decision without writing anything
  --json --parallel --timeout <s> --no-record --cwd <dir>   as for avo score
  exit codes        0 = committed or no-op, 1 = refused, 2 = harness error

every command supports --json for agent consumption (invariant 3).
`;

export async function main(argv: readonly string[], io: Io = processIo): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      io.out(USAGE);
      return 0;
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
    case "doctor":
      return doctorCommand(rest, io, VERSION);
    case "score":
      return await scoreCommand(rest, io);
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
