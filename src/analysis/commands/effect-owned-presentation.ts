import type { StateCandidate, StateUsage } from "../model.js";
import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { findAncestorUntil, nodeWithin, visit } from "../../core/ast.js";
import type { HookImports } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isImportedHookCall } from "../../core/imports.js";
import ts from "typescript";

export interface EffectOwnedCommandScope {
  readonly directEffectCalls: ReadonlySet<ts.CallExpression>;
  readonly imports: HookImports;
}

function sharedContainingMemoCall(
  setterCalls: readonly ts.CallExpression[],
  owner: RuntimeFunctionLike,
  imports: HookImports,
): ts.CallExpression | null {
  let memoCall: ts.CallExpression | null = null;
  for (const setterCall of setterCalls) {
    const containingMemo = findAncestorUntil(
      setterCall,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        isImportedHookCall({
          call: node,
          localNames: imports.useMemo,
          namespaceNames: imports.reactNamespaces,
          canonicalName: "useMemo",
        }),
      owner,
    );
    if (!containingMemo || (memoCall !== null && memoCall !== containingMemo)) {
      return null;
    }
    memoCall = containingMemo;
  }
  return memoCall;
}

export function isUniqueConstBindingOf(
  declaration: ts.VariableDeclaration | null,
  initializer: ts.Expression,
  owner: RuntimeFunctionLike,
): boolean {
  return (
    declaration?.initializer !== undefined &&
    unwrapTransparentExpression(declaration.initializer) === initializer &&
    ts.isIdentifier(declaration.name) &&
    bindingDeclarationCount(owner, declaration.name.text) === 1
  );
}

export function isEffectOwnedMemoizedPresentationState(
  state: StateCandidate,
  usage: StateUsage,
  { directEffectCalls, imports }: EffectOwnedCommandScope,
): boolean {
  if (
    !state.owner.body ||
    usage.setterCallNodes.length === 0 ||
    usage.setterReferences !== usage.setterCalls ||
    usage.effectWrites !== 0 ||
    usage.setterUsesPreviousValue
  ) {
    return false;
  }

  const memoCall = sharedContainingMemoCall(usage.setterCallNodes, state.owner, imports);
  const [factory] = memoCall?.arguments ?? [];
  const declaration = memoCall
    ? findAncestorUntil(memoCall, ts.isVariableDeclaration, state.owner)
    : null;
  if (
    !memoCall ||
    !factory ||
    (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) ||
    !isUniqueConstBindingOf(declaration, memoCall, state.owner) ||
    !declaration ||
    !usage.setterCallNodes.every((call) => nodeWithin(call, factory))
  ) {
    return false;
  }
  return memoBindingIsInvokedByEffect(state.owner, declaration, directEffectCalls);
}

function memoBindingIsInvokedByEffect(
  owner: RuntimeFunctionLike,
  declaration: ts.VariableDeclaration,
  directEffectCalls: ReadonlySet<ts.CallExpression>,
): boolean {
  const binding = declaration.name.getText();
  let invokedByEffect = false;
  let safe = true;
  visit(owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== binding ||
      node === declaration.name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const use = classifyMemoizedBindingReference(node, directEffectCalls);
    safe = use !== "unsafe";
    invokedByEffect ||= use === "invocation";
  });
  return safe && invokedByEffect;
}

type MemoizedBindingReference = "invocation" | "passive" | "unsafe";

function classifyMemoizedBindingReference(
  node: ts.Identifier,
  directEffectCalls: ReadonlySet<ts.CallExpression>,
): MemoizedBindingReference {
  const effectCall = [...directEffectCalls].find((effect) => nodeWithin(node, effect));
  if (!effectCall) {
    return "unsafe";
  }
  if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
    return "invocation";
  }
  const memberCall =
    ts.isPropertyAccessExpression(node.parent) &&
    node.parent.expression === node &&
    ts.isCallExpression(node.parent.parent) &&
    node.parent.parent.expression === node.parent;
  const [, dependencies] = effectCall.arguments;
  return memberCall || (dependencies !== undefined && nodeWithin(node, dependencies))
    ? "passive"
    : "unsafe";
}
