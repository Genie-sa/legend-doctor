import type { ObservableReadScan, UseValueDeclaration } from "./model.js";
import { bindingDeclarationCount, isDeclarationName } from "../../core/analysis-ast.js";
import { findAncestor, isRuntimeFunctionLike, nodeWithin, visit } from "../../core/ast.js";
import { lowestCommonJsxSubtree, nearestRepeatedRenderCall } from "../state-proofs/jsx-subtrees.js";
import { primitiveExpression, pureFlowExpression, pureMemoProjection } from "./flow-expressions.js";
import { isImportedHookCall } from "../../core/imports.js";
import { isInsideOwnerReturn } from "./conditional-jsx-slots.js";
import { isReactEffectCall } from "../react-commit-sensitivity/effect-lifecycle.js";
import { isValueReferenceTo } from "./observable-paths.js";
import ts from "typescript";

export type FlowReadKind = "render" | "derivation" | "event-or-callback" | "effect" | "unknown";
export interface FlowRead {
  readonly node: ts.Identifier;
  readonly kind: FlowReadKind;
}
export interface FlowDerivation {
  readonly declaration: ts.VariableDeclaration;
  readonly kind: "const" | "useMemo";
}
export interface SubscriptionFlow {
  readonly use: UseValueDeclaration;
  readonly reads: FlowRead[];
  readonly renderReads: ts.Identifier[];
  readonly derivations: FlowDerivation[];
  readonly names: Set<string>;
  readonly primitives: Set<string>;
  readonly blockers: Set<string>;
}

export function subscriptionFlow(
  use: UseValueDeclaration,
  scan: ObservableReadScan,
): SubscriptionFlow {
  const flow: SubscriptionFlow = {
    use,
    reads: [],
    renderReads: [],
    derivations: [],
    names: new Set([use.localName]),
    primitives: new Set(scan.primitivePaths?.has(use.observable.getText()) ? [use.localName] : []),
    blockers: new Set(),
  };
  collectFlowReads(flow, scan);
  if (flow.renderReads.length === 0) {
    flow.blockers.add("no-render-consumer");
  }
  return flow;
}

function collectFlowReads(flow: SubscriptionFlow, scan: ObservableReadScan): void {
  const { use } = flow;
  const pending = [use.declaration];
  for (const declaration of pending) {
    const name = declaration.name.getText();
    if (bindingDeclarationCount(use.owner, name) !== 1) {
      flow.blockers.add("shadowed-or-reassigned-binding");
      continue;
    }
    visit(use.owner.body, (node) => {
      if (isValueReferenceTo(node, name, declaration.name)) {
        collectRead(node, flow, { scan, pending });
      }
    });
  }
}

function collectRead(
  node: ts.Identifier,
  flow: SubscriptionFlow,
  { scan, pending }: { scan: ObservableReadScan; pending: ts.VariableDeclaration[] },
): void {
  const derived = findAncestor(node, ts.isVariableDeclaration);
  if (
    derived &&
    derived !== flow.use.declaration &&
    derived.initializer &&
    nodeWithin(node, derived.initializer) &&
    findAncestor(derived, isRuntimeFunctionLike) === flow.use.owner &&
    addDerivation(derived, flow, { scan, pending })
  ) {
    flow.reads.push({ node, kind: "derivation" });
    return;
  }
  const kind = classifyRead(node, flow, scan);
  flow.reads.push({ node, kind });
  if (kind === "render") {
    flow.renderReads.push(node);
  } else {
    flow.blockers.add(kind === "unknown" ? "unsupported-value-flow" : `${kind}-consumer`);
  }
}

function addDerivation(
  declaration: ts.VariableDeclaration,
  flow: SubscriptionFlow,
  { scan, pending }: { scan: ObservableReadScan; pending: ts.VariableDeclaration[] },
): boolean {
  if (flow.derivations.some((item) => item.declaration === declaration)) {
    return true;
  }
  if (
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    !(declaration.parent.flags & ts.NodeFlags.Const) ||
    !declaration.initializer
  ) {
    return false;
  }
  return addProjection(declaration, flow, { scan, pending });
}

function addProjection(
  declaration: ts.VariableDeclaration,
  flow: SubscriptionFlow,
  { scan, pending }: { scan: ObservableReadScan; pending: ts.VariableDeclaration[] },
): boolean {
  const expression = declaration.initializer!;
  const scope = { names: flow.names, primitives: flow.primitives, sourceFile: scan.sourceFile };
  const memo =
    ts.isCallExpression(expression) &&
    isImportedHookCall({
      call: expression,
      canonicalName: "useMemo",
      localNames: scan.imports.useMemo,
      namespaceNames: scan.imports.reactNamespaces,
    });
  if (memo ? !pureMemoProjection(expression, scope) : !pureFlowExpression(expression, scope)) {
    return false;
  }
  registerDerivation(declaration, flow, memo);
  pending.push(declaration);
  return true;
}

function registerDerivation(
  declaration: ts.VariableDeclaration,
  flow: SubscriptionFlow,
  memo: boolean,
): void {
  const expression = declaration.initializer!;
  const scope = {
    names: flow.names,
    primitives: flow.primitives,
    sourceFile: declaration.getSourceFile(),
  };
  flow.derivations.push({ declaration, kind: memo ? "useMemo" : "const" });
  flow.names.add(declaration.name.getText());
  if (!memo && primitiveExpression(expression, scope)) {
    flow.primitives.add(declaration.name.getText());
  }
}

function classifyRead(
  node: ts.Identifier,
  flow: SubscriptionFlow,
  scan: ObservableReadScan,
): FlowReadKind {
  if (isDeclarationName(node)) {
    return "unknown";
  }
  if (findAncestor(node, isRuntimeFunctionLike) !== flow.use.owner) {
    for (
      let current: ts.Node = node;
      current !== flow.use.owner && current.parent;
      current = current.parent
    ) {
      if (ts.isCallExpression(current) && isReactEffectCall(current, scan.imports)) {
        return "effect";
      }
    }
    return "event-or-callback";
  }
  if (
    !isInsideOwnerReturn(node, flow.use.owner) ||
    nearestRepeatedRenderCall(node, flow.use.owner)
  ) {
    return "unknown";
  }
  return classifyRenderRead(node, flow, scan);
}

function classifyRenderRead(
  node: ts.Identifier,
  flow: SubscriptionFlow,
  scan: ObservableReadScan,
): FlowReadKind {
  const boundary = lowestCommonJsxSubtree([node], flow.use.owner);
  const slot = findAncestor(node, ts.isJsxExpression);
  if (!boundary || !slot?.expression) {
    return "unknown";
  }
  if (ts.isJsxAttribute(slot.parent) && ["key", "ref"].includes(slot.parent.name.getText())) {
    return "unknown";
  }
  // JSX in conditional slots is structural; inspect the expression containing this particular read only.
  const { expression } = slot;
  if (ts.isConditionalExpression(expression) && nodeWithin(node, expression.condition)) {
    return pureFlowExpression(expression.condition, { ...flow, sourceFile: scan.sourceFile })
      ? "render"
      : "unknown";
  }
  return pureFlowExpression(expression, { ...flow, sourceFile: scan.sourceFile })
    ? "render"
    : "unknown";
}
