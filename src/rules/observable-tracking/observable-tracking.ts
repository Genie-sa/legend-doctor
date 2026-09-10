import { eagerReactiveInput, eagerReactiveInputFinding } from "./reactive-inputs.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import type { TrackingScan } from "./model.js";
import { findHelperTrackingReviews } from "./helper-tracking.js";
import { renderReadFinding } from "./render-reads.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

export function findObservableTrackingPractices(scan: TrackingScan): LegendPracticeFinding[] {
  const findings: LegendPracticeFinding[] = [...findHelperTrackingReviews(scan)];
  visit(scan.sourceFile, (node) => {
    if (!ts.isCallExpression(node)) {
      return;
    }
    const eager = eagerReactiveInput(node, scan);
    if (eager) {
      findings.push(eagerReactiveInputFinding(eager, scan));
      return;
    }
    const render = renderReadFinding(node, scan);
    if (render) {
      findings.push(render);
    }
  });
  return findings;
}
