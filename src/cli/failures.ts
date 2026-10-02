import type { SCHEMA_VERSION } from "../core/types.js";
import type { ScanPhase } from "../project/scan-failure.js";

export const FAILURE_REASONS = [
  "invalid_usage",
  "scan_failed",
  "scope_unavailable",
  "target_not_found",
  "unsupported_target",
] as const;

export type FailureReason = (typeof FAILURE_REASONS)[number];

export const EXIT_INVALID_USAGE = 2;

export const EXIT_SCAN_FAILED = 1;

export const EXIT_GATE_FAILED = 3;

export const HELP_COMMAND = "legend-doctor --help";

export interface CliFailure {
  /** The source file a `scan_failed` was raised in, relative to the scan root. */
  file?: string;
  message: string;
  next?: readonly string[];
  phase?: ScanPhase;
  reason: FailureReason;
  schemaVersion: typeof SCHEMA_VERSION;
  status: "error";
}

export interface CliErrorOptions {
  readonly exitCode: number;
  /** Commands the user can run next, printed after the message. */
  readonly next?: readonly string[];
  readonly reason: FailureReason;
}

export class CliError extends Error {
  public readonly exitCode: number;
  public readonly next: readonly string[];
  public readonly reason: FailureReason;

  public constructor(message: string, { exitCode, next = [], reason }: CliErrorOptions) {
    super(message);
    this.name = "CliError";
    this.reason = reason;
    this.exitCode = exitCode;
    this.next = next;
  }
}
