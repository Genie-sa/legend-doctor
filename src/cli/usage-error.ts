import { CliError, EXIT_INVALID_USAGE, HELP_COMMAND } from "./failures.js";
import type { FailureReason } from "./failures.js";

/** A rejected invocation: bad flag, bad value, or an unscannable target; exit 2 and point at --help. */
export class UsageError extends CliError {
  public constructor(message: string, reason: FailureReason = "invalid_usage") {
    super(message, { exitCode: EXIT_INVALID_USAGE, next: [HELP_COMMAND], reason });
    this.name = "UsageError";
  }
}
