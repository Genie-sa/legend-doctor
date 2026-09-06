import type { SCHEMA_VERSION } from "../core/types.js";

export type FailureReason =
  | "invalid_usage"
  | "scan_failed"
  | "scope_unavailable"
  | "target_not_found"
  | "unsupported_target";

export const EXIT_INVALID_USAGE = 2;

export const EXIT_SCAN_FAILED = 1;

export const EXIT_GATE_FAILED = 3;

export const HELP_COMMAND = "legend-doctor --help";

export interface CliFailure {
  message: string;
  next?: readonly string[];
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
