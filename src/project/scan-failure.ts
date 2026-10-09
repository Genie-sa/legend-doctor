import type { ScanPhase, SkippedFile } from "../core/types.js";

export type ScanPhaseOutcome<Result> =
  | { readonly ok: true; readonly value: Result }
  | { readonly ok: false; readonly skipped: SkippedFile };

/** Runs one file's phase so an exception skips that file instead of failing the whole scan. */
export function runScanPhase<Result>(
  phase: ScanPhase,
  file: string,
  run: () => Result,
): ScanPhaseOutcome<Result> {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, skipped: { file, message, phase } };
  }
}
