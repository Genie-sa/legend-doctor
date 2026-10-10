import type { ObservableReadScan, UseValueDeclaration } from "./model.js";
import {
  UNPROVEN_VALUES,
  controlFlowElement,
  controlFlowSlot,
  elidedReadNote,
  wholeHostChildSlot,
} from "../control-flow-components/control-flow-slots.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import type { MoveDownTarget } from "./subscription-leaf-targets.js";
import { lineOf } from "../../core/ast.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

/**
 * A subscription that moves behind a complete conditional JSX slot moves into `Show`, which is
 * the always-mounted wrapper the slot needs: it subscribes in the slot's position, evaluates the
 * slot's own truthiness, and creates the selected branch only while it is selected.
 */
export function controlFlowMoveDownFinding(
  use: UseValueDeclaration,
  target: MoveDownTarget,
  { finding, scan }: { finding: LegendPracticeFinding; scan: ObservableReadScan },
): LegendPracticeFinding | null {
  const [argument] = use.call.arguments;
  const slot =
    !target.leaf && ts.isExpression(target.node)
      ? wholeHostChildSlot(target.node, scan.imports)
      : null;
  const read = {
    observable: use.observable.getText(scan.sourceFile),
    references: target.references,
    values: UNPROVEN_VALUES,
  };
  const control =
    slot && argument && unwrapTransparentExpression(argument) === use.observable
      ? controlFlowSlot(slot, read)
      : null;
  if (!slot || !argument || !control) {
    return null;
  }
  const subscription = `${use.call.expression.getText(scan.sourceFile)}(${argument.getText(scan.sourceFile)})`;
  return {
    ...finding,
    evidence: [
      ...finding.evidence,
      "Show re-renders with the owner, evaluates the slot's truthiness, and creates the selected branch from one position, so each branch keeps its mount behavior",
    ],
    message: `Replace the complete conditional JSX slot at line ${lineOf(slot, scan.sourceFile)} with \`${controlFlowElement(control, read)}\` and remove the owner's \`${subscription}\`; \`Show\` subscribes in its place, so updates rerender ${target.leafElements} JSX element${target.leafElements === 1 ? "" : "s"} instead of the ${target.ownerElements}-element owner.${elidedReadNote(control, read)}`,
  };
}
