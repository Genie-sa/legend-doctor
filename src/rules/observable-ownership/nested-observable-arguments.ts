import type { LegendFactory, ObservableOwnershipScan } from "./model.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import { callLocation } from "./model.js";
import { provenObservablePath } from "../observable-reads/observable-paths.js";
import type ts from "typescript";

export function nestedObservableArgumentFinding(
  call: ts.CallExpression,
  factory: LegendFactory,
  scan: ObservableOwnershipScan,
): LegendPracticeFinding | null {
  if (call.arguments.length !== 1) {
    return null;
  }
  const path = provenObservablePath(call.arguments[0]!, scan.observableBindings);
  if (!path) {
    return null;
  }
  const { sourceFile } = scan;
  const callee = call.expression.getText(sourceFile);
  const pathText = path.getText(sourceFile);
  return {
    action: "reuse-observable-reference",
    confidence: "certain",
    disposition: "change",
    evidence: [
      `${pathText} is a proven Legend observable path`,
      `${callee}() returns an observable argument unchanged instead of wrapping it, so the call adds no ownership, stability, or context`,
      ...unmountEvidence(factory, pathText),
    ],
    location: callLocation(call, scan),
    message: `Replace \`${callee}(${pathText})\` with \`${pathText}\`; Legend returns the same observable, and one observable belongs inside another only as an intentional link whose reads and writes forward to the source.`,
    practice: "ownership",
  };
}

function unmountEvidence(factory: LegendFactory, pathText: string): string[] {
  return factory === "useObservable"
    ? [
        `useObservable deactivates the node it returns when the component unmounts, and that node is the shared ${pathText}`,
      ]
    : [];
}
