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
  const observable = subscribedObservablePath(call.arguments[0]!, scan.observableBindings);
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

/** A parameterless, synchronous selector whose body is the one expression it returns. */
export function isExpressionSelector(
  node: ts.Node,
): node is ts.ArrowFunction & { readonly body: ts.Expression } {
  return (
    ts.isArrowFunction(node) &&
    node.parameters.length === 0 &&
    !ts.isBlock(node.body) &&
    !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  );
}

/** The observable a `useValue` input subscribes to: `x$` itself, or a selector that only returns `x$.get()`. */
export function subscribedObservablePath(
  input: ts.Expression,
  observableBindings: ReadonlySet<string>,
): ts.Expression | null {
  return isExpressionSelector(input)
    ? directObservableReadPath(input.body, observableBindings)
    : provenObservablePath(input, observableBindings);
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

const LEGACY_TRACKING_HOOK_NAMES = ["use$", "useSelector"] as const;
const LEGACY_TRACKING_HOOKS = new Set<string>(LEGACY_TRACKING_HOOK_NAMES);

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

/**
 * `useValue` or a deprecated alias. `use$` and `useSelector` are the same export at runtime, so a
 * subscription proof holds for all three names.
 */
export function isUseValueCall(call: ts.CallExpression, imports: HookImports): boolean {
  return (
    (isCanonicalUseValueCall(call, imports) ||
      LEGACY_TRACKING_HOOK_NAMES.some((name) =>
        isImportedHookCall({
          call,
          localNames: imports.legacyUseValue,
          namespaceNames: imports.legendReactNamespaces,
          canonicalName: name,
        }),
      )) &&
    !isShadowedHookBinding(call)
  );
}

/** Whether any call in a file with these imports can satisfy `isUseValueCall`. */
export function mayCallUseValue(imports: HookImports): boolean {
  return (
    imports.useValue.size > 0 ||
    imports.legacyUseValue.size > 0 ||
    imports.legendReactNamespaces.size > 0
  );
}

/** Only the `useValue` name, for rewrites whose runtime contract was tested under that export. */
export function isCanonicalUseValueCall(call: ts.CallExpression, imports: HookImports): boolean {
  return (
    isImportedHookCall({
      call,
      localNames: imports.useValue,
      namespaceNames: imports.legendReactNamespaces,
      canonicalName: "useValue",
    }) && !isShadowedHookBinding(call)
  );
}

function isShadowedHookBinding(call: ts.CallExpression): boolean {
  const binding = rootIdentifier(call.expression);
  const owner = findAncestor(call, isRuntimeFunctionLike);
  return Boolean(binding && owner && bindingDeclarationCount(owner, binding.text) > 0);
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
