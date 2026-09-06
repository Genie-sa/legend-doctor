import { directUseValueFinding, directUseValueInput } from "./use-value-inputs.js";
import {
  nonTrackingSnapshotFinding,
  nonTrackingSnapshotObservable,
} from "./non-tracking-snapshots.js";
import type { ChildContractResolver } from "../child-contract/model.js";
import type { HookImports } from "../../core/imports.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import type { ObservableReadScan } from "./model.js";
import { moveUseValueDownFinding } from "./move-down.js";
import { moveUseValueIntoChildFinding } from "./move-into-child.js";
import { narrowUseValueFinding } from "./narrow-use-value.js";
import { splitUseValueResultFinding } from "./fresh-selector-results.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

export interface ObservableReadRequest {
  readonly childContracts?: ChildContractResolver | null;
  readonly fileName: string;
  readonly imports: HookImports;
  readonly observableBindings: ReadonlySet<string>;
  readonly observableKeys?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly sourceFile: ts.SourceFile;
}

export function findObservableReadPractices(
  request: ObservableReadRequest,
): LegendPracticeFinding[] {
  const { sourceFile } = request;
  const scan: ObservableReadScan = {
    ...request,
    childContracts: request.childContracts ?? null,
    observableKeys: request.observableKeys ?? new Map(),
  };
  const findings: LegendPracticeFinding[] = [];
  visit(sourceFile, (node) => {
    collectReadFindings(node, scan, findings);
  });
  return findings;
}

function collectReadFindings(
  node: ts.Node,
  scan: ObservableReadScan,
  findings: LegendPracticeFinding[],
): void {
  if (ts.isCallExpression(node)) {
    collectCallFindings(node, scan, findings);
  }
  if (ts.isVariableDeclaration(node)) {
    const finding =
      moveUseValueIntoChildFinding(node, scan) ??
      moveUseValueDownFinding(node, scan) ??
      narrowUseValueFinding(node, scan);
    if (finding) {
      findings.push(finding);
    }
  }
}

function collectCallFindings(
  call: ts.CallExpression,
  scan: ObservableReadScan,
  findings: LegendPracticeFinding[],
): void {
  const directInput = directUseValueInput(call, scan.imports, scan.observableBindings);
  if (directInput) {
    findings.push(directUseValueFinding(call, directInput, scan));
  }
  const split = splitUseValueResultFinding(call, scan);
  if (split) {
    findings.push(split);
  }
  const snapshot = nonTrackingSnapshotObservable(call, scan);
  if (snapshot) {
    findings.push(nonTrackingSnapshotFinding(call, snapshot, scan));
  }
}
