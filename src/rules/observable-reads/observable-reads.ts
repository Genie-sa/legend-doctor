import type { InstalledLegendState, LegendPracticeFinding } from "../../core/types.js";
import { directUseValueFinding, directUseValueInput } from "./use-value-inputs.js";
import { localDeclarationPaths, localPrimitivePaths } from "./primitive-paths.js";
import { localPlainConstants, plainSeedPaths } from "./plain-seed-paths.js";
import {
  nonTrackingSnapshotFinding,
  nonTrackingSnapshotObservable,
} from "./non-tracking-snapshots.js";
import type { ChildContractResolver } from "../child-contract/model.js";
import type { DirectUseValueInput } from "./use-value-inputs.js";
import type { HookImports } from "../../core/imports.js";
import { NO_OBSERVABLE_FIELD_FACTS } from "./field-writes.js";
import type { ObservableFieldFacts } from "./field-writes.js";
import type { ObservableReadScan } from "./model.js";
import type { SubscriptionInventory } from "../../core/subscriptions.js";
import { isCanonicalUseValueCall } from "./observable-paths.js";
import { moveUseValueDownFinding } from "./move-down.js";
import { moveUseValueIntoChildFinding } from "./move-into-child.js";
import { narrowUseValueFinding } from "./narrow-use-value.js";
import { subscriptionInventory } from "./subscription-inventory.js";
import ts from "typescript";
import { unrenderedUseValueFinding } from "./unrendered-subscriptions.js";
import { visit } from "../../core/ast.js";

export interface ObservableReadRequest {
  readonly inventory?: SubscriptionInventory[] | undefined;
  readonly primitivePaths?: ReadonlySet<string>;
  readonly plainSeedPaths?: ReadonlySet<string>;
  readonly plainConstants?: ReadonlySet<string> | undefined;
  readonly childContracts?: ChildContractResolver | null;
  readonly fileName: string;
  readonly imports: HookImports;
  /** Null when no installed or locked Legend State version was resolved. */
  readonly installedLegendState?: InstalledLegendState | null;
  readonly observableBindings: ReadonlySet<string>;
  readonly observableFields?: ObservableFieldFacts;
  readonly sourceFile: ts.SourceFile;
}

export function findObservableReadPractices(
  request: ObservableReadRequest,
): LegendPracticeFinding[] {
  const { sourceFile } = request;
  const plainConstants = request.plainConstants ?? localPlainConstants(sourceFile);
  const scan: ObservableReadScan = {
    ...request,
    primitivePaths: new Set([
      ...(request.primitivePaths ?? []),
      ...localPrimitivePaths(sourceFile, request.observableBindings),
    ]),
    plainSeedPaths: new Set([
      ...(request.plainSeedPaths ?? []),
      ...localDeclarationPaths(sourceFile, request.observableBindings, (declaration) =>
        plainSeedPaths(declaration, plainConstants),
      ),
    ]),
    childContracts: request.childContracts ?? null,
    installedLegendState: request.installedLegendState ?? null,
    observableFields: request.observableFields ?? NO_OBSERVABLE_FIELD_FACTS,
  };
  const findings: LegendPracticeFinding[] = [];
  visit(sourceFile, (node) => {
    collectReadFindings(node, scan, findings);
  });
  request.inventory?.push(...subscriptionInventory(scan, findings));
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
      narrowUseValueFinding(node, scan) ??
      unrenderedUseValueFinding(node, scan);
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
  if (directInput && !legacyMigrationCollapsesSelector(call, directInput, scan)) {
    findings.push(directUseValueFinding(call, directInput, scan));
  }
  const snapshot = nonTrackingSnapshotObservable(call, scan);
  if (snapshot) {
    findings.push(nonTrackingSnapshotFinding(call, snapshot, scan));
  }
}

/**
 * `replace-legacy-use-value` already rewrites a legacy call's direct selector to the observable
 * whenever the package exports `useValue`, so a second finding would repeat that instruction.
 */
function legacyMigrationCollapsesSelector(
  call: ts.CallExpression,
  input: DirectUseValueInput,
  scan: ObservableReadScan,
): boolean {
  return (
    input.kind === "selector" &&
    !isCanonicalUseValueCall(call, scan.imports) &&
    scan.installedLegendState?.useValueExport !== "missing"
  );
}
