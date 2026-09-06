import type { StateCandidate, StateUsage } from "../model.js";
import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
} from "../../core/analysis-ast.js";
import {
  findAncestorUntil,
  identifiersNamed,
  nearestNestedFunction,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../../core/ast.js";
import { CALLBACK_HOOK_NAMES } from "../constants.js";
import type { ChildContractResolver } from "../../rules/child-contract/model.js";
import type { HostTagImports } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isHookDependencyReference } from "../../rules/state-proofs/callback-sites.js";
import { isHostTag } from "../../core/imports.js";
import ts from "typescript";

export interface WriteRootScope {
  readonly childContracts: ChildContractResolver | null;
  readonly eventTransitionCallbacks: ReadonlySet<RuntimeFunctionLike>;
  readonly hostTags: HostTagImports;
  readonly state: StateCandidate;
}

/**
 * Every write must run from a proven event root: a handler on a host element, a handler passed to a
 * component whose contract proves the callback runs only after render, or a callback the owner
 * analysis already proved deferred. Writes at render level or through callbacks of unknown timing
 * could fire while a wrapped site is evaluating.
 */
export function writesAreEventRooted(usage: StateUsage, scope: WriteRootScope): boolean {
  return usage.setterCallNodes.every((call) => {
    const callback = nearestNestedFunction(call, scope.state.owner);
    return callback !== null && callbackIsHostEventRooted(callback, scope, new Set());
  });
}

function callbackIsHostEventRooted(
  callback: RuntimeFunctionLike,
  scope: WriteRootScope,
  seen: ReadonlySet<string>,
): boolean {
  if (scope.eventTransitionCallbacks.has(callback)) {
    return true;
  }
  const attribute = findAncestorUntil(callback, ts.isJsxAttribute, scope.state.owner);
  if (attribute) {
    return isProvenEventAttribute(attribute, scope);
  }
  const name = callbackBindingName(callback);
  return name !== null && !seen.has(name) && namedCallbackIsEventRooted(name, scope, seen);
}

function namedCallbackIsEventRooted(
  name: string,
  scope: WriteRootScope,
  seen: ReadonlySet<string>,
): boolean {
  const { owner } = scope.state;
  if (bindingDeclarationCount(owner, name) !== 1) {
    return false;
  }
  const references = identifiersNamed(owner.body, name).filter(
    (reference) => !isDeclarationName(reference) && !isNonValueIdentifier(reference),
  );
  const nextSeen = new Set([...seen, name]);
  return (
    references.length > 0 &&
    references.every((reference) => referenceIsEventRooted(reference, scope, nextSeen))
  );
}

function referenceIsEventRooted(
  reference: ts.Identifier,
  scope: WriteRootScope,
  seen: ReadonlySet<string>,
): boolean {
  if (isHookDependencyReference(reference, CALLBACK_HOOK_NAMES)) {
    return true;
  }
  const attribute = findAncestorUntil(reference, ts.isJsxAttribute, scope.state.owner);
  if (attribute) {
    return isProvenEventAttribute(attribute, scope);
  }
  const enclosing = nearestNestedFunction(reference, scope.state.owner);
  return enclosing !== null && callbackIsHostEventRooted(enclosing, scope, seen);
}

/**
 * Host `on*` attributes are events. For a custom component the resolved contract decides; when the
 * component cannot be resolved, the `on*` naming convention applies, as in the other event proofs.
 */
function isProvenEventAttribute(attribute: ts.JsxAttribute, scope: WriteRootScope): boolean {
  const tag = attributeTagName(attribute);
  if (tag === null) {
    return false;
  }
  const propName = attribute.name.getText();
  const isEventName = /^on[A-Z]/u.test(propName);
  if (isHostTag(tag, scope.hostTags) || !scope.childContracts) {
    return isEventName;
  }
  return scope.childContracts.resolveComponent(tag)
    ? scope.childContracts.componentCallbackPropIsDeferred(tag, propName)
    : isEventName;
}

function callbackBindingName(callback: RuntimeFunctionLike): string | null {
  if (ts.isFunctionDeclaration(callback) && callback.name) {
    return callback.name.text;
  }
  let current: ts.Node = callback;
  while (ts.isCallExpression(current.parent) || ts.isParenthesizedExpression(current.parent)) {
    current = current.parent;
  }
  return ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)
    ? current.parent.name.text
    : null;
}

/**
 * A setter that runs beside another `useState` setter in the same command belongs to an atomic
 * transition, even when that companion drops its value binding and never becomes a state candidate.
 */
export function hasHiddenCompanionWrites(state: StateCandidate, usage: StateUsage): boolean {
  const otherSetters = ownerSetterNames(state);
  return usage.setterCallNodes.some((call) => {
    const region = nearestNestedFunction(call, state.owner) ?? state.owner;
    let companion = false;
    visitSkippingNestedRuntimeFunctions(region.body ?? region, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        otherSetters.has(node.expression.text)
      ) {
        companion = true;
      }
    });
    return companion;
  });
}

function ownerSetterNames(state: StateCandidate): ReadonlySet<string> {
  const names = new Set<string>();
  visit(state.owner.body, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isArrayBindingPattern(node.name) ||
      !node.initializer ||
      !ts.isCallExpression(node.initializer) ||
      !node.initializer.expression.getText().endsWith("useState")
    ) {
      return;
    }
    const [, setter] = node.name.elements;
    if (
      setter &&
      !ts.isOmittedExpression(setter) &&
      ts.isIdentifier(setter.name) &&
      setter.name.text !== state.setterName
    ) {
      names.add(setter.name.text);
    }
  });
  return names;
}

function attributeTagName(attribute: ts.JsxAttribute): string | null {
  const opening = attribute.parent.parent;
  return ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening)
    ? opening.tagName.getText()
    : null;
}
