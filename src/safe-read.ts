import { readFileSync, statSync } from "node:fs";

// Files the bot reads back are produced by the bot, but they sit on disk where anything else can write too: a run record,
// a report, the registers, a script, a proposal. A file much larger than any of them can legitimately be would be read whole
// into memory and parsed, so every such read goes through here and has a size cap.

export const READ_LIMITS = {
  /** run.json and report.json hold text only (the HAR and the screenshots are separate files). */
  runRecord: 20_000_000,
  report: 20_000_000,
  /** The registers, scripts and proposals are small by nature. */
  small: 1_000_000,
} as const;

export class TooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TooLargeError";
  }
}

/** Reads a text file, refusing one that is larger than `maxBytes`. */
export function readTextCapped(path: string, maxBytes: number, what: string): string {
  const size = statSync(path).size;
  if (size > maxBytes) throw new TooLargeError(`${what} at ${path} is ${size} bytes, more than the ${maxBytes} byte limit, so it was not read`);
  return readFileSync(path, "utf8");
}
