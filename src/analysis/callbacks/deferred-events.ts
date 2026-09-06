import type { StateCandidate, StateUsage } from "../model.js";
import {
  bindingDeclarationCount,
  isDeclarationName,
  isDirectJsxAttributeExpression,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { declaredBindingName, isCustomJsxTarget, jsxTargetName } from "../ast-helpers.js";
import {
  findAncestorUntil,
  identifiersNamed,
  nearestNestedFunction,
  visit,
} from "../../core/ast.js";
import {
  localCallbackBindingName,
  localCallbackByBinding,
  visitDirectOwnerNodes,
} from "./local-callbacks.js";
import type { ChildContractResolver } from "../../rules/child-contract/model.js";
import type { ComponentPublication } from "./memoized-options.js";
import type { HookImports } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { jsxComponentPublications } from "./memoized-options.js";
import ts from "typescript";

export function sourceProvenDirectEventCallbacks(
  owner: RuntimeFunctionLike,
  imports: HookImports,
  childContracts: ChildContractResolver | null,
): ReadonlySet<RuntimeFunctionLike> {
  const callbacks = new Set<RuntimeFunctionLike>();
  if (!owner.body) {
    return callbacks;
  }
  visitDirectOwnerNodes(owner.body, (node) => {
    if (isInlineDeferredEventCallback(node, owner, childContracts)) {
      callbacks.add(node);
    }
    const callback = deferredPublishedCallback(node, owner, { childContracts, imports });
    if (callback) {
      callbacks.add(callback);
    }
  });
  return callbacks;
}

function isInlineDeferredEventCallback(
  node: ts.Node,
  owner: RuntimeFunctionLike,
  childContracts: ChildContractResolver | null,
): node is ts.ArrowFunction | ts.FunctionExpression {
  if (node === owner || (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node))) {
    return false;
  }
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
  return (
    attribute?.initializer !== undefined &&
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression !== undefined &&
    unwrapTransparentExpression(attribute.initializer.expression) === node &&
    jsxEventAttributeIsDeferred(attribute, childContracts)
  );
}

interface DeferredPublicationScope {
  readonly childContracts: ChildContractResolver | null;
  readonly imports: HookImports;
}

function deferredPublishedCallback(
  node: ts.Node,
  owner: RuntimeFunctionLike,
  { childContracts, imports }: DeferredPublicationScope,
): RuntimeFunctionLike | null {
  const binding = declaredBindingName(node);
  const callback = binding ? localCallbackByBinding(owner, binding, imports) : null;
  if (!binding || !callback) {
    return null;
  }
  const publications = jsxComponentPublications(owner, binding);
  return publications.length > 0 &&
    publications.every((publication) => publicationIsDeferred(publication, childContracts))
    ? callback
    : null;
}

function publicationIsDeferred(
  publication: ComponentPublication,
  childContracts: ChildContractResolver | null,
): boolean {
  if (
    /^on[A-Z]/u.test(publication.prop) &&
    (publication.intrinsic ||
      childContracts?.frameworkEventComponent(publication.component) === true)
  ) {
    return true;
  }
  return (
    childContracts?.componentCallbackPropIsDeferred(publication.component, publication.prop) ===
    true
  );
}

export interface DeferredEventScope {
  readonly childContracts: ChildContractResolver | null;
  readonly eventRoots: ReadonlySet<RuntimeFunctionLike>;
}

interface DeferredEventResolution extends DeferredEventScope {
  readonly seen: ReadonlySet<string>;
}

export function stateReadsOutsideRenderAreEventRooted(
  state: StateCandidate,
  usage: StateUsage,
  scope: DeferredEventScope,
): boolean {
  const renderReads = new Set(usage.directRenderNodes);
  let safe = true;
  visit(state.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== state.valueName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node) ||
      renderReads.has(node)
    ) {
      return;
    }
    safe = nodeIsDirectDeferredEvent(node, state, scope);
  });
  return safe;
}

export function nodeIsDirectDeferredEvent(
  node: ts.Node,
  state: StateCandidate,
  scope: DeferredEventScope,
): boolean {
  const callback = nearestNestedFunction(node, state.owner);
  return (
    callback !== null &&
    callbackResolvesToDeferredEvent(callback, state.owner, { ...scope, seen: new Set() })
  );
}

function callbackResolvesToDeferredEvent(
  callback: RuntimeFunctionLike,
  owner: RuntimeFunctionLike,
  resolution: DeferredEventResolution,
): boolean {
  const { childContracts, eventRoots, seen } = resolution;
  if (
    !ts.isArrowFunction(callback) &&
    !ts.isFunctionDeclaration(callback) &&
    !ts.isFunctionExpression(callback)
  ) {
    return false;
  }
  if (eventRoots.has(callback) || callbackHasDirectJsxEventRoot(callback, owner, childContracts)) {
    return true;
  }
  const name = localCallbackBindingName(callback);
  if (!name || seen.has(name) || bindingDeclarationCount(owner, name) !== 1) {
    return false;
  }

  const nextSeen = new Set(seen).add(name);
  return everyValueReferenceSatisfies(owner, name, (node) => {
    if (!ts.isCallExpression(node.parent) || node.parent.expression !== node) {
      return false;
    }
    const caller = nearestNestedFunction(node, owner);
    return (
      caller !== null &&
      caller !== callback &&
      callbackResolvesToDeferredEvent(caller, owner, { ...resolution, seen: nextSeen })
    );
  });
}

function everyValueReferenceSatisfies(
  owner: RuntimeFunctionLike,
  name: string,
  predicate: (node: ts.Identifier) => boolean,
): boolean {
  let referenced = false;
  for (const node of identifiersNamed(owner.body, name)) {
    if (isDeclarationName(node) || isNonValueIdentifier(node)) {
      continue;
    }
    referenced = true;
    if (!predicate(node)) {
      return false;
    }
  }
  return referenced;
}

function callbackHasDirectJsxEventRoot(
  callback: RuntimeFunctionLike,
  owner: RuntimeFunctionLike,
  childContracts: ChildContractResolver | null,
): boolean {
  if (
    !ts.isArrowFunction(callback) &&
    !ts.isFunctionDeclaration(callback) &&
    !ts.isFunctionExpression(callback)
  ) {
    return false;
  }
  if (isInlineDeferredEventCallback(callback, owner, childContracts)) {
    return true;
  }
  const name = localCallbackBindingName(callback);
  if (!name || bindingDeclarationCount(owner, name) !== 1) {
    return false;
  }
  return everyValueReferenceSatisfies(owner, name, (node) => {
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
    return (
      attribute !== null &&
      isDirectJsxAttributeExpression(attribute, node) &&
      jsxEventAttributeIsDeferred(attribute, childContracts)
    );
  });
}

function jsxEventAttributeIsDeferred(
  attribute: ts.JsxAttribute,
  childContracts: ChildContractResolver | null,
): boolean {
  const prop = attribute.name.getText();
  const target = jsxTargetName(attribute);
  if (!target || !/^on[A-Z]/u.test(prop)) {
    return false;
  }
  return (
    !isCustomJsxTarget(target) ||
    childContracts?.frameworkEventComponent(target) === true ||
    childContracts?.componentCallbackPropIsDeferred(target, prop) === true
  );
}
