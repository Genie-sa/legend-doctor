import type { AnalysisReport, SourceLocation } from "../../src/core/types.js";
import type { ReplayCase, ReplayCommit } from "../corpus/contracts.js";
import path from "node:path";

export interface ReplayOutcome {
  commit: ReplayCommit;
  /** A proven `change` finding at the location carries the case action or an equivalent. */
  flagged: boolean;
  /** Everything the analyzer reported at the location, including abstentions and blockers. */
  received: readonly string[];
  replayCase: ReplayCase;
}

type LineLocation = Pick<SourceLocation, "file" | "line">;

function isAt(location: LineLocation, replayCase: ReplayCase): boolean {
  return location.file === path.normalize(replayCase.file) && location.line === replayCase.line;
}

function provenActions(report: AnalysisReport, replayCase: ReplayCase): Set<string> {
  return new Set(
    [...report.findings, ...report.practices]
      .filter((finding) => finding.disposition === "change" && isAt(finding.location, replayCase))
      .map((finding) => finding.action),
  );
}

function withDetail(label: string, details: readonly string[]): string {
  return details.length === 0 ? label : `${label} (${details.join(", ")})`;
}

function receivedAt(report: AnalysisReport, replayCase: ReplayCase): string[] {
  const hooks = report.findings
    .filter((finding) => isAt(finding.location, replayCase))
    .map((finding) =>
      withDetail(
        `${finding.action} [${finding.disposition}]`,
        finding.abstentionReason ? [finding.abstentionReason] : [],
      ),
    );
  const practices = report.practices
    .filter((finding) => isAt(finding.location, replayCase))
    .map((finding) => `${finding.action} [${finding.disposition}]`);
  const subscriptions = (report.subscriptionAnalysis?.inventory ?? [])
    .filter((entry) => isAt(entry.location, replayCase))
    .map((entry) => withDetail(`subscription ${entry.status}`, entry.reasons));
  return [...hooks, ...practices, ...subscriptions];
}

export function acceptedActions(replayCase: ReplayCase): readonly string[] {
  return replayCase.expected === "excluded"
    ? []
    : [replayCase.action, ...(replayCase.equivalents ?? [])];
}

export function scoreReplayCase(
  report: AnalysisReport,
  commit: ReplayCommit,
  replayCase: ReplayCase,
): ReplayOutcome {
  const proven = provenActions(report, replayCase);
  return {
    commit,
    flagged: acceptedActions(replayCase).some((action) => proven.has(action)),
    received: receivedAt(report, replayCase),
    replayCase,
  };
}

/** A label whose parent line lost its source text points at a different hook; fail it loudly. */
export function labelDrift(
  commit: ReplayCommit,
  replayCase: ReplayCase,
  sourceLine: string | null,
): string | null {
  if (sourceLine?.includes(replayCase.source)) {
    return null;
  }
  return `${commit.repository}@${commit.commit.slice(0, 7)} ${replayCase.file}:${replayCase.line}: parent line does not contain \`${replayCase.source}\``;
}
