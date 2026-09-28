import { callbackIsEventRooted, isPlainFunction } from "../state-proofs/event-roots.js";
import {
  directObservableReadPath,
  isUseValueCall,
  provenObservablePath,
} from "./observable-paths.js";
import {
  findAncestor,
  isRuntimeFunctionLike,
  nearestNestedFunction,
  visit,
} from "../../core/ast.js";
import {
  isInertFallback,
  isInvariantFallback,
  wrappedUseValueResult,
} from "./wrapped-use-value-results.js";
import { isInlineJsxEventHandler, runsOutsideRender } from "./render-exclusion.js";
import type { HookImports } from "../../core/imports.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import type { ObservableReadScan } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isImportedHookCall } from "../../core/imports.js";
import { ownerLevelReferences } from "../../core/scope-references.js";
import ts from "typescript";

type PlainFunction = ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;

type UnrenderedRead =
  | { readonly kind: "initializer"; readonly node: ts.Identifier }
  | { readonly kind: "command"; readonly node: ts.Identifier }
  | { readonly kind: "callback-dependency"; readonly node: ts.Identifier };

interface PlainSeedSubscription {
  /** The callee as the source spells it: `useValue`, `use$`, `useSelector`, or an alias. */
  readonly hook: string;
  readonly observable: string;
}

interface UnrenderedSubscription extends PlainSeedSubscription {
  readonly fallback: string | null;
  readonly localName: string;
  readonly owner: RuntimeFunctionLike;
  readonly reads: readonly UnrenderedRead[];
}

/**
 * A subscription binding that no render reads: every update rerenders the owner for nothing. The
 * subscription goes away, and each command or initializer read takes a `peek()` snapshot instead.
 */
export function unrenderedUseValueFinding(
  declaration: ts.VariableDeclaration,
  scan: ObservableReadScan,
): LegendPracticeFinding | null {
  const subscription = unrenderedSubscription(declaration, scan);
  return subscription ? unrenderedFinding(declaration, subscription, scan) : null;
}

function unrenderedSubscription(
  declaration: ts.VariableDeclaration,
  scan: ObservableReadScan,
): UnrenderedSubscription | null {
  const owner = topLevelOwner(declaration);
  const result = declaration.initializer && wrappedUseValueResult(declaration.initializer);
  const subscription = result && plainSeedSubscription(result.call, scan);
  if (!owner || !result || !subscription || !ts.isIdentifier(declaration.name)) {
    return null;
  }
  const reads = unrenderedReads(owner, declaration.name, scan.imports);
  if (
    !reads ||
    (result.fallback && !fallbackSurvivesRewrite(result.fallback, reads)) ||
    renderMayReadUntrackedState(owner, scan)
  ) {
    return null;
  }
  return {
    ...subscription,
    fallback: result.fallback?.getText(scan.sourceFile) ?? null,
    localName: declaration.name.text,
    owner,
    reads,
  };
}

/**
 * Deleting the binding drops only an inert fallback; replacing its reads repeats the fallback at each
 * read site, which is sound only when every evaluation yields the render-time value.
 */
function fallbackSurvivesRewrite(
  fallback: ts.Expression,
  reads: readonly UnrenderedRead[],
): boolean {
  return reads.length === 0 ? isInertFallback(fallback) : isInvariantFallback(fallback);
}

/** A plain-data seed proves the subscription activates no lazy source that `peek()` would defer. */
function plainSeedSubscription(
  call: ts.CallExpression,
  scan: ObservableReadScan,
): PlainSeedSubscription | null {
  if (call.arguments.length !== 1 || !isUseValueCall(call, scan.imports)) {
    return null;
  }
  const path = provenObservablePath(call.arguments[0]!, scan.observableBindings)?.getText(
    scan.sourceFile,
  );
  return path && scan.plainSeedPaths?.has(path)
    ? { hook: call.expression.getText(scan.sourceFile), observable: path }
    : null;
}

function unrenderedReads(
  owner: RuntimeFunctionLike,
  declarationName: ts.Identifier,
  imports: HookImports,
): UnrenderedRead[] | null {
  const reads: UnrenderedRead[] = [];
  for (const reference of ownerLevelReferences(owner, declarationName)) {
    const read = classifyUnrenderedRead(reference, owner, imports);
    if (!read) {
      return null;
    }
    reads.push(read);
  }
  return reads;
}

/** The owning component or hook, when the declaration is an unconditional top-level `const`. */
function topLevelOwner(declaration: ts.VariableDeclaration): RuntimeFunctionLike | null {
  const list = declaration.parent;
  const statement = list.parent;
  if (
    !ts.isVariableDeclarationList(list) ||
    !(list.flags & ts.NodeFlags.Const) ||
    !ts.isVariableStatement(statement) ||
    !ts.isBlock(statement.parent)
  ) {
    return null;
  }
  const owner = statement.parent.parent;
  return isRuntimeFunctionLike(owner) && owner.body === statement.parent ? owner : null;
}

function classifyUnrenderedRead(
  reference: ts.Identifier,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): UnrenderedRead | null {
  if (isInitialValueArgument(reference, imports)) {
    return { kind: "initializer", node: reference };
  }
  const dependencyOf = useCallbackDependencyCallback(reference, imports);
  if (dependencyOf) {
    return isEventRootedCommand({
      callback: dependencyOf,
      dependencyName: reference.text,
      imports,
      owner,
    })
      ? { kind: "callback-dependency", node: reference }
      : null;
  }
  const command = nearestNestedFunction(reference, owner);
  return command &&
    isPlainFunction(command) &&
    isEventRootedCommand({ callback: command, dependencyName: reference.text, imports, owner })
    ? { kind: "command", node: reference }
    : null;
}

/** `useRef(x)`, `useState(x)`, and `useObservable(x)` read their argument on the first render only. */
function isInitialValueArgument(reference: ts.Identifier, imports: HookImports): boolean {
  const call = reference.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== reference) {
    return false;
  }
  return (
    isImportedHookCall({
      call,
      canonicalName: "useRef",
      localNames: imports.useRef,
      namespaceNames: imports.reactNamespaces,
    }) ||
    isImportedHookCall({
      call,
      canonicalName: "useState",
      localNames: imports.useState,
      namespaceNames: imports.reactNamespaces,
    }) ||
    (ts.isIdentifier(call.expression) && imports.useObservable.has(call.expression.text))
  );
}

function useCallbackDependencyCallback(
  reference: ts.Identifier,
  imports: HookImports,
): PlainFunction | null {
  const dependencies = reference.parent;
  const call = dependencies.parent;
  if (
    !ts.isArrayLiteralExpression(dependencies) ||
    !call ||
    !ts.isCallExpression(call) ||
    call.arguments[1] !== dependencies ||
    !isImportedHookCall({
      call,
      canonicalName: "useCallback",
      localNames: imports.useCallback,
      namespaceNames: imports.reactNamespaces,
    })
  ) {
    return null;
  }
  const [callback] = call.arguments;
  return callback && isPlainFunction(callback) ? callback : null;
}

/**
 * The read runs synchronously in a callback that only events invoke, so `peek()` sees the value the
 * rendered closure would have held. Deferred or awaited reads would observe a later value instead.
 */
function isEventRootedCommand({
  callback,
  dependencyName,
  imports,
  owner,
}: {
  readonly callback: PlainFunction;
  readonly dependencyName: string;
  readonly imports: HookImports;
  readonly owner: RuntimeFunctionLike;
}): boolean {
  if (!isSynchronous(callback)) {
    return false;
  }
  if (isInlineJsxEventHandler(callback)) {
    return true;
  }
  return (
    isOwnerLevelCallback(callback, owner, imports) &&
    callbackIsEventRooted({ callback, owner, dependencyName, seen: new Set() })
  );
}

function isSynchronous(callback: PlainFunction): boolean {
  return (
    !callback.asteriskToken &&
    !callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  );
}

/** A named callback declared directly in the owner body, bare or wrapped in `useCallback`. */
function isOwnerLevelCallback(
  callback: PlainFunction,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): boolean {
  if (ts.isFunctionDeclaration(callback)) {
    return callback.parent === owner.body;
  }
  const wrapper =
    ts.isCallExpression(callback.parent) &&
    isImportedHookCall({
      call: callback.parent,
      canonicalName: "useCallback",
      localNames: imports.useCallback,
      namespaceNames: imports.reactNamespaces,
    })
      ? callback.parent
      : callback;
  const declaration = wrapper.parent;
  return (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer === wrapper &&
    ts.isVariableStatement(declaration.parent.parent) &&
    declaration.parent.parent.parent === owner.body
  );
}

/**
 * A render that reads a ref, `peek()`, or an untracked `get()` may depend on the rerender this
 * subscription forces, so removing it could leave that output stale.
 */
function renderMayReadUntrackedState(
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): boolean {
  let untracked = false;
  visit(owner.body, (node) => {
    if (!untracked && isUntrackedRead(node, owner, scan)) {
      untracked = !runsOutsideRender(node, owner, scan.imports);
    }
  });
  return untracked;
}

function isUntrackedRead(
  node: ts.Node,
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): boolean {
  if (ts.isPropertyAccessExpression(node) && node.name.text === "current") {
    return true;
  }
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
    return false;
  }
  const method = node.expression.name.text;
  return (
    method === "peek" ||
    (method === "get" && node.arguments.length === 0 && !isTrackedSelectorRead(node, owner, scan))
  );
}

/**
 * A proven observable's `get()` directly in the synchronous inline selector of a `useValue`, `use$`,
 * or `useSelector` call: that hook tracks the read and rerenders the owner itself when it changes.
 * Reads after an `await` or `yield` run outside the tracking context.
 */
function isTrackedSelectorRead(
  read: ts.CallExpression,
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): boolean {
  const selector = nearestNestedFunction(read, owner);
  const call = selector?.parent;
  return Boolean(
    selector &&
    call &&
    ts.isCallExpression(call) &&
    call.arguments[0] === selector &&
    isPlainFunction(selector) &&
    isSynchronous(selector) &&
    isUseValueCall(call, scan.imports) &&
    directObservableReadPath(read, scan.observableBindings),
  );
}

function unrenderedFinding(
  declaration: ts.VariableDeclaration,
  subscription: UnrenderedSubscription,
  scan: ObservableReadScan,
): LegendPracticeFinding {
  const { line, character } = scan.sourceFile.getLineAndCharacterOfPosition(
    declaration.getStart(scan.sourceFile),
  );
  const { localName, observable, reads } = subscription;
  const owner = ownerName(subscription.owner);
  return {
    action: "peek-unrendered-use-value",
    confidence: "probable",
    disposition: "change",
    evidence: [
      `\`${observable}\` is seeded with plain data, so dropping its subscription never delays a lazy source`,
      reads.length === 0
        ? `\`${localName}\` has no reads`
        : `every read of \`${localName}\` is a hook initial value or a synchronous event-rooted command`,
      `\`${owner}\` renders no ref, peek(), or untracked get() read that could depend on the forced rerender`,
    ],
    location: { column: character + 1, file: scan.fileName, line: line + 1 },
    message: `${rewriteInstruction(subscription, scan.sourceFile)}. No render reads the value, so \`${observable}\` updates stop rerendering \`${owner}\`.`,
    practice: "reactivity",
  };
}

function rewriteInstruction(
  { fallback, hook, localName, observable, reads }: UnrenderedSubscription,
  sourceFile: ts.SourceFile,
): string {
  const lines = (items: readonly UnrenderedRead[]): string =>
    items
      .map(
        (read) => sourceFile.getLineAndCharacterOfPosition(read.node.getStart(sourceFile)).line + 1,
      )
      .join(", ");
  const binding = `const ${localName} = ${hook}(${observable})${fallback ? ` ?? ${fallback}` : ""}`;
  const snapshot = fallback ? `(${observable}.peek() ?? ${fallback})` : `${observable}.peek()`;
  const snapshots = reads.filter((read) => read.kind !== "callback-dependency");
  const dependencies = reads.filter((read) => read.kind === "callback-dependency");
  const rewrite =
    snapshots.length === 0
      ? `Delete \`${binding}\`; nothing reads \`${localName}\``
      : `Remove \`${binding}\` and replace its ${snapshots.length} non-render read${snapshots.length === 1 ? "" : "s"} (line ${lines(snapshots)}) with \`${snapshot}\``;
  return dependencies.length === 0
    ? rewrite
    : `${rewrite}; drop \`${localName}\` from the useCallback dependencies at line ${lines(dependencies)}`;
}

function ownerName(owner: RuntimeFunctionLike): string {
  if ((ts.isFunctionDeclaration(owner) || ts.isFunctionExpression(owner)) && owner.name) {
    return owner.name.text;
  }
  const holder = findAncestor(owner, ts.isVariableDeclaration);
  return holder && ts.isIdentifier(holder.name) ? holder.name.text : "the owner";
}
