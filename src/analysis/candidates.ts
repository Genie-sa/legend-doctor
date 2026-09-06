import type { EffectCandidate, StateCandidate } from "./model.js";
import { bindingDeclarationCount, unwrapTransparentExpression } from "../core/analysis-ast.js";
import { findAncestor, isRuntimeFunctionLike } from "../core/ast.js";
import { HOOK_CALL_ARITY } from "./constants.js";
import type { HookImports } from "../core/imports.js";
import type { RuntimeFunctionLike } from "../core/ast.js";
import { calleeRootIdentifier } from "./ast-helpers.js";
import { isImportedHookCall } from "../core/imports.js";
import ts from "typescript";
import { uniqueVariableDeclaration } from "../rules/state-proofs/binding-lookup.js";

export function stateCandidate(call: ts.CallExpression): StateCandidate | null {
  const declaration = call.parent;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== call) {
    return null;
  }
  if (!ts.isArrayBindingPattern(declaration.name)) {
    return null;
  }
  const [value, setter] = declaration.name.elements;
  const owner = findAncestor(call, isRuntimeFunctionLike);
  if (
    !owner ||
    !value ||
    ts.isOmittedExpression(value) ||
    !ts.isIdentifier(value.name) ||
    (setter && !ts.isOmittedExpression(setter) && !ts.isIdentifier(setter.name))
  ) {
    return null;
  }
  return {
    call,
    owner,
    setterName: bindingElementName(setter),
    valueName: value.name.text,
  };
}

function bindingElementName(element: ts.ArrayBindingElement | undefined): string | null {
  if (!element || ts.isOmittedExpression(element) || !ts.isIdentifier(element.name)) {
    return null;
  }
  return element.name.text;
}

export function effectCandidate(call: ts.CallExpression, imports: HookImports): EffectCandidate {
  const [callbackArg, dependenciesArg] = call.arguments;
  const owner = findAncestor(call, isRuntimeFunctionLike);
  return {
    call,
    callback: callbackArg ? resolveEffectCallback(callbackArg, owner, imports) : null,
    dependencies:
      dependenciesArg && ts.isArrayLiteralExpression(dependenciesArg) ? dependenciesArg : null,
    owner,
  };
}

function resolveEffectCallback(
  expression: ts.Expression,
  owner: RuntimeFunctionLike | null,
  imports: HookImports,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const callback = unwrapTransparentExpression(expression);
  if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) {
    return callback;
  }
  if (!owner?.body || !ts.isIdentifier(callback)) {
    return null;
  }

  const initializer = uniqueConstFunctionInitializer(owner, callback.text);
  if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
    return initializer;
  }
  return initializer ? unshadowedUseCallbackFactory(initializer, owner, imports) : null;
}

function uniqueConstFunctionInitializer(
  owner: RuntimeFunctionLike,
  binding: string,
): ts.Expression | null {
  const declaration = owner.body ? uniqueVariableDeclaration(owner.body, binding) : null;
  if (
    !declaration?.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(owner, binding) !== 1
  ) {
    return null;
  }
  return unwrapTransparentExpression(declaration.initializer);
}

function unshadowedUseCallbackFactory(
  initializer: ts.Expression,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): ts.ArrowFunction | ts.FunctionExpression | null {
  if (
    !ts.isCallExpression(initializer) ||
    !isImportedHookCall({
      call: initializer,
      localNames: imports.useCallback,
      namespaceNames: imports.reactNamespaces,
      canonicalName: "useCallback",
    }) ||
    initializer.arguments.length !== HOOK_CALL_ARITY
  ) {
    return null;
  }
  const hookRoot = calleeRootIdentifier(initializer.expression);
  if (!hookRoot || bindingDeclarationCount(owner, hookRoot.text) !== 0) {
    return null;
  }
  const [inner] = initializer.arguments;
  return inner && (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) ? inner : null;
}
