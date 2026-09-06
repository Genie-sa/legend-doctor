import type { CommittedRefContext, EffectClassificationContext } from "./model.js";
import {
  callRootIdentifier,
  isNonValueIdentifier,
  localBindingNames,
} from "../../core/analysis-ast.js";
import { callbackCallsKnownSetter, calleeName } from "./callback-shape.js";
import { KNOWN_GLOBAL_OBJECTS } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { localCommittedRefBindings } from "./committed-ref-integration.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

const NO_EXEMPT_BINDINGS: ReadonlySet<string> = new Set<string>();

const LIFETIME_API_PATTERN =
  /^(?:setTimeout|setInterval|requestAnimationFrame|requestIdleCallback|addEventListener|subscribe)$/u;

function capturesOwnerBinding(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
  exempt: ReadonlySet<string>,
): boolean {
  const ownerLocals = localBindingNames(owner, callback);
  const callbackLocals = localBindingNames(callback, null);
  let captures = false;
  visit(callback.body, (node) => {
    if (
      !captures &&
      ts.isIdentifier(node) &&
      ownerLocals.has(node.text) &&
      !exempt.has(node.text) &&
      !callbackLocals.has(node.text) &&
      !isNonValueIdentifier(node)
    ) {
      captures = true;
    }
  });
  return captures;
}

export function capturesOwnerSnapshot(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
  context: CommittedRefContext,
): boolean {
  return capturesOwnerBinding(
    callback,
    owner,
    localCommittedRefBindings(owner, context.useRefBindings, context.reactNamespaces),
  );
}

export function isSetupOnlyMountCandidate(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
  context: EffectClassificationContext,
): boolean {
  if (
    !ts.isBlock(callback.body) ||
    callback.body.statements.length === 0 ||
    callbackCallsKnownSetter(callback, context.stateBySetter) ||
    !callback.body.statements.every(
      (statement) =>
        ts.isExpressionStatement(statement) && expressionContainsCall(statement.expression),
    ) ||
    hasLifetimeOrUnresolvedSetupCall(callback.body, context.moduleScopeBindings)
  ) {
    return false;
  }
  return !capturesOwnerBinding(callback, owner, NO_EXEMPT_BINDINGS);
}

function hasLifetimeOrUnresolvedSetupCall(
  body: ts.Block,
  moduleScopeBindings: ReadonlySet<string>,
): boolean {
  let unresolved = false;
  visit(body, (node) => {
    if (!ts.isCallExpression(node)) {
      return;
    }
    const callee = node.expression;
    if (LIFETIME_API_PATTERN.test(calleeName(callee))) {
      unresolved = true;
      return;
    }
    const root = callRootIdentifier(callee);
    if (root && !moduleScopeBindings.has(root) && !KNOWN_GLOBAL_OBJECTS.has(root)) {
      unresolved = true;
    }
  });
  return unresolved;
}

function expressionContainsCall(expression: ts.Expression): boolean {
  let contains = false;
  visit(expression, (node) => {
    if (ts.isCallExpression(node)) {
      contains = true;
    }
  });
  return contains;
}
