import ts from "typescript";

import {
  bindingDeclarationCount,
  isDeclarationName,
  isDirectJsxAttributeExpression,
  isNonValueIdentifier,
} from "../analysis-ast.js";
import type { StateCandidate } from "../analyze-source.js";
import {
  findAncestorUntil,
  nearestNestedFunction,
  nodeWithin,
  type RuntimeFunctionLike,
  visit,
  visitSkippingNestedFunctions,
  visitSkippingNestedRuntimeFunctions,
} from "../ast.js";
import {
  isInsideJsxEventCallback,
  isJsxNode,
  isSynchronousRenderCallback,
  setterCallUsesPreviousValue,
} from "./state-proofs.js";

export interface CommandOnlyCallableReads {
  effectSites: readonly ts.Identifier[];
  renderSites: readonly ts.Identifier[];
}

interface CommandOnlyUsage {
  setterCallNodes: readonly ts.CallExpression[];
  setterUsesPreviousValue: boolean;
}

export function collectCommandOnlyCallableReads(
  state: StateCandidate,
  effectNodes: ReadonlySet<ts.Node>
): CommandOnlyCallableReads {
  const names = localStateReadCallableNames(state);
  return {
    effectSites: localCallableEffectSites(state, names, effectNodes),
    renderSites: localCallableRenderSites(state, names),
  };
}

export function functionalUpdaterPrecedesSnapshotRead(
  state: StateCandidate,
  usage: CommandOnlyUsage,
  nearestMutationFunction: (node: ts.Node, owner: RuntimeFunctionLike) => RuntimeFunctionLike
): boolean {
  if (!usage.setterUsesPreviousValue) return false;
  return usage.setterCallNodes.some(call => {
    if (!setterCallUsesPreviousValue(call)) return false;
    const region = nearestMutationFunction(call, state.owner);
    if (!region.body) return true;
    let readAfterWrite = false;
    visitSkippingNestedRuntimeFunctions(region.body, node => {
      if (
        ts.isIdentifier(node) &&
        node.text === state.valueName &&
        node.getStart() > call.end &&
        !isDeclarationName(node) &&
        !isNonValueIdentifier(node)
      ) {
        readAfterWrite = true;
      }
    });
    return readAfterWrite;
  });
}

export function stateReadCallbackEscapesThroughUnknownHook(state: StateCandidate): boolean {
  let escaped = false;
  visit(state.owner.body, node => {
    if (
      escaped ||
      !ts.isIdentifier(node) ||
      node.text !== state.valueName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node) ||
      node.parent === state.call.parent
    ) {
      return;
    }
    for (
      let current: ts.Node | undefined = node.parent;
      current && current !== state.owner;
      current = current.parent
    ) {
      if (!ts.isCallExpression(current) || !current.arguments.some(argument => nodeWithin(node, argument))) {
        continue;
      }
      const hookName = ts.isIdentifier(current.expression)
        ? current.expression.text
        : ts.isPropertyAccessExpression(current.expression)
          ? current.expression.name.text
          : null;
      if (
        hookName &&
        /^use[A-Z0-9]/.test(hookName) &&
        ![
          "useCallback",
          "useMemo",
          "useEffect",
          "useLayoutEffect",
          "useInsertionEffect",
        ].includes(hookName) &&
        bindingDeclarationCount(state.owner, hookName) === 0
      ) {
        escaped = true;
        return;
      }
    }
  });
  return escaped;
}

export function statePublishesReadOnlyGetter(state: StateCandidate): boolean {
  const getterNames = [...localStateReadCallableNames(state)].filter(name => {
    const callback = localCallableByName(state.owner, name);
    if (!callback?.body) return false;
    return !ts.isBlock(callback.body) ||
      (callback.body.statements.length === 1 && ts.isReturnStatement(callback.body.statements[0]!));
  });
  return getterNames.some(name => localBindingReachesReturnedJsxValue(state.owner, name));
}

function localStateReadCallableNames(state: StateCandidate): ReadonlySet<string> {
  const names = new Set<string>();
  visit(state.owner.body, node => {
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
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
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
  names: ReadonlySet<string>
): readonly ts.Identifier[] {
  if (names.size === 0) return [];
  const sites: ts.Identifier[] = [];
  visit(state.owner.body, node => {
    if (!ts.isIdentifier(node) || !names.has(node.text)) return;
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, state.owner);
    if (
      attribute &&
      isDirectJsxAttributeExpression(attribute, node) &&
      jsxPropMayRenderCallable(attribute.name.getText())
    ) {
      sites.push(node);
      return;
    }
    if (
      !ts.isCallExpression(node.parent) ||
      node.parent.expression !== node ||
      isInsideJsxEventCallback(node, state.owner)
    ) {
      return;
    }
    const callback = nearestNestedFunction(node, state.owner);
    if (
      findAncestorUntil(node.parent, isJsxNode, state.owner) !== null ||
      callback === null ||
      isSynchronousRenderCallback(callback)
    ) {
      sites.push(node);
    }
  });
  return sites;
}

function localCallableEffectSites(
  state: StateCandidate,
  names: ReadonlySet<string>,
  effectNodes: ReadonlySet<ts.Node>
): readonly ts.Identifier[] {
  if (names.size === 0 || effectNodes.size === 0) return [];
  const sites: ts.Identifier[] = [];
  visit(state.owner.body, node => {
    if (ts.isIdentifier(node) && names.has(node.text) && hasAncestorInSet(node, effectNodes)) {
      sites.push(node);
    }
  });
  return sites;
}

function jsxPropMayRenderCallable(name: string): boolean {
  return name === "children" ||
    name === "component" ||
    name === "renderer" ||
    /^render(?:[A-Z]|$)/.test(name) ||
    /(?:Renderer|Component)$/.test(name);
}

function localCallableCallback(
  initializer: ts.Expression
): ts.ArrowFunction | ts.FunctionExpression | null {
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return initializer;
  if (
    ts.isCallExpression(initializer) &&
    ts.isIdentifier(initializer.expression) &&
    initializer.expression.text === "useCallback"
  ) {
    const callback = initializer.arguments[0];
    return callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
      ? callback
      : null;
  }
  return null;
}

function functionReadsState(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  state: StateCandidate
): boolean {
  let reads = false;
  if (!callback.body) return false;
  visitSkippingNestedFunctions(callback.body, callback, node => {
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

function localCallableByName(
  owner: RuntimeFunctionLike,
  name: string
): RuntimeFunctionLike | null {
  let callback: RuntimeFunctionLike | null = null;
  visit(owner.body, node => {
    if (callback) return;
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

function localBindingReachesReturnedJsxValue(
  owner: RuntimeFunctionLike,
  name: string
): boolean {
  let published = false;
  visit(owner.body, node => {
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
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
    if (isContextValueAttribute(attribute)) {
      published = true;
      return;
    }
    const declaration = findAncestorUntil(node, ts.isVariableDeclaration, owner);
    if (!declaration || !ts.isIdentifier(declaration.name)) return;
    const valueName = declaration.name.text;
    visit(owner.body, reference => {
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
  });
  return published;
}

function isContextValueAttribute(attribute: ts.JsxAttribute | null): boolean {
  return attribute?.name.getText() === "value" && jsxTargetName(attribute)?.endsWith(".Provider") === true;
}

function jsxTargetName(attribute: ts.JsxAttribute): string | null {
  const opening = attribute.parent;
  if (!ts.isJsxAttributes(opening)) return null;
  const element = opening.parent;
  if (!ts.isJsxOpeningElement(element) && !ts.isJsxSelfClosingElement(element)) return null;
  return element.tagName.getText();
}

function hasAncestorInSet(node: ts.Node, ancestors: ReadonlySet<ts.Node>): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ancestors.has(current)) return true;
  }
  return false;
}
