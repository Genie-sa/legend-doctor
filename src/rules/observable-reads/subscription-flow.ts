import type { ObservableReadScan, UseValueDeclaration } from "./model.js";
import { bindingDeclarationCount, isDeclarationName } from "../../core/analysis-ast.js";
import { findAncestor, isRuntimeFunctionLike, nodeWithin, visit } from "../../core/ast.js";
import { lowestCommonJsxSubtree, nearestRepeatedRenderCall } from "../state-proofs/jsx-subtrees.js";
import { primitiveExpression, pureFlowExpression, pureMemoProjection } from "./flow-expressions.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { SubscriptionInventoryReason } from "../../core/subscriptions.js";
import { isImportedHookCall } from "../../core/imports.js";
import { isImportedReactCall } from "../react-commit-sensitivity/binding-resolution.js";
import { isInsideOwnerReturn } from "./conditional-jsx-slots.js";
import { isReactEffectCall } from "../react-commit-sensitivity/effect-lifecycle.js";
import { isRenderGateRead } from "./render-gates.js";
import { isSynchronousRenderCallback } from "../state-proofs/callback-sites.js";
import { isValueReferenceTo } from "./observable-paths.js";
import ts from "typescript";

/**
 * `memo` reads run in an owner-level `useMemo` callback or dependency list, so render evaluates them only
 * when the dependencies change. `render-callback` reads run on every render inside a synchronous callback,
 * such as an array `map` or `find`, within the owner's returned JSX.
 */
export type FlowReadKind =
  | "render"
  | "derivation"
  | "memo"
  | "render-callback"
  | "event-or-callback"
  | "effect"
  | "unknown";

/** A read that is not itself a followed derivation, as `classifyRead` settles it. */
type ClassifiedReadKind = Exclude<FlowReadKind, "derivation">;

const RENDERED_READ_KINDS: ReadonlySet<FlowReadKind> = new Set(["render", "render-callback"]);

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
  readonly blockers: Set<SubscriptionInventoryReason>;
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
  if (!flow.reads.some((read) => RENDERED_READ_KINDS.has(read.kind))) {
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
): ClassifiedReadKind {
  if (isDeclarationName(node)) {
    return "unknown";
  }
  const evaluated = renderEvaluatedRoot(node, flow.use.owner, scan);
  if (!evaluated) {
    return deferredReadKind(node, flow.use.owner, scan);
  }
  const hookInput = ownerHookInputKind(evaluated, flow.use.owner, scan);
  if (hookInput || evaluated === node) {
    return hookInput ?? classifyOwnerRead(node, flow, scan);
  }
  return isInsideOwnerReturn(evaluated, flow.use.owner) ? "render-callback" : "unknown";
}

function classifyOwnerRead(
  node: ts.Identifier,
  flow: SubscriptionFlow,
  scan: ObservableReadScan,
): ClassifiedReadKind {
  const { owner, localName } = flow.use;
  if (nearestRepeatedRenderCall(node, owner)) {
    return "unknown";
  }
  if (isRenderGateRead(node, { owner, imports: scan.imports, observableValue: localName })) {
    return "render";
  }
  return isInsideOwnerReturn(node, owner) ? classifyRenderRead(node, flow, scan) : "unknown";
}

/** The outermost node that the owner evaluates while rendering, seen through synchronous callbacks. */
function renderEvaluatedRoot(
  node: ts.Identifier,
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): ts.Node | null {
  let evaluated: ts.Node = node;
  for (
    let callback = findAncestor(node, isRuntimeFunctionLike);
    callback !== owner;
    callback = findAncestor(evaluated, isRuntimeFunctionLike)
  ) {
    if (!callback || !isRenderPhaseCallback(callback, scan)) {
      return null;
    }
    evaluated = callback;
  }
  return evaluated;
}

function isRenderPhaseCallback(callback: RuntimeFunctionLike, scan: ObservableReadScan): boolean {
  return (
    !(ts.getCombinedModifierFlags(callback) & ts.ModifierFlags.Async) &&
    !callback.asteriskToken &&
    (isSynchronousRenderCallback(callback) || isMemoCallback(callback, scan))
  );
}

function isMemoCallback(callback: RuntimeFunctionLike, scan: ObservableReadScan): boolean {
  const call = callback.parent;
  return ts.isCallExpression(call) && call.arguments[0] === callback && isMemoCall(call, scan);
}

/**
 * A `useMemo` callback or dependency list is a memo read. The dependency list of an effect or
 * `useCallback` only decides when that effect reruns or the callback changes identity, so it shares
 * the kind of the callback it guards.
 */
function ownerHookInputKind(
  evaluated: ts.Node,
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): ClassifiedReadKind | null {
  for (let current = evaluated.parent; current !== owner; current = current.parent) {
    const kind = ts.isCallExpression(current) ? hookInputKind(current, evaluated, scan) : null;
    if (kind) {
      return kind;
    }
  }
  return null;
}

function hookInputKind(
  call: ts.CallExpression,
  evaluated: ts.Node,
  scan: ObservableReadScan,
): ClassifiedReadKind | null {
  const [callback, dependencies] = call.arguments;
  const inDependencies = dependencies !== undefined && nodeWithin(evaluated, dependencies);
  if ((callback === evaluated || inDependencies) && isMemoCall(call, scan)) {
    return "memo";
  }
  if (inDependencies && isReactEffectCall(call, scan.imports)) {
    return "effect";
  }
  return inDependencies && isImportedReactCall(call, scan.imports, "useCallback")
    ? "event-or-callback"
    : null;
}

function isMemoCall(call: ts.CallExpression, scan: ObservableReadScan): boolean {
  return isImportedHookCall({
    call,
    canonicalName: "useMemo",
    localNames: scan.imports.useMemo,
    namespaceNames: scan.imports.reactNamespaces,
  });
}

function deferredReadKind(
  node: ts.Identifier,
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): ClassifiedReadKind {
  for (let current: ts.Node = node; current !== owner && current.parent; current = current.parent) {
    if (ts.isCallExpression(current) && isReactEffectCall(current, scan.imports)) {
      return "effect";
    }
  }
  return "event-or-callback";
}

function classifyRenderRead(
  node: ts.Identifier,
  flow: SubscriptionFlow,
  scan: ObservableReadScan,
): ClassifiedReadKind {
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
