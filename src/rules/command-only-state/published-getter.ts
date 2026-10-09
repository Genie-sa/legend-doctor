import { findAncestorUntil, visit, visitSkippingNestedFunctions } from "../../core/ast.js";
import { isDeclarationName, isNonValueIdentifier } from "../../core/analysis-ast.js";
import {
  localCallableByName,
  localCallableCallback,
  localStateReadCallableNames,
} from "./local-callable-reads.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateCandidate } from "../../analysis/model.js";
import { isJsxNode } from "../state-proofs/callback-sites.js";
import { jsxTargetName } from "../../analysis/ast-helpers.js";
import ts from "typescript";

/**
 * Whether a local query that reads the state is published. A query returns a value without awaiting,
 * so a consumer may call it during render; it is published when it reaches the owner's returned value
 * or a context value directly, through an alias, or through another published query that calls it.
 */
export function statePublishesReadOnlyGetter(state: StateCandidate): boolean {
  const visited = new Set<string>();
  return [...localStateReadCallableNames(state)].some((name) =>
    queryIsPublished(state.owner, name, visited),
  );
}

function queryIsPublished(owner: RuntimeFunctionLike, name: string, visited: Set<string>): boolean {
  const callback = localCallableByName(owner, name);
  if (visited.has(name) || !callback || !returnsValueSynchronously(callback)) {
    return false;
  }
  visited.add(name);
  return (
    localBindingReachesReturnedJsxValue(owner, name) ||
    callingCallableNames(owner, name).some((caller) => queryIsPublished(owner, caller, visited))
  );
}

function returnsValueSynchronously(callback: RuntimeFunctionLike): boolean {
  if (!callback.body || ts.getCombinedModifierFlags(callback) & ts.ModifierFlags.Async) {
    return false;
  }
  let returnsValue = !ts.isBlock(callback.body);
  visitSkippingNestedFunctions(callback.body, callback, (node) => {
    returnsValue ||= ts.isReturnStatement(node) && node.expression !== undefined;
  });
  return returnsValue;
}

/** The local callables whose declarations reference `name`, in their body or dependency list. */
function callingCallableNames(owner: RuntimeFunctionLike, name: string): string[] {
  const callers = new Set<string>();
  visit(owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === name &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      const caller = findAncestorUntil(node, isCallableDeclaration, owner);
      if (caller?.name && ts.isIdentifier(caller.name)) {
        callers.add(caller.name.text);
      }
    }
  });
  return [...callers];
}

function isCallableDeclaration(
  node: ts.Node,
): node is ts.FunctionDeclaration | ts.VariableDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    (ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      localCallableCallback(node.initializer) !== null)
  );
}

function localBindingReachesReturnedJsxValue(owner: RuntimeFunctionLike, name: string): boolean {
  let published = false;
  visit(owner.body, (node) => {
    if (
      published ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (
      findAncestorUntil(node, ts.isReturnStatement, owner) &&
      !findAncestorUntil(node, isJsxNode, owner)
    ) {
      published = true;
      return;
    }
    if (isContextValueAttribute(findAncestorUntil(node, ts.isJsxAttribute, owner))) {
      published = true;
      return;
    }
    if (aliasReachesContextValue(node, owner)) {
      published = true;
    }
  });
  return published;
}

function aliasReachesContextValue(node: ts.Identifier, owner: RuntimeFunctionLike): boolean {
  const declaration = findAncestorUntil(node, ts.isVariableDeclaration, owner);
  if (!declaration || !ts.isIdentifier(declaration.name)) {
    return false;
  }
  const valueName = declaration.name.text;
  let published = false;
  visit(owner.body, (reference) => {
    if (
      published ||
      !ts.isIdentifier(reference) ||
      reference.text !== valueName ||
      reference === declaration.name ||
      isDeclarationName(reference) ||
      isNonValueIdentifier(reference)
    ) {
      return;
    }
    if (isContextValueAttribute(findAncestorUntil(reference, ts.isJsxAttribute, owner))) {
      published = true;
    }
  });
  return published;
}

function isContextValueAttribute(attribute: ts.JsxAttribute | null): boolean {
  return (
    attribute?.name.getText() === "value" &&
    jsxTargetName(attribute)?.endsWith(".Provider") === true
  );
}
