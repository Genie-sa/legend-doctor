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
  hasUnstableSubtreeLifetime,
  isSafeJsxProjectionReference,
  jsxElementCount,
  jsxElementCountIn,
  lowestCommonJsxSubtree,
  nearestRepeatedRenderCall,
} from "../state-proofs/jsx-subtrees.js";
import type { HookImports } from "../../core/imports.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { directUseValueInput } from "./use-value-inputs.js";
import { stableConditionalJsxSlot } from "./conditional-jsx-slots.js";
import ts from "typescript";

const MAX_LEAF_OWNER_SHARE = 0.4;

const MIN_LEAF_OWNER_ELEMENTS = 12;

interface MoveDownTarget {
  readonly leaf: JsxSubtree | null;
  readonly node: ts.Node;
  readonly leafElements: number;
  readonly ownerElements: number;
  readonly references: readonly ts.Identifier[];
}

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
  const references = projectedValueReferences(use);
  if (references === null) {
    return null;
  }
  const target = moveDownTarget(references, use.owner, scan);
  return target ? moveDownFinding(use, target, scan) : null;
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
      !isSafeJsxProjectionReference(node, use.owner) ||
      nearestRepeatedRenderCall(node, use.owner)
    ) {
      unsafe = true;
      return;
    }
    references.push(node);
  });
  return unsafe || references.length === 0 ? null : references;
}

function stableJsxLeaf(
  references: readonly ts.Identifier[],
  owner: RuntimeFunctionLike,
): JsxSubtree | null {
  const leaf = lowestCommonJsxSubtree(references, owner);
  return leaf && !hasUnstableSubtreeLifetime(leaf, owner) ? leaf : null;
}

function moveDownTarget(
  references: readonly ts.Identifier[],
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): MoveDownTarget | null {
  const conditionalSlot = stableConditionalJsxSlot(references, owner, scan.imports);
  const leaf = conditionalSlot ? null : stableJsxLeaf(references, owner);
  const node = leaf ?? conditionalSlot;
  if (!node) {
    return null;
  }
  const ownerElements = jsxElementCount(owner);
  const leafElements = jsxElementCountIn(node);
  if (leafElements / ownerElements > MAX_LEAF_OWNER_SHARE) {
    return null;
  }
  return { leaf, leafElements, node, ownerElements, references };
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
    message: `Move \`useValue(${observable})\` for \`${use.localName}\` into ${target.leaf ? "a stable wrapper around" : "an always-mounted wrapper for"} the ${leafLabel} at line ${leafLine}; keep observable ownership where it is and pass ${target.leaf ? "the leaf's other inputs" : "non-observable gate values"} as ordinary props so updates rerender ${target.leafElements} JSX element${target.leafElements === 1 ? "" : "s"} instead of the ${target.ownerElements}-element owner.`,
    practice: "reactivity",
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
