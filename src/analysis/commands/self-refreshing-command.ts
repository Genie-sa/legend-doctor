import type { StateCandidate, StateUsage } from "../model.js";
import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
} from "../../core/analysis-ast.js";
import { findAncestorUntil, nodeWithin, visit } from "../../core/ast.js";
import type { EffectOwnedCommandScope } from "./effect-owned-presentation.js";
import type { HookImports } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isImportedHookCall } from "../../core/imports.js";
import { isUniqueConstBindingOf } from "./effect-owned-presentation.js";
import { localCallbackBindingName } from "../callbacks/local-callbacks.js";
import { nearestMutationFunction } from "../mutations.js";
import ts from "typescript";

function stateHasSoleCommandWrite(usage: StateUsage): boolean {
  return (
    usage.setterCallNodes.length === 1 &&
    usage.setterReferences === 1 &&
    usage.effectWrites === 0 &&
    !usage.setterUsesPreviousValue &&
    usage.localRenderReads === 0 &&
    usage.transportedOccurrences === 0
  );
}

interface MemoizedCommandScope {
  readonly factory: ts.ArrowFunction | ts.FunctionExpression;
  readonly owner: RuntimeFunctionLike;
}

interface MemoizedCommandFactory {
  readonly factory: ts.ArrowFunction | ts.FunctionExpression;
  readonly memoCall: ts.CallExpression;
}

interface MemoizedSnapshotReads {
  readonly reads: readonly ts.Identifier[];
}

function memoizedSnapshotReads(
  state: StateCandidate,
  { factory, memoCall }: MemoizedCommandFactory,
): MemoizedSnapshotReads | null {
  let bodyReads = 0;
  let dependencyReads = 0;
  let unsafe = false;
  const reads: ts.Identifier[] = [];
  visit(state.owner.body, (node) => {
    if (unsafe || ts.isAwaitExpression(node) || ts.isYieldExpression(node)) {
      unsafe ||= nodeWithin(node, factory);
      return;
    }
    const site = snapshotReadSite(node, state, { factory, memoCall });
    dependencyReads += site === "dependency" ? 1 : 0;
    bodyReads += site === "body" ? 1 : 0;
    unsafe ||= site === "outside";
    if (site === "body" && ts.isIdentifier(node)) {
      reads.push(node);
    }
  });
  return unsafe || bodyReads === 0 || dependencyReads === 0 ? null : { reads };
}

function snapshotReadSite(
  node: ts.Node,
  state: StateCandidate,
  command: MemoizedCommandFactory,
): MemoizedReadSite | "ignored" {
  if (
    !ts.isIdentifier(node) ||
    node.text !== state.valueName ||
    node.parent === state.call.parent ||
    isDeclarationName(node) ||
    isNonValueIdentifier(node)
  ) {
    return "ignored";
  }
  return memoizedReadSite(node, command);
}

type MemoizedReadSite = "body" | "dependency" | "outside";

function memoizedReadSite(
  node: ts.Identifier,
  { factory, memoCall }: MemoizedCommandFactory,
): MemoizedReadSite {
  const [, dependencies] = memoCall.arguments;
  if (dependencies && nodeWithin(node, dependencies)) {
    return "dependency";
  }
  return nodeWithin(node, factory.body) ? "body" : "outside";
}

function snapshotWritesPrecedeReads(
  setterCall: ts.CallExpression,
  reads: readonly ts.Identifier[],
  { factory, owner }: MemoizedCommandScope,
): boolean {
  const writeSites = memoizedCommandWriteSites(setterCall, factory, owner);
  return (
    writeSites !== null &&
    !writeSites.some((write) =>
      reads.some(
        (read) =>
          write.getStart() < read.getStart() &&
          !writeIsFollowedByReturnBeforeRead(write, read, factory),
      ),
    )
  );
}

function commandBindingIsInvokedByEffect(
  owner: RuntimeFunctionLike,
  declaration: ts.VariableDeclaration,
  directEffectCalls: ReadonlySet<ts.CallExpression>,
): boolean {
  const binding = declaration.name.getText();
  let invokedByEffect = false;
  let unsafe = false;
  visit(owner.body, (node) => {
    if (
      unsafe ||
      !ts.isIdentifier(node) ||
      node.text !== binding ||
      node === declaration.name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const use = classifyEffectBindingReference(node, directEffectCalls);
    unsafe = use === "unsafe";
    invokedByEffect ||= use === "invocation";
  });
  return !unsafe && invokedByEffect;
}

interface SyncCallbackCommand extends MemoizedCommandFactory {
  readonly declaration: ts.VariableDeclaration;
}

function syncUseCallbackCommand(
  setterCall: ts.CallExpression,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): SyncCallbackCommand | null {
  const memoCall = findAncestorUntil(
    setterCall,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      isImportedHookCall({
        call: node,
        localNames: imports.useCallback,
        namespaceNames: imports.reactNamespaces,
        canonicalName: "useCallback",
      }),
    owner,
  );
  const factory = memoCall?.arguments[0];
  const declaration = memoCall
    ? findAncestorUntil(memoCall, ts.isVariableDeclaration, owner)
    : null;
  if (
    !memoCall ||
    !factory ||
    (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) ||
    !declaration ||
    !isUniqueConstBindingOf(declaration, memoCall, owner) ||
    factory.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  ) {
    return null;
  }
  return { declaration, factory, memoCall };
}

export function isEffectOwnedSelfRefreshingCommandState(
  state: StateCandidate,
  usage: StateUsage,
  { directEffectCalls, imports }: EffectOwnedCommandScope,
): boolean {
  const [setterCall] = usage.setterCallNodes;
  if (!state.owner.body || !setterCall || !stateHasSoleCommandWrite(usage)) {
    return false;
  }
  const command = syncUseCallbackCommand(setterCall, state.owner, imports);
  if (!command) {
    return false;
  }
  const { declaration, factory, memoCall } = command;
  const snapshot = memoizedSnapshotReads(state, { factory, memoCall });
  return (
    snapshot !== null &&
    snapshotWritesPrecedeReads(setterCall, snapshot.reads, { factory, owner: state.owner }) &&
    commandBindingIsInvokedByEffect(state.owner, declaration, directEffectCalls)
  );
}

type EffectBindingReference = "dependency" | "invocation" | "unsafe";

function classifyEffectBindingReference(
  node: ts.Identifier,
  directEffectCalls: ReadonlySet<ts.CallExpression>,
): EffectBindingReference {
  const effectCall = [...directEffectCalls].find((effect) => nodeWithin(node, effect));
  if (!effectCall) {
    return "unsafe";
  }
  if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
    return "invocation";
  }
  const [, dependencies] = effectCall.arguments;
  return dependencies && nodeWithin(node, dependencies) ? "dependency" : "unsafe";
}

function memoizedCommandWriteSites(
  setterCall: ts.CallExpression,
  factory: ts.ArrowFunction | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
): readonly ts.CallExpression[] | null {
  const region = nearestMutationFunction(setterCall, owner);
  if (region === factory) {
    return [setterCall];
  }
  if (
    !ts.isArrowFunction(region) &&
    !ts.isFunctionDeclaration(region) &&
    !ts.isFunctionExpression(region)
  ) {
    return null;
  }
  const name = localCallbackBindingName(region);
  if (!name || bindingDeclarationCount(factory, name) !== 1) {
    return null;
  }

  return localBindingInvocationSites(factory, name);
}

function localBindingInvocationSites(
  factory: ts.ArrowFunction | ts.FunctionExpression,
  name: string,
): readonly ts.CallExpression[] | null {
  const calls: ts.CallExpression[] = [];
  let safe = true;
  visit(factory.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
      calls.push(node.parent);
    } else {
      safe = false;
    }
  });
  return safe && calls.length > 0 ? calls : null;
}

function writeIsFollowedByReturnBeforeRead(
  write: ts.CallExpression,
  read: ts.Identifier,
  boundary: ts.Node,
): boolean {
  for (
    let current: ts.Node | undefined = write.parent;
    current && current !== boundary;
    current = current.parent
  ) {
    if (!ts.isBlock(current) || nodeWithin(read, current)) {
      continue;
    }
    const writeIndex = current.statements.findIndex((statement) => nodeWithin(write, statement));
    if (
      writeIndex !== -1 &&
      current.statements.slice(writeIndex + 1).some((statement) => ts.isReturnStatement(statement))
    ) {
      return true;
    }
  }
  return false;
}
