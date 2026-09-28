import type { LegendPracticeFinding } from "../../core/types.js";
import type { TrackingScan } from "./model.js";
import { renderReadFinding } from "./render-reads.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

export function findObservableTrackingPractices(scan: TrackingScan): LegendPracticeFinding[] {
  const findings: LegendPracticeFinding[] = [];
  visit(scan.sourceFile, (node) => {
    if (!ts.isCallExpression(node)) {
      return;
    }
    const render = renderReadFinding(node, scan);
    if (render) {
      findings.push(render);
    }
  });
  return findings;
}
