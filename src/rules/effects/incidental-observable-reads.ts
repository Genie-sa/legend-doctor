import type {
  ImportedCallee,
  ReachResolver,
} from "../../project/source-components/synchronous-reach.js";
import {
  bindingDeclarationCount,
  hookCallName,
  isAssignmentOperator,
  outermostTransparentParent,
  rootIdentifier,
  staticPropertyPath,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { findAncestor, isRuntimeFunctionLike, visit } from "../../core/ast.js";
import {
  hasSynchronousArrayReceiver,
  isSynchronousEffectCallback,
} from "./synchronous-dependency-reads.js";
import type { HookImports } from "../../core/imports.js";
import type { InlineEffectContext } from "./model.js";
import type { PeekedRead } from "./effect-verdicts.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { SYNCHRONOUS_CALLBACK_METHODS } from "../../core/execution-units.js";
import { lexicalBinding } from "../../core/lexical-bindings.js";
import { localReachResolver } from "../../project/source-components/reach-resolvers.js";
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
  readonly resolver: ReachResolver;
  readonly triggers: readonly (readonly string[])[];
}

/** How a call check resolves code, and the functions it has already followed. */
interface CallFollow {
  readonly isObservableRoot: (root: ts.Identifier) => boolean;
  readonly resolver: ReachResolver;
  readonly seen: Set<ts.Node>;
}

/** When a read runs relative to the observer's synchronous tracking pass. */
type ReadTiming = "deferred" | "tracked" | "unknown";

/**
 * The reads a `useObserveEffect` rewrite must peek, or why it cannot state them: a read whose
 * tracking is unknown, or a call into code that may track a read the rewrite cannot peek.
 */
export type IncidentalReads =
  | { readonly kind: "peek"; readonly reads: readonly PeekedRead[] }
  | { readonly kind: "unresolved" }
  | { readonly kind: "untrackable-call"; readonly callee: string };

type ReadVerdict =
  | { readonly kind: "ignore" }
  | { readonly kind: "peek"; readonly read: PeekedRead }
  | { readonly kind: "unresolved" }
  | { readonly kind: "untrackable-call"; readonly callee: string };

const IGNORE: ReadVerdict = { kind: "ignore" };

const UNRESOLVED = { kind: "unresolved" } as const;

/** Hooks whose returned handles run no application code when called or read. */
const HOOK_HANDLES: ReadonlySet<string> = new Set(["useReducer", "useRef", "useState"]);

const HOOK_NAME = /^use[A-Z$]/u;

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
 * become triggers, or why they cannot be stated. A read is tracked when it runs during the
 * observer's synchronous pass: in the callback itself, a synchronous collection callback, an
 * immediately invoked function before its first unconditional `await`, or a function they call.
 */
export function incidentalObservableReads(scope: ObservableReactionScope): IncidentalReads {
  const triggers = scope.sources.map((source) => staticPropertyPath(source));
  const staticTriggers = triggers.filter((trigger) => trigger !== null);
  if (staticTriggers.length !== triggers.length) {
    return UNRESOLVED;
  }
  return trackedNonTriggerReads({
    callback: scope.callback,
    imports: scope.inline.imports,
    isObservableRoot: observableRootPredicate(scope, staticTriggers),
    resolver: scope.inline.childContracts?.reachResolver?.() ?? localReachResolver,
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

function trackedNonTriggerReads(scan: ReadScan): IncidentalReads {
  const peeks = new Map<string, PeekedRead>();
  let blocked: Exclude<ReadVerdict, { kind: "ignore" | "peek" }> | null = null;
  visit(scan.callback.body, (node) => {
    if (blocked || !ts.isCallExpression(node)) {
      return;
    }
    const verdict = readVerdict(node, scan);
    if (verdict.kind === "peek") {
      peeks.set(verdict.read.read, verdict.read);
    } else if (verdict.kind !== "ignore") {
      blocked = verdict;
    }
  });
  return blocked ?? { kind: "peek", reads: [...peeks.values()] };
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
    : callVerdict(call, scan);
}

/** Only reads in the callback can be peeked, so a call that may track another read blocks it. */
function callVerdict(call: ts.CallExpression, scan: ReadScan): ReadVerdict {
  return readTiming(call, scan.callback) !== "deferred" &&
    callMayTrackReads(call, { ...scan, seen: new Set() })
    ? { callee: call.expression.getText(), kind: "untrackable-call" }
    : IGNORE;
}

/**
 * Whether a call may run an observable read, or code out of view, before it returns. A function
 * literal is scanned in place; a global, a package, or a React hook handle reads no application
 * observable, and an observable's methods read only when they iterate. A hook may subscribe. A
 * local function is followed to its first `await`.
 */
function callMayTrackReads(call: ts.CallExpression, follow: CallFollow): boolean {
  const callee = unwrapTransparentExpression(call.expression);
  if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) {
    return false;
  }
  const root = ts.isIdentifier(callee) ? callee : rootIdentifier(callee);
  if (root === null) {
    return !ts.isPropertyAccessExpression(callee);
  }
  return calleeMayTrackReads(callee, root, follow);
}

function calleeMayTrackReads(
  callee: ts.Expression,
  root: ts.Identifier,
  follow: CallFollow,
): boolean {
  if (HOOK_NAME.test(root.text)) {
    return true;
  }
  if (ts.isPropertyAccessExpression(callee) && isObservableReceiver(callee, root, follow)) {
    return isObservableIteration(callee);
  }
  if (ts.isPropertyAccessExpression(callee) && hasSynchronousArrayReceiver(callee.expression)) {
    return false;
  }
  const target = calledCode(root, callee, follow.resolver);
  if (target.kind === "function") {
    return root !== callee || functionMayTrackReads(target.declaration, follow);
  }
  return target.kind === "unknown";
}

function isObservableReceiver(
  callee: ts.PropertyAccessExpression,
  root: ts.Identifier,
  follow: CallFollow,
): boolean {
  const path = staticPropertyPath(callee.expression);
  return (
    follow.isObservableRoot(root) ||
    (path !== null && follow.resolver.isObservablePath(root.getSourceFile(), path))
  );
}

/** What calling a name runs; a React hook handle, like a global, runs no application code. */
export function calledCode(
  root: ts.Identifier,
  callee: ts.Expression,
  resolver: ReachResolver,
): ImportedCallee {
  const binding = lexicalBinding(root);
  if (binding?.kind === "import") {
    return resolver.importedCallee(root.getSourceFile(), binding);
  }
  if (binding?.kind === "function") {
    return binding;
  }
  if (binding?.kind !== "value" || isHookHandle(binding.declaration)) {
    return { kind: "external" };
  }
  return root === callee || mayHoldApplicationMethods(binding.declaration, resolver)
    ? { kind: "unknown" }
    : { kind: "external" };
}

/** Parameters, reassignable bindings and application-built objects may carry application methods. */
function mayHoldApplicationMethods(declaration: ts.Node, resolver: ReachResolver): boolean {
  if (!ts.isVariableDeclaration(declaration) || !(declaration.parent.flags & ts.NodeFlags.Const)) {
    return true;
  }
  const value = declaration.initializer && unwrapTransparentExpression(declaration.initializer);
  if (value && ts.isObjectLiteralExpression(value)) {
    return value.properties.some(
      (property) =>
        !ts.isPropertyAssignment(property) || isRuntimeFunctionLike(property.initializer),
    );
  }
  if (!value || !ts.isCallExpression(value)) {
    return value !== undefined && ts.isNewExpression(value);
  }
  const factory = unwrapTransparentExpression(value.expression);
  return ts.isIdentifier(factory) && calledCode(factory, factory, resolver).kind !== "external";
}

/** A Legend collection method reads every element it visits, as a `.get()` would. */
function isObservableIteration(callee: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text !== "set" &&
    SYNCHRONOUS_CALLBACK_METHODS.has(callee.name.text)
  );
}

function functionMayTrackReads(declaration: RuntimeFunctionLike, follow: CallFollow): boolean {
  if (follow.seen.has(declaration)) {
    return false;
  }
  follow.seen.add(declaration);
  let tracks = false;
  visit(declaration, (node) => {
    tracks ||=
      ts.isCallExpression(node) &&
      !followsUnconditionalAwait(declaration, node) &&
      (isGetCall(node) || callMayTrackReads(node, follow));
  });
  return tracks;
}

function isGetCall(call: ts.CallExpression): boolean {
  return (
    call.arguments.length === 0 &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === "get"
  );
}

function isHookHandle(declaration: ts.Node): boolean {
  const variable = ts.isVariableDeclaration(declaration)
    ? declaration
    : findAncestor(declaration, ts.isVariableDeclaration);
  const initializer = variable?.initializer && unwrapTransparentExpression(variable.initializer);
  return (
    initializer !== undefined &&
    ts.isCallExpression(initializer) &&
    HOOK_HANDLES.has(hookCallName(initializer) ?? "")
  );
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
