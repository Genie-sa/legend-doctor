import path from "node:path";

export const SCAN_PHASES = ["analyze", "index", "parse"] as const;

export type ScanPhase = (typeof SCAN_PHASES)[number];

/** An exception raised while one source file was in one scan phase. */
export class ScanFileError extends Error {
  public readonly file: string;
  public readonly phase: ScanPhase;

  public constructor(phase: ScanPhase, file: string, options: { readonly cause: unknown }) {
    const reason = options.cause instanceof Error ? options.cause.message : String(options.cause);
    super(`${phase} failed for ${file}: ${reason}`, options);
    this.name = "ScanFileError";
    this.file = file;
    this.phase = phase;
  }

  public relativeTo(root: string): ScanFileError {
    return new ScanFileError(this.phase, path.relative(root, this.file), { cause: this.cause });
  }
}

/** Runs one file's phase, attributing an escaping exception to the innermost file and phase. */
export function inScanPhase<Result>(phase: ScanPhase, file: string, run: () => Result): Result {
  try {
    return run();
  } catch (error) {
    throw error instanceof ScanFileError ? error : new ScanFileError(phase, file, { cause: error });
  }
}
