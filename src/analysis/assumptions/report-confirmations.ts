import type { HookFinding, ReportConfirmations, StateAssumption } from "../../core/types.js";
import type { ConfirmationSet } from "./confirmations.js";

function assumptionsOf(findings: readonly HookFinding[]): StateAssumption[] {
  return findings.flatMap((finding) => (finding.assumption ? [finding.assumption] : []));
}

/** Summarizes how the supplied answers matched the assumptions this scan produced. */
export function reportConfirmations(
  confirmations: ConfirmationSet,
  findings: readonly HookFinding[],
): ReportConfirmations {
  const assumptions = assumptionsOf(findings);
  const seen = new Set(assumptions.map((assumption) => assumption.id));
  const count = (status: StateAssumption["status"]): number =>
    assumptions.filter((assumption) => assumption.status === status).length;
  return {
    applied: count("confirmed"),
    rejected: count("rejected"),
    source: confirmations.source,
    stale: count("stale"),
    unmatched: confirmations.ids.filter((id) => !seen.has(id)).toSorted(),
  };
}
