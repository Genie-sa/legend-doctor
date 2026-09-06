import type { ObservableReadScan, UseValueDeclaration } from "./model.js";
import {
  bindingDeclarationCount,
  containsElementAccess,
  isNonValueIdentifier,
  rootIdentifier,
  staticPathHasBinding,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { findAncestor, isRuntimeFunctionLike } from "../../core/ast.js";
import type { HookImports } from "../../core/imports.js";
import { isImportedHookCall } from "../../core/imports.js";
import ts from "typescript";

export const RESERVED_OBSERVABLE_MEMBERS = new Set([
  "assign",
  "delete",
  "fire",
  "get",
  "getPrevious",
  "length",
  "onChange",
  "peek",
  "set",
  "size",
  "subscribe",
  "toggle",
]);

export function identifiedUseValueDeclaration(
  declaration: ts.VariableDeclaration,
  scan: ObservableReadScan,
): UseValueDeclaration | null {
  const call = declaration.initializer;
  if (
    !call ||
    !ts.isCallExpression(call) ||
    call.arguments.length !== 1 ||
    !isUseValueCall(call, scan.imports) ||
    !ts.isIdentifier(declaration.name)
  ) {
    return null;
  }
  const observable = provenObservablePath(call.arguments[0]!, scan.observableBindings);
  const owner = findAncestor(declaration, isRuntimeFunctionLike);
  if (!observable || !owner?.body) {
    return null;
  }
  return { call, declaration, localName: declaration.name.text, observable, owner };
}

export function isValueReferenceTo(
  node: ts.Node,
  localName: string,
  declarationName: ts.BindingName,
): node is ts.Identifier {
  return (
    ts.isIdentifier(node) &&
    node.text === localName &&
    node !== declarationName &&
    !isNonValueIdentifier(node)
  );
}

export function outermostTransparentParent(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent) ||
      ts.isNonNullExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    current = current.parent;
  }
  return current;
}

export function directObservableReadPath(
  expression: ts.Expression,
  observableBindings: ReadonlySet<string>,
): ts.Expression | null {
  const path = directGetReceiver(expression);
  return path ? provenObservablePath(path, observableBindings) : null;
}

export function directGetReceiver(expression: ts.Expression): ts.Expression | null {
  const read = unwrapTransparentExpression(expression);
  if (
    !ts.isCallExpression(read) ||
    read.arguments.length > 0 ||
    (read.typeArguments?.length ?? 0) > 0 ||
    read.questionDotToken ||
    !ts.isPropertyAccessExpression(read.expression) ||
    read.expression.questionDotToken ||
    read.expression.name.text !== "get"
  ) {
    return null;
  }
  return unwrapTransparentExpression(read.expression.expression);
}

const LEGACY_TRACKING_HOOKS = new Set(["use$", "useSelector"]);

/** `useValue` or one of its deprecated aliases, each of which tracks the observables its selector reads. */
export function isTrackingHookCall(call: ts.CallExpression, imports: HookImports): boolean {
  if (isUseValueCall(call, imports)) {
    return true;
  }
  const callee = unwrapTransparentExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    return imports.legacyUseValue.has(callee.text);
  }
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    imports.legendReactNamespaces.has(callee.expression.text) &&
    LEGACY_TRACKING_HOOKS.has(callee.name.text)
  );
}

export function isUseValueCall(call: ts.CallExpression, imports: HookImports): boolean {
  if (
    !isImportedHookCall({
      call,
      localNames: imports.useValue,
      namespaceNames: imports.legendReactNamespaces,
      canonicalName: "useValue",
    })
  ) {
    return false;
  }
  const binding = rootIdentifier(call.expression);
  const owner = findAncestor(call, isRuntimeFunctionLike);
  return !binding || !owner || bindingDeclarationCount(owner, binding.text) === 0;
}

export function provenObservablePath(
  expression: ts.Expression,
  observableBindings: ReadonlySet<string>,
): ts.Expression | null {
  const path = unwrapTransparentExpression(expression);
  if (
    (!ts.isIdentifier(path) && !ts.isPropertyAccessExpression(path)) ||
    containsElementAccess(path)
  ) {
    return null;
  }
  let current: ts.Expression = path;
  while (ts.isPropertyAccessExpression(current)) {
    if (current.questionDotToken || RESERVED_OBSERVABLE_MEMBERS.has(current.name.text)) {
      return null;
    }
    current = current.expression;
  }
  return staticPathHasBinding(path, observableBindings) ? path : null;
}
