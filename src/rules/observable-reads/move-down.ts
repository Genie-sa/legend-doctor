import type { JsxSubtree, ObservableReadScan, UseValueDeclaration } from "./model.js";
import {
  bindingDeclarationCount,
  isDeclarationName,
  staticPropertyPath,
} from "../../core/analysis-ast.js";
import {
  directGetReceiver,
  identifiedUseValueDeclaration,
  isUseValueCall,
  isValueReferenceTo,
  outermostTransparentParent,
  provenObservablePath,
} from "./observable-paths.js";
import { findAncestor, isRuntimeFunctionLike, visit } from "../../core/ast.js";
import {
  isSafeJsxProjectionReference,
  jsxElementCount,
  lowestCommonJsxSubtree,
  nearestRepeatedRenderCall,
} from "../state-proofs/jsx-subtrees.js";
import type { HookImports } from "../../core/imports.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import type { MoveDownTarget } from "./subscription-leaf-targets.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { SubscriptionFlow } from "./subscription-flow.js";
import { directUseValueInput } from "./use-value-inputs.js";
import { isInsideOwnerReturn } from "./conditional-jsx-slots.js";
import { moveDownTargets } from "./subscription-leaf-targets.js";
import { subscriptionCut } from "./subscription-cut.js";
import { subscriptionFlow } from "./subscription-flow.js";
import ts from "typescript";

const MIN_LEAF_OWNER_ELEMENTS = 12;

export function moveUseValueDownFinding(
  declaration: ts.VariableDeclaration,
  scan: ObservableReadScan,
): LegendPracticeFinding | null {
  const use = identifiedUseValueDeclaration(declaration, scan);
  if (
    !use ||
    bindingDeclarationCount(use.owner, use.localName) !== 1 ||
    jsxElementCount(use.owner) < MIN_LEAF_OWNER_ELEMENTS ||
    hasAncestorUseValueSubscription(use.call, use.owner, scan)
  ) {
    return null;
  }
  return flowFinding(use, scan);
}

function flowFinding(
  use: UseValueDeclaration,
  scan: ObservableReadScan,
): LegendPracticeFinding | null {
  const flow = subscriptionFlow(use, scan);
  const directReferences = projectedValueReferences(use);
  const references =
    directReferences ??
    (flow.blockers.size === 0 && flow.derivations.length > 0 ? flow.renderReads : null);
  if (references === null) {
    return null;
  }
  const targets = moveDownTargets(references, use, { scan, flow });
  if (
    targets.length === 0 ||
    (targets.length > 1 && flow.derivations.some((derivation) => derivation.kind === "useMemo"))
  ) {
    return null;
  }
  return annotateFlowFinding(flow, targets, scan);
}

function annotateFlowFinding(
  flow: SubscriptionFlow,
  targets: readonly MoveDownTarget[],
  scan: ObservableReadScan,
): LegendPracticeFinding {
  const { use } = flow;
  const finding =
    targets.length === 1
      ? moveDownFinding(use, targets[0]!, scan)
      : multipleLeavesFinding(use, targets, scan);
  finding.subscription = subscriptionCut(flow, targets, scan);
  if (flow.derivations.length > 0) {
    const declarations = flow.derivations
      .map((item) => `${item.declaration.name.getText()} (${item.kind})`)
      .join(", ");
    return {
      ...finding,
      message: `${finding.message} Move the complete derivation chain with the subscription: ${declarations}. Preserve useMemo dependencies and keep memo ownership in the single stable child. Remove these derived bindings from the parent; every consumer is covered.`,
    };
  }
  return finding;
}

function projectedValueReferences(use: UseValueDeclaration): readonly ts.Identifier[] | null {
  const references: ts.Identifier[] = [];
  let unsafe = false;
  visit(use.owner.body, (node) => {
    if (unsafe || !isValueReferenceTo(node, use.localName, use.declaration.name)) {
      return;
    }
    if (
      isDeclarationName(node) ||
      !isWholeValueProjection(node) ||
      !isRenderProjection(node, use.owner) ||
      nearestRepeatedRenderCall(node, use.owner)
    ) {
      unsafe = true;
      return;
    }
    references.push(node);
  });
  return unsafe || references.length === 0 ? null : references;
}

function isRenderProjection(reference: ts.Identifier, owner: RuntimeFunctionLike): boolean {
  if (
    findAncestor(reference, isRuntimeFunctionLike) !== owner ||
    !isInsideOwnerReturn(reference, owner)
  ) {
    return false;
  }
  // Stop at the nearest element: an enclosing JSX-valued prop may contain unrelated event commands.
  const boundary = lowestCommonJsxSubtree([reference], owner);
  return boundary !== null && isSafeJsxProjectionReference(reference, boundary);
}

function jsxLeafLabel(leaf: JsxSubtree, sourceFile: ts.SourceFile): string {
  if (ts.isJsxFragment(leaf)) {
    return "fragment";
  }
  const tagName = ts.isJsxElement(leaf) ? leaf.openingElement.tagName : leaf.tagName;
  return `<${tagName.getText(sourceFile)}>`;
}

function moveDownFinding(
  use: UseValueDeclaration,
  target: MoveDownTarget,
  scan: ObservableReadScan,
): LegendPracticeFinding {
  const { line, character } = scan.sourceFile.getLineAndCharacterOfPosition(
    use.declaration.getStart(scan.sourceFile),
  );
  const leafLine =
    scan.sourceFile.getLineAndCharacterOfPosition(target.node.getStart(scan.sourceFile)).line + 1;
  const leafLabel = target.leaf
    ? jsxLeafLabel(target.leaf, scan.sourceFile)
    : "complete conditional JSX slot";
  const reads = target.references.length;
  const readEvidence = `${reads} render read${reads === 1 ? "" : "s"} of ${use.localName} occur${reads === 1 ? "s" : ""} only inside the ${target.leaf ? `stable ${leafLabel} leaf` : leafLabel} at line ${leafLine}`;
  const lifetimeEvidence = target.leaf
    ? `that leaf contains ${target.leafElements} of the owner's ${target.ownerElements} JSX elements and is not conditional, keyed, repeated, or split across returns`
    : `replacing the complete conditional JSX slot with one always-mounted wrapper preserves the subscription lifetime and the conditional child's mount behavior`;
  const observable = use.call.arguments[0]!.getText(scan.sourceFile);
  return {
    action: "move-use-value-down",
    confidence: "certain",
    disposition: "change",
    evidence: [readEvidence, lifetimeEvidence],
    location: { column: character + 1, file: scan.fileName, line: line + 1 },
    message: `Move \`useValue(${observable})\` for \`${use.localName}\` into ${target.leaf ? "a stable wrapper around" : "an always-mounted wrapper for"} the ${leafLabel} at line ${leafLine}; keep observable ownership where it is and pass ${target.leaf ? "the leaf's other inputs" : "non-observable gate values"} as ordinary props so updates rerender ${target.leafElements} JSX element${target.leafElements === 1 ? "" : "s"} instead of the ${target.ownerElements}-element owner. Define the wrapper as a child component outside this owner and keep other input expressions evaluated in the parent.`,
    practice: "reactivity",
  };
}

function multipleLeavesFinding(
  use: UseValueDeclaration,
  targets: readonly MoveDownTarget[],
  scan: ObservableReadScan,
): LegendPracticeFinding {
  const first = moveDownFinding(use, targets[0]!, scan);
  const locations = targets.map((target) => {
    const line = scan.sourceFile.getLineAndCharacterOfPosition(target.node.getStart()).line + 1;
    return `${target.leaf ? jsxLeafLabel(target.leaf, scan.sourceFile) : "complete conditional JSX slot"} at line ${line}`;
  });
  const elements = targets.reduce((total, target) => total + target.leafElements, 0);
  const observable = use.observable.getText(scan.sourceFile);
  return {
    ...first,
    evidence: [
      `all render reads of ${use.localName} are covered by ${targets.length} disjoint stable boundaries: ${locations.join(", ")}`,
      `together the boundaries contain ${elements} of the owner's ${targets[0]!.ownerElements} JSX elements`,
      "no reference remains in the owner, a callback, or an effect; every conditional slot keeps an always-mounted subscription boundary",
    ],
    message: `Extract ${locations.join("; ")} into ${targets.length} separate child components defined outside this owner. Move all reads of \`${use.localName}\` together: remove the owner's \`useValue(${observable})\` and subscribe inside each child to the same observable. Keep observable ownership here, pass the observable handle and each child's other inputs as ordinary props, and keep their evaluation in the parent. Keep each child always-mounted in its original slot, with conditional rendering inside it. Updates then rerender ${elements} JSX elements instead of the ${targets[0]!.ownerElements}-element owner.`,
  };
}

export function hasAncestorUseValueSubscription(
  currentCall: ts.CallExpression,
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): boolean {
  const currentObservable = provenObservablePath(
    currentCall.arguments[0]!,
    scan.observableBindings,
  );
  const currentPath = currentObservable && staticPropertyPath(currentObservable);
  if (!owner.body || !currentPath) {
    return true;
  }

  let overlap = false;
  visit(owner.body, (node) => {
    if (
      overlap ||
      !ts.isCallExpression(node) ||
      node === currentCall ||
      findAncestor(node, isRuntimeFunctionLike) !== owner ||
      !isUseValueCall(node, scan.imports)
    ) {
      return;
    }
    overlap = trackedUseValuePaths(node, scan.imports, scan.observableBindings).some(
      (otherObservable) => {
        const otherPath = staticPropertyPath(otherObservable);
        return (
          otherPath !== null &&
          otherPath.length <= currentPath.length &&
          otherPath.every((part, index) => part === currentPath[index])
        );
      },
    );
  });
  return overlap;
}

function trackedUseValuePaths(
  call: ts.CallExpression,
  imports: HookImports,
  observableBindings: ReadonlySet<string>,
): readonly ts.Expression[] {
  const direct = call.arguments[0] && provenObservablePath(call.arguments[0], observableBindings);
  const simpleInput = directUseValueInput(call, imports, observableBindings)?.observable;
  if (direct || simpleInput) {
    return [direct ?? simpleInput!];
  }

  const [selector] = call.arguments;
  if (!selector || (!ts.isArrowFunction(selector) && !ts.isFunctionExpression(selector))) {
    return [];
  }
  const paths: ts.Expression[] = [];
  visit(selector.body, (node) => {
    if (!ts.isCallExpression(node)) {
      return;
    }
    const receiver = directGetReceiver(node);
    const observable = receiver && provenObservablePath(receiver, observableBindings);
    if (observable) {
      paths.push(observable);
    }
  });
  return paths;
}

function isWholeValueProjection(reference: ts.Identifier): boolean {
  const current = outermostTransparentParent(reference);
  return !(
    (ts.isPropertyAccessExpression(current.parent) ||
      ts.isElementAccessExpression(current.parent)) &&
    current.parent.expression === current
  );
}
