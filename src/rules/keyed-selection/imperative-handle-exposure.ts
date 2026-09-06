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

export function callbackIsExposedOnlyByImperativeHandle(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): boolean {
  const binding = imperativeCallbackBinding(callback, owner);
  if (!binding) {
    return false;
  }
  let exposed = false;
  let safe = true;
  visit(owner.body, (node) => {
    if (!safe || !isOtherBindingReference(node, binding)) {
      return;
    }
    const exposure = classifyImperativeHandleReference(node, owner, imports);
    if (exposure === "unsafe") {
      safe = false;
    } else if (exposure === "exposed") {
      exposed = true;
    }
  });
  return safe && exposed;
}

function imperativeCallbackBinding(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
): ts.Identifier | null {
  const hookCall = callback.parent;
  const declaration =
    ts.isCallExpression(hookCall) && ts.isVariableDeclaration(hookCall.parent)
      ? hookCall.parent
      : null;
  if (!declaration || !ts.isIdentifier(declaration.name)) {
    return null;
  }
  return bindingDeclarationCount(owner, declaration.name.text) === 1 ? declaration.name : null;
}

function isOtherBindingReference(node: ts.Node, binding: ts.Identifier): node is ts.Identifier {
  return (
    ts.isIdentifier(node) &&
    node.text === binding.text &&
    node !== binding &&
    !isDeclarationName(node) &&
    !isNonValueIdentifier(node)
  );
}

type ImperativeExposure = "exposed" | "ignored" | "unsafe";

function classifyImperativeHandleReference(
  node: ts.Identifier,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): ImperativeExposure {
  const imperativeCall = findAncestorUntil(node, ts.isCallExpression, owner);
  if (
    !imperativeCall ||
    !isUnshadowedReactHookCall({
      call: imperativeCall,
      hook: "useImperativeHandle",
      imports,
      owner,
    })
  ) {
    return "unsafe";
  }
  const [, factory, dependencies] = imperativeCall.arguments;
  if (factory && nodeWithin(node, factory)) {
    return imperativeFactoryReturnsBinding(factory, node) ? "exposed" : "unsafe";
  }
  return dependencies && nodeWithin(node, dependencies) ? "ignored" : "unsafe";
}

interface ReactHookCallCheck {
  call: ts.CallExpression;
  hook: "useCallback" | "useImperativeHandle";
  imports: HookImports;
  owner: RuntimeFunctionLike;
}

export function isUnshadowedReactHookCall(check: ReactHookCallCheck): boolean {
  const { call, hook, imports, owner } = check;
  const names = hook === "useCallback" ? imports.useCallback : imports.useImperativeHandle;
  if (
    !isImportedHookCall({
      call,
      localNames: names,
      namespaceNames: imports.reactNamespaces,
      canonicalName: hook,
    })
  ) {
    return false;
  }
  const root = hookCallRootIdentifier(call);
  return root !== null && bindingDeclarationCount(owner, root.text) === 0;
}

function imperativeFactoryReturnsBinding(
  factory: ts.Expression,
  reference: ts.Identifier,
): boolean {
  const value = unwrapTransparentExpression(factory);
  const object =
    (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) && !ts.isBlock(value.body)
      ? unwrapTransparentExpression(value.body)
      : null;
  return (
    object !== null &&
    ts.isObjectLiteralExpression(object) &&
    object.properties.some(
      (property) =>
        (ts.isShorthandPropertyAssignment(property) && property.name === reference) ||
        (ts.isPropertyAssignment(property) &&
          unwrapTransparentExpression(property.initializer) === reference),
    )
  );
}

function hookCallRootIdentifier(call: ts.CallExpression): ts.Identifier | null {
  if (ts.isIdentifier(call.expression)) {
    return call.expression;
  }
  return ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression)
    ? call.expression.expression
    : null;
}
