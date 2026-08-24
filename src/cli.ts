import { doctorCommand } from "./doctor.ts";
import type { Io } from "./io.ts";
import { processIo } from "./io.ts";
import { VERSION } from "./version.ts";

export const USAGE = `avo — an AVO-inspired agent harness

usage: avo <command> [options]

commands:
  doctor [--json]   report dependency and API-key status; exits 1 if anything required is missing
  version           print the version
  help              print this message

every command supports --json for agent consumption (invariant 3).
`;

export function main(argv: readonly string[], io: Io = processIo): number {
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
    default:
      io.err(`avo: unknown command '${cmd}'\n\n${USAGE}`);
      return 2;
  }
}
