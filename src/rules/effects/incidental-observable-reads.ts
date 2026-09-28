import {
  bindingDeclarationCount,
  isAssignmentOperator,
  rootIdentifier,
  staticPropertyPath,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { findAncestor, isRuntimeFunctionLike, visit } from "../../core/ast.js";
import type { HookImports } from "../../core/imports.js";
import type { InlineEffectContext } from "./model.js";
import type { PeekedRead } from "./effect-verdicts.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isSynchronousEffectCallback } from "./synchronous-dependency-reads.js";
import { outermostTransparentParent } from "../observable-reads/observable-paths.js";
import ts from "typescript";

export interface ObservableReactionScope {
  readonly callback: ts.ArrowFunction | ts.FunctionExpression;
  readonly inline: InlineEffectContext;
  readonly owner: RuntimeFunctionLike;
  /** The observable argument of each `useValue` dependency: the reaction's intended triggers. */
  readonly sources: readonly ts.Expression[];
}

interface ReadScan {
  readonly callback: ts.ArrowFunction | ts.FunctionExpression;
  readonly imports: HookImports;
  readonly isObservableRoot: (root: ts.Identifier) => boolean;
  readonly triggers: readonly (readonly string[])[];
}

/** When a read runs relative to the observer's synchronous tracking pass. */
type ReadTiming = "deferred" | "tracked" | "unknown";

type ReadVerdict =
  | { readonly kind: "ignore" }
  | { readonly kind: "peek"; readonly read: PeekedRead }
  | { readonly kind: "unresolved" };

const IGNORE: ReadVerdict = { kind: "ignore" };

const UNRESOLVED: ReadVerdict = { kind: "unresolved" };

const DEFERRING_GLOBALS = new Set([
  "queueMicrotask",
  "requestAnimationFrame",
  "requestIdleCallback",
  "setInterval",
  "setTimeout",
]);

const GLOBAL_OBJECTS = new Set(["globalThis", "window"]);

const DEFERRING_METHODS = new Set(["addEventListener", "catch", "finally", "then"]);

/**
 * The tracked observable reads a `useObserveEffect` rewrite must turn into `.peek()` so they do not
 * become triggers, or null when some read's tracking cannot be stated. A read is tracked when it runs
 * during the observer's synchronous pass: in the callback itself, a synchronous collection callback,
 * or an immediately invoked function before its first unconditional `await`.
 */
export function incidentalObservableReads(
  scope: ObservableReactionScope,
): readonly PeekedRead[] | null {
  const triggers = scope.sources.map((source) => staticPropertyPath(source));
  const staticTriggers = triggers.filter((trigger) => trigger !== null);
  if (staticTriggers.length !== triggers.length) {
    return null;
  }
  return trackedNonTriggerReads({
    callback: scope.callback,
    imports: scope.inline.imports,
    isObservableRoot: observableRootPredicate(scope, staticTriggers),
    triggers: staticTriggers,
  });
}

function observableRootPredicate(
  { callback, inline, owner }: ObservableReactionScope,
  triggers: readonly (readonly string[])[],
): (root: ts.Identifier) => boolean {
  const triggerRoots = new Set(triggers.map((trigger) => trigger[0]));
  return ({ text }) => {
    if (bindingDeclarationCount(callback, text) > 0) {
      return false;
    }
    if (inline.useObservableBindings.has(text) || triggerRoots.has(text)) {
      return true;
    }
    return (
      !isBoundInScopes(owner, text) &&
      (inline.childContracts?.isObservableBinding(text) ??
        declaresModuleObservable(owner.getSourceFile(), inline.imports, text))
    );
  };
}

function isBoundInScopes(owner: RuntimeFunctionLike, name: string): boolean {
  for (
    let scope: RuntimeFunctionLike | null = owner;
    scope;
    scope = findAncestor(scope, isRuntimeFunctionLike)
  ) {
    if (bindingDeclarationCount(scope, name) > 0) {
      return true;
    }
  }
  return false;
}

function declaresModuleObservable(
  sourceFile: ts.SourceFile,
  imports: HookImports,
  name: string,
): boolean {
  return sourceFile.statements.some(
    (statement) =>
      ts.isVariableStatement(statement) &&
      (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
      statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === name &&
          declaration.initializer !== undefined &&
          isObservableFactoryCall(declaration.initializer, imports),
      ),
  );
}

function isObservableFactoryCall(expression: ts.Expression, imports: HookImports): boolean {
  const call = unwrapTransparentExpression(expression);
  return (
    ts.isCallExpression(call) &&
    ts.isIdentifier(call.expression) &&
    imports.observable.has(call.expression.text)
  );
}

function trackedNonTriggerReads(scan: ReadScan): readonly PeekedRead[] | null {
  const peeks = new Map<string, PeekedRead>();
  let unresolved = false;
  visit(scan.callback.body, (node) => {
    if (unresolved || !ts.isCallExpression(node)) {
      return;
    }
    const verdict = readVerdict(node, scan);
    unresolved = verdict.kind === "unresolved";
    if (verdict.kind === "peek") {
      peeks.set(verdict.read.read, verdict.read);
    }
  });
  return unresolved ? null : [...peeks.values()];
}

function peekedRead(call: ts.CallExpression, callee: ts.PropertyAccessExpression): PeekedRead {
  const receiver = callee.expression.getText();
  const access = callee.questionDotToken ? "?." : ".";
  const argumentsText = call.arguments.map((argument) => argument.getText()).join(", ");
  return { peek: `${receiver}${access}peek(${argumentsText})`, read: call.getText() };
}

function readVerdict(call: ts.CallExpression, scan: ReadScan): ReadVerdict {
  if (isSubscriptionHookCall(call, scan.imports)) {
    return readTiming(call, scan.callback) === "deferred" ? IGNORE : UNRESOLVED;
  }
  const callee = call.expression;
  return ts.isPropertyAccessExpression(callee) && callee.name.text === "get"
    ? getVerdict(call, callee, scan)
    : IGNORE;
}

function getVerdict(
  call: ts.CallExpression,
  callee: ts.PropertyAccessExpression,
  scan: ReadScan,
): ReadVerdict {
  const timing = readTiming(call, scan.callback);
  if (timing === "deferred") {
    return IGNORE;
  }
  const root = rootIdentifier(callee.expression);
  if (!root || !scan.isObservableRoot(root)) {
    return call.arguments.length === 0 ? UNRESOLVED : IGNORE;
  }
  if (timing === "unknown") {
    return UNRESOLVED;
  }
  const path = staticPropertyPath(callee.expression);
  return path && scan.triggers.some((trigger) => isPathPrefix(trigger, path))
    ? IGNORE
    : { kind: "peek", read: peekedRead(call, callee) };
}

function isSubscriptionHookCall(call: ts.CallExpression, imports: HookImports): boolean {
  return (
    ts.isIdentifier(call.expression) &&
    (imports.useValue.has(call.expression.text) || imports.legacyUseValue.has(call.expression.text))
  );
}

function isPathPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => segment === path[index]);
}

function readTiming(read: ts.Node, callback: RuntimeFunctionLike): ReadTiming {
  for (
    let scope = findAncestor(read, isRuntimeFunctionLike);
    scope && scope !== callback;
    scope = findAncestor(scope, isRuntimeFunctionLike)
  ) {
    const timing = nestedFunctionTiming(scope, read);
    if (timing !== "tracked") {
      return timing;
    }
  }
  return "tracked";
}

function nestedFunctionTiming(scope: RuntimeFunctionLike, read: ts.Node): ReadTiming {
  if (isImmediatelyInvoked(scope)) {
    return scope.asteriskToken || followsUnconditionalAwait(scope, read) ? "deferred" : "tracked";
  }
  if (isSynchronousEffectCallback(scope)) {
    return "tracked";
  }
  return isKnownDeferredCallback(scope) ? "deferred" : "unknown";
}

function isImmediatelyInvoked(scope: RuntimeFunctionLike): boolean {
  if (!ts.isArrowFunction(scope) && !ts.isFunctionExpression(scope)) {
    return false;
  }
  const expression = outermostTransparentParent(scope);
  return ts.isCallExpression(expression.parent) && expression.parent.expression === expression;
}

/** An async body suspends at its first statement-level `await`; nothing after it runs synchronously. */
function followsUnconditionalAwait(scope: RuntimeFunctionLike, read: ts.Node): boolean {
  const isAsync = scope.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
  if (!isAsync || !scope.body || !ts.isBlock(scope.body)) {
    return false;
  }
  const suspension = scope.body.statements.find((statement) => awaitsUnconditionally(statement));
  return suspension !== undefined && read.getStart() >= suspension.end;
}

function awaitsUnconditionally(statement: ts.Statement): boolean {
  if (ts.isExpressionStatement(statement) || ts.isReturnStatement(statement)) {
    return statement.expression !== undefined && isAwaitedValue(statement.expression);
  }
  return (
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some(
      (declaration) =>
        declaration.initializer !== undefined && isAwaitedValue(declaration.initializer),
    )
  );
}

function isAwaitedValue(expression: ts.Expression): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isBinaryExpression(value) && isAssignmentOperator(value.operatorToken.kind)) {
    return isAwaitedValue(value.right);
  }
  return ts.isAwaitExpression(value);
}

function isKnownDeferredCallback(scope: RuntimeFunctionLike): boolean {
  if (!ts.isArrowFunction(scope) && !ts.isFunctionExpression(scope)) {
    return false;
  }
  const expression = outermostTransparentParent(scope);
  const call = expression.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(expression)) {
    return false;
  }
  const callee = unwrapTransparentExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    return DEFERRING_GLOBALS.has(callee.text);
  }
  return (
    ts.isPropertyAccessExpression(callee) &&
    (DEFERRING_METHODS.has(callee.name.text) ||
      (DEFERRING_GLOBALS.has(callee.name.text) &&
        ts.isIdentifier(callee.expression) &&
        GLOBAL_OBJECTS.has(callee.expression.text)))
  );
}
