import { bindingDeclarationCount, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import {
  findAncestor,
  isRuntimeFunctionLike,
  visitSkippingNestedRuntimeFunctions,
} from "../../core/ast.js";
import type { HookImports } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isImportedHookCall } from "../../core/imports.js";
import ts from "typescript";

/**
 * A dependency whose identity never changes between renders of the owner: module bindings,
 * refs, observables the owner creates, and state setters. Only such dependencies prove that a
 * render caused by an in-place write cannot also recompute the memo through another key.
 */
export function isStableDependency(
  dependency: ts.Expression,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): boolean {
  const value = unwrapTransparentExpression(dependency);
  if (!ts.isIdentifier(value)) {
    return false;
  }
  const declarations = bindingDeclarationCount(owner, value.text);
  if (declarations === 0) {
    return findAncestor(owner, isRuntimeFunctionLike) === null;
  }
  const declaration = declarations === 1 ? ownerDeclaration(owner, value.text) : null;
  return declaration !== null && declaresStableIdentity(declaration, value.text, imports);
}

function ownerDeclaration(owner: RuntimeFunctionLike, name: string): ts.VariableDeclaration | null {
  let found: ts.VariableDeclaration | null = null;
  if (!owner.body) {
    return null;
  }
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (ts.isVariableDeclaration(node) && bindsName(node.name, name)) {
      found = node;
    }
  });
  return found;
}

function bindsName(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) {
    return binding.text === name;
  }
  return binding.elements.some(
    (element) => !ts.isOmittedExpression(element) && bindsName(element.name, name),
  );
}

function declaresStableIdentity(
  declaration: ts.VariableDeclaration,
  name: string,
  imports: HookImports,
): boolean {
  const call = declaration.initializer
    ? unwrapTransparentExpression(declaration.initializer)
    : null;
  if (!call || !ts.isCallExpression(call)) {
    return false;
  }
  if (ts.isIdentifier(declaration.name)) {
    return isReactHook(call, "useRef", imports) || isUseObservableCall(call, imports);
  }
  const setter = ts.isArrayBindingPattern(declaration.name) ? declaration.name.elements[1] : null;
  return (
    setter !== null &&
    setter !== undefined &&
    ts.isBindingElement(setter) &&
    ts.isIdentifier(setter.name) &&
    setter.name.text === name &&
    isReactHook(call, "useState", imports)
  );
}

function isReactHook(
  call: ts.CallExpression,
  canonicalName: "useRef" | "useState",
  imports: HookImports,
): boolean {
  return isImportedHookCall({
    call,
    canonicalName,
    localNames: imports[canonicalName],
    namespaceNames: imports.reactNamespaces,
  });
}

export function isUseObservableCall(call: ts.CallExpression, imports: HookImports): boolean {
  const callee = unwrapTransparentExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    return imports.useObservable.has(callee.text);
  }
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    imports.legendReactNamespaces.has(callee.expression.text) &&
    callee.name.text === "useObservable"
  );
}
