import { doctorCommand } from "./doctor.ts";
import type { Io } from "./io.ts";
import { processIo } from "./io.ts";
import { bestCommand, commitCommand, lineageCommand } from "./lineage.ts";
import { scoreCommand } from "./score.ts";
import { VERSION } from "./version.ts";

export const USAGE = `avo — an AVO-inspired agent harness

usage: avo <command> [options]

commands:
  doctor [--json]   report dependency and API-key status; exits 1 if anything required is missing
  score [options]   run .avo/score (the f contract), validate it, record the attempt
  commit [options]  score, compare against the best version, persist it only if it wins
  lineage [...]     list P_t; 'show <n>' one version; 'diff <a> <b>' two of them
  best [--json]     the version every candidate is ranked against
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
