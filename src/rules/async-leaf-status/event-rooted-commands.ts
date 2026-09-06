import type { AsyncLeafStatusInputs, CommandRegion, PendingCommand } from "./model.js";
import {
  bindingDeclarationCount,
  isDeclarationName,
  isDirectJsxAttributeExpression,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { findAncestorUntil, isRuntimeFunctionLike, visit } from "../../core/ast.js";
import type { ChildContractResolver } from "../child-contract/model.js";
import { EMPTY_SEEN } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isCommandRegion } from "./pending-command.js";
import { isHookDependencyReference } from "../state-proofs/callback-sites.js";
import ts from "typescript";

interface EventRootContext {
  childContracts: ChildContractResolver | null;
  eventCallbacks: ReadonlySet<RuntimeFunctionLike>;
  owner: RuntimeFunctionLike;
}

interface EventRootScan {
  context: EventRootContext;
  seen: ReadonlySet<string>;
}

const EMPTY_EVENT_CALLBACKS: ReadonlySet<RuntimeFunctionLike> = new Set();

const USE_CALLBACK_ONLY: ReadonlySet<string> = new Set(["useCallback"]);

export function isEventRootedCommand(
  command: PendingCommand,
  owner: RuntimeFunctionLike,
  inputs: AsyncLeafStatusInputs,
): boolean {
  const context: EventRootContext = {
    childContracts: inputs.childContracts,
    eventCallbacks: inputs.eventCallbacksByOwner.get(owner) ?? EMPTY_EVENT_CALLBACKS,
    owner,
  };
  return (
    asyncCallbackIsEventRooted(command.region, context) &&
    command.alternateResetRegions.every((candidate) =>
      asyncCallbackIsEventRooted(candidate, context),
    )
  );
}

function asyncCallbackIsEventRooted(
  callback: CommandRegion,
  context: EventRootContext,
  seen: ReadonlySet<string> = EMPTY_SEEN,
): boolean {
  if (context.eventCallbacks.has(callback) || isInlineDeferredEventHandler(callback, context)) {
    return true;
  }
  const name = commandRegionName(callback);
  if (!name || seen.has(name) || bindingDeclarationCount(context.owner, name) !== 1) {
    return false;
  }
  return referencesAreEventRooted(callback, name, {
    context,
    seen: new Set(seen).add(name),
  });
}

function isInlineDeferredEventHandler(callback: CommandRegion, context: EventRootContext): boolean {
  const attribute = findAncestorUntil(callback, ts.isJsxAttribute, context.owner);
  return (
    attribute?.initializer !== undefined &&
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression !== undefined &&
    unwrapTransparentExpression(attribute.initializer.expression) === callback &&
    jsxAttributeIsDeferredEvent(attribute, context.childContracts)
  );
}

function commandRegionName(callback: CommandRegion): string | undefined {
  if (ts.isFunctionDeclaration(callback)) {
    return callback.name?.text;
  }
  return ts.isVariableDeclaration(callback.parent) && ts.isIdentifier(callback.parent.name)
    ? callback.parent.name.text
    : undefined;
}

function referencesAreEventRooted(
  callback: CommandRegion,
  name: string,
  scan: EventRootScan,
): boolean {
  const { owner } = scan.context;
  let referenced = false;
  let safe = true;
  visit(owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node) ||
      isHookDependencyReference(node, USE_CALLBACK_ONLY)
    ) {
      return;
    }
    referenced = true;
    if (!referenceIsEventRooted(node, callback, scan)) {
      safe = false;
    }
  });
  return referenced && safe;
}

function referenceIsEventRooted(
  node: ts.Identifier,
  callback: CommandRegion,
  scan: EventRootScan,
): boolean {
  const { context, seen } = scan;
  const { owner } = context;
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
  if (
    attribute &&
    isDirectJsxAttributeExpression(attribute, node) &&
    jsxAttributeIsDeferredEvent(attribute, context.childContracts)
  ) {
    return true;
  }
  if (!ts.isCallExpression(node.parent) || node.parent.expression !== node) {
    return false;
  }
  const caller = findAncestorUntil(node, isRuntimeFunctionLike, owner);
  return (
    caller !== null &&
    caller !== callback &&
    isCommandRegion(caller) &&
    asyncCallbackIsEventRooted(caller, context, seen)
  );
}

function jsxAttributeIsDeferredEvent(
  attribute: ts.JsxAttribute,
  childContracts: ChildContractResolver | null,
): boolean {
  if (jsxAttributeIsIntrinsicEvent(attribute)) {
    return true;
  }
  if (!/^on[A-Z]/u.test(attribute.name.getText()) || !childContracts) {
    return false;
  }
  const opening = attribute.parent.parent;
  const tag =
    ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening) ? opening.tagName : null;
  const target =
    tag && (ts.isIdentifier(tag) || ts.isPropertyAccessExpression(tag)) ? tag.getText() : null;
  return (
    target !== null &&
    (childContracts.frameworkEventComponent(target) ||
      childContracts.componentCallbackPropIsDeferredAtInvocation(
        target,
        attribute.name.getText(),
        opening,
      ))
  );
}

export function jsxAttributeIsIntrinsicEvent(attribute: ts.JsxAttribute): boolean {
  if (!/^on[A-Z]/u.test(attribute.name.getText())) {
    return false;
  }
  const opening = attribute.parent.parent;
  const tag =
    ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening) ? opening.tagName : null;
  return tag !== null && ts.isIdentifier(tag) && /^[a-z]/u.test(tag.text);
}
