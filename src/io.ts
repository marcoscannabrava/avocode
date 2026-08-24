/** Output sink, injectable so commands are testable without capturing process streams. */
export interface Io {
  out(s: string): void;
  err(s: string): void;
}

export const processIo: Io = {
  out: (s) => void process.stdout.write(s),
  err: (s) => void process.stderr.write(s),
};

/** Collects everything written, for assertions in tests. */
export function bufferIo(): Io & { stdout: string; stderr: string } {
  const io = {
    stdout: "",
    stderr: "",
    out(s: string) {
      io.stdout += s;
    },
    err(s: string) {
      io.stderr += s;
    },
  };
  return io;
}
