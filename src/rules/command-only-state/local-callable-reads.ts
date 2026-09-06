import {
  bindingDeclarationCount,
  isDeclarationName,
  isDirectJsxAttributeExpression,
  isNonValueIdentifier,
} from "../../core/analysis-ast.js";
import {
  findAncestorUntil,
  nearestNestedFunction,
  visit,
  visitSkippingNestedFunctions,
} from "../../core/ast.js";
import { isJsxNode, isSynchronousRenderCallback } from "../state-proofs/callback-sites.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateCandidate } from "../../analysis/model.js";
import { isInsideJsxEventCallback } from "../state-proofs/event-roots.js";
import ts from "typescript";

export interface CommandOnlyCallableReads {
  effectSites: readonly ts.Identifier[];
  renderSites: readonly ts.Identifier[];
}

export function collectCommandOnlyCallableReads(
  state: StateCandidate,
  effectNodes: ReadonlySet<ts.Node>,
): CommandOnlyCallableReads {
  const names = localStateReadCallableNames(state);
  return {
    effectSites: localCallableEffectSites(state, names, effectNodes),
    renderSites: localCallableRenderSites(state, names),
  };
}

export function localStateReadCallableNames(state: StateCandidate): ReadonlySet<string> {
  const names = new Set<string>();
  visit(state.owner.body, (node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      node.body &&
      functionReadsState(node, state) &&
      bindingDeclarationCount(state.owner, node.name.text) === 1
    ) {
      names.add(node.name.text);
      return;
    }
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) {
      return;
    }
    const callback = localCallableCallback(node.initializer);
    if (
      callback &&
      functionReadsState(callback, state) &&
      bindingDeclarationCount(state.owner, node.name.text) === 1
    ) {
      names.add(node.name.text);
    }
  });
  return names;
}

function localCallableRenderSites(
  state: StateCandidate,
  names: ReadonlySet<string>,
): readonly ts.Identifier[] {
  if (names.size === 0) {
    return [];
  }
  const sites: ts.Identifier[] = [];
  visit(state.owner.body, (node) => {
    if (!ts.isIdentifier(node) || !names.has(node.text)) {
      return;
    }
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, state.owner);
    if (
      attribute &&
      isDirectJsxAttributeExpression(attribute, node) &&
      jsxPropMayRenderCallable(attribute.name.getText())
    ) {
      sites.push(node);
      return;
    }
    if (isCallableInvocationSite(node, state.owner)) {
      sites.push(node);
    }
  });
  return sites;
}

function isCallableInvocationSite(node: ts.Identifier, owner: RuntimeFunctionLike): boolean {
  if (
    !ts.isCallExpression(node.parent) ||
    node.parent.expression !== node ||
    isInsideJsxEventCallback(node, owner)
  ) {
    return false;
  }
  const callback = nearestNestedFunction(node, owner);
  return (
    findAncestorUntil(node.parent, isJsxNode, owner) !== null ||
    callback === null ||
    isSynchronousRenderCallback(callback)
  );
}

function localCallableEffectSites(
  state: StateCandidate,
  names: ReadonlySet<string>,
  effectNodes: ReadonlySet<ts.Node>,
): readonly ts.Identifier[] {
  if (names.size === 0 || effectNodes.size === 0) {
    return [];
  }
  const sites: ts.Identifier[] = [];
  visit(state.owner.body, (node) => {
    if (ts.isIdentifier(node) && names.has(node.text) && hasAncestorInSet(node, effectNodes)) {
      sites.push(node);
    }
  });
  return sites;
}

function jsxPropMayRenderCallable(name: string): boolean {
  return (
    name === "children" ||
    name === "component" ||
    name === "renderer" ||
    /^render(?:[A-Z]|$)/u.test(name) ||
    /(?:Renderer|Component)$/u.test(name)
  );
}

function localCallableCallback(
  initializer: ts.Expression,
): ts.ArrowFunction | ts.FunctionExpression | null {
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
    return initializer;
  }
  if (
    ts.isCallExpression(initializer) &&
    ts.isIdentifier(initializer.expression) &&
    initializer.expression.text === "useCallback"
  ) {
    const [callback] = initializer.arguments;
    return callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
      ? callback
      : null;
  }
  return null;
}

function functionReadsState(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  state: StateCandidate,
): boolean {
  let reads = false;
  if (!callback.body) {
    return false;
  }
  visitSkippingNestedFunctions(callback.body, callback, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === state.valueName &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      reads = true;
    }
  });
  return reads;
}

export function localCallableByName(
  owner: RuntimeFunctionLike,
  name: string,
): RuntimeFunctionLike | null {
  let callback: RuntimeFunctionLike | null = null;
  visit(owner.body, (node) => {
    if (callback) {
      return;
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      callback = node;
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      callback = localCallableCallback(node.initializer);
    }
  });
  return callback;
}

function hasAncestorInSet(node: ts.Node, ancestors: ReadonlySet<ts.Node>): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ancestors.has(current)) {
      return true;
    }
  }
  return false;
}
