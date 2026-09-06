import {
  bindingDeclarationCount,
  isDeclarationName,
  isDirectJsxAttributeExpression,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { findAncestorUntil, isRuntimeFunctionLike, nodeWithin, visit } from "../../core/ast.js";
import type { HookImports } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isImportedHookCall } from "../../core/imports.js";
import { nearestMutationFunction } from "../mutations.js";
import ts from "typescript";
import { uniqueReturnedExpression } from "../return-call-sites.js";

const localCallbacksByOwner = new WeakMap<
  RuntimeFunctionLike,
  ReadonlyMap<string, RuntimeFunctionLike>
>();

function uniqueLocalCallbackBinding(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
): string | null {
  const callback = nearestMutationFunction(call, owner);
  if (
    callback === owner ||
    (!ts.isArrowFunction(callback) &&
      !ts.isFunctionDeclaration(callback) &&
      !ts.isFunctionExpression(callback))
  ) {
    return null;
  }
  const name = localCallbackBindingName(callback);
  return name && bindingDeclarationCount(owner, name) === 1 ? name : null;
}

export function jsxProducerForSetterCall(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const directAttribute = findAncestorUntil(call, ts.isJsxAttribute, owner);
  if (directAttribute && /^on[A-Z]/u.test(directAttribute.name.getText())) {
    return jsxOpeningForAttribute(directAttribute);
  }

  const name = uniqueLocalCallbackBinding(call, owner);
  if (!name) {
    return null;
  }
  const openings = eventHandlerOpeningsForBinding(owner, name);
  return openings?.length === 1 ? openings[0]! : null;
}

function eventHandlerOpeningsForBinding(
  owner: RuntimeFunctionLike,
  name: string,
): (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] | null {
  const openings: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
  let unsafeReference = false;
  visit(owner.body, (node) => {
    if (
      unsafeReference ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const opening = eventHandlerOpeningForReference(node, owner);
    if (opening) {
      openings.push(opening);
    } else {
      unsafeReference = true;
    }
  });
  return unsafeReference ? null : openings;
}

function eventHandlerOpeningForReference(
  node: ts.Identifier,
  owner: RuntimeFunctionLike,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
  if (
    !attribute ||
    !/^on[A-Z]/u.test(attribute.name.getText()) ||
    !isDirectJsxAttributeExpression(attribute, node)
  ) {
    return null;
  }
  return jsxOpeningForAttribute(attribute);
}

export function localCallbackBindingName(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
): string | null {
  if (ts.isFunctionDeclaration(callback)) {
    return callback.name?.text ?? null;
  }
  if (
    ts.isVariableDeclaration(callback.parent) &&
    callback.parent.initializer === callback &&
    ts.isIdentifier(callback.parent.name)
  ) {
    return callback.parent.name.text;
  }
  const call = callback.parent;
  return ts.isCallExpression(call) &&
    call.arguments[0] === callback &&
    ts.isVariableDeclaration(call.parent) &&
    call.parent.initializer === call &&
    ts.isIdentifier(call.parent.name)
    ? call.parent.name.text
    : null;
}

function collectLocalCallbackDeclaration(
  node: ts.Node,
  collected: Map<string, RuntimeFunctionLike>,
  imports: HookImports,
): void {
  if (ts.isFunctionDeclaration(node) && node.name) {
    collected.set(node.name.text, node);
    return;
  }
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) {
    return;
  }
  const callback = declaredCallbackInitializer(node.initializer, imports);
  if (callback) {
    collected.set(node.name.text, callback);
  }
}

function declaredCallbackInitializer(
  initializer: ts.Expression,
  imports: HookImports,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const expression = unwrapTransparentExpression(initializer);
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    return expression;
  }
  return useCallbackFactory(expression, imports);
}

function useCallbackFactory(
  initializer: ts.Expression,
  imports: HookImports,
): ts.ArrowFunction | ts.FunctionExpression | null {
  if (
    !ts.isCallExpression(initializer) ||
    !isImportedHookCall({
      call: initializer,
      localNames: imports.useCallback,
      namespaceNames: imports.reactNamespaces,
      canonicalName: "useCallback",
    })
  ) {
    return null;
  }
  const [callback] = initializer.arguments;
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return null;
  }
  return callback;
}

export function localCallbackByBinding(
  owner: RuntimeFunctionLike,
  binding: string,
  imports: HookImports,
): RuntimeFunctionLike | null {
  if (!owner.body || bindingDeclarationCount(owner, binding) !== 1) {
    return null;
  }
  let callbacks = localCallbacksByOwner.get(owner);
  if (!callbacks) {
    const collected = new Map<string, RuntimeFunctionLike>();
    visitDirectOwnerNodes(owner.body, (node) => {
      collectLocalCallbackDeclaration(node, collected, imports);
    });
    callbacks = collected;
    localCallbacksByOwner.set(owner, callbacks);
  }
  return callbacks.get(binding) ?? null;
}

export function addCallbackWithNestedFunctions(
  callback: RuntimeFunctionLike,
  callbacks: Set<RuntimeFunctionLike>,
): void {
  callbacks.add(callback);
  if (!callback.body) {
    return;
  }
  visit(callback.body, (node) => {
    if (isRuntimeFunctionLike(node)) {
      callbacks.add(node);
    }
  });
}

export function visitDirectOwnerNodes(node: ts.Node, onNode: (node: ts.Node) => void): void {
  node.forEachChild((child) => {
    onNode(child);
    if (!isRuntimeFunctionLike(child)) {
      visitDirectOwnerNodes(child, onNode);
    }
  });
}

export function jsxOpeningForAttribute(
  attribute: ts.JsxAttribute,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const opening = attribute.parent.parent;
  return ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening) ? opening : null;
}

export function shareUniqueOwnerReturn(
  left: ts.Node,
  right: ts.Node,
  owner: RuntimeFunctionLike,
): boolean {
  const returned = uniqueReturnedExpression(owner);
  return returned !== null && nodeWithin(left, returned) && nodeWithin(right, returned);
}
