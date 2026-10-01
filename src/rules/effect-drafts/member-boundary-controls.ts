import {
  bindingDeclarationCount,
  hookCallName,
  isDeclarationName,
  isNonValueIdentifier,
} from "../../core/analysis-ast.js";
import {
  findAncestorUntil,
  identifiersNamed,
  nearestNestedFunction,
  nodeWithin,
  visit,
} from "../../core/ast.js";
import { isJsxNode, isSynchronousRenderCallback } from "../state-proofs/callback-sites.js";
import {
  isSafeJsxProjectionReference,
  nearestRepeatedRenderCall,
} from "../state-proofs/jsx-subtrees.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateCandidate } from "../../analysis/model.js";
import { expressionDependsOnBinding } from "../state-proofs/binding-lookup.js";
import { repeatedRenderHasStableItemKey } from "../state-proofs/unique-repeated-selection.js";
import ts from "typescript";

const NO_HOOKS: ReadonlySet<string> = new Set();

export function stateControlsHookOrRepeatedBoundary(state: StateCandidate): boolean {
  const controls = (name: string): boolean =>
    valueReferences(state, name).some((reference) =>
      referenceControlsHookOrRepeatedBoundary(reference, state.owner),
    );
  return (
    controls(state.valueName) ||
    valueReferences(state, state.valueName).some((reference) => {
      const alias = constAliasName(reference, state.owner);
      return alias !== null && controls(alias);
    }) ||
    renderDerivations(state).some((name) =>
      valueReferences(state, name).some((reference) => referenceFeedsHook(reference, state.owner)),
    )
  );
}

/** Render-time `const` derivations of the state, transitively; a hook reading one would go stale. */
function renderDerivations(state: StateCandidate): readonly string[] {
  const names = [state.valueName];
  for (const name of names) {
    for (const reference of valueReferences(state, name)) {
      const alias = constAliasName(reference, state.owner);
      if (
        alias !== null &&
        !names.includes(alias) &&
        nearestNestedFunction(reference, state.owner) === null &&
        !referenceFeedsHook(reference, state.owner)
      ) {
        names.push(alias);
      }
    }
  }
  return names.slice(1);
}

function valueReferences(state: StateCandidate, name: string): ts.Identifier[] {
  return identifiersNamed(state.owner.body, name).filter(
    (node) =>
      !isDeclarationName(node) && !isNonValueIdentifier(node) && node.parent !== state.call.parent,
  );
}

function constAliasName(reference: ts.Identifier, owner: RuntimeFunctionLike): string | null {
  const declaration = findAncestorUntil(reference, ts.isVariableDeclaration, owner);
  return declaration?.initializer &&
    ts.isIdentifier(declaration.name) &&
    nodeWithin(reference, declaration.initializer) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
    bindingDeclarationCount(owner, declaration.name.text) === 1
    ? declaration.name.text
    : null;
}

function referenceControlsHookOrRepeatedBoundary(
  reference: ts.Identifier,
  owner: RuntimeFunctionLike,
): boolean {
  for (
    let current: ts.Node | undefined = reference.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (
      ts.isCallExpression(current) &&
      isHookCallOtherThan(current, new Set(["useCallback", "useMemo"])) &&
      current.arguments.some((argument) => nodeWithin(reference, argument))
    ) {
      return true;
    }
    if (
      ts.isCallExpression(current) &&
      ["useCallback", "useMemo"].includes(hookCallName(current) ?? "") &&
      hookResultFeedsLifecycle(current, owner)
    ) {
      return true;
    }
  }
  const repeated = nearestRepeatedRenderCall(reference, owner);
  const repeatedOwner = repeated ? nearestNestedFunction(repeated, owner) : null;
  if (
    repeated &&
    (!repeatedOwner || isSynchronousRenderCallback(repeatedOwner)) &&
    ((!findAncestorUntil(reference, isJsxNode, repeated) &&
      !isOneHopKeyedRenderAlias(reference, repeated)) ||
      expressionControlsRepeatedItems(reference, repeated))
  ) {
    return true;
  }
  return (
    nearestNestedFunction(reference, owner) === null &&
    !findAncestorUntil(reference, isJsxNode, owner) &&
    findAncestorUntil(reference, ts.isIfStatement, owner) !== null
  );
}

function isOneHopKeyedRenderAlias(reference: ts.Identifier, repeated: ts.CallExpression): boolean {
  const [callback] = repeated.arguments;
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    !repeatedRenderHasStableItemKey(callback)
  ) {
    return false;
  }
  const declaration = findAncestorUntil(reference, ts.isVariableDeclaration, callback);
  const binding = callback.parameters[0]?.name;
  if (
    !binding ||
    !declaration?.initializer ||
    !ts.isIdentifier(declaration.name) ||
    !nodeWithin(reference, declaration.initializer) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(callback, declaration.name.text) !== 1 ||
    !expressionDependsOnBinding(declaration.initializer, binding, callback)
  ) {
    return false;
  }
  return aliasStaysInKeyedRender(declaration.name, { callback, repeated });
}

function aliasStaysInKeyedRender(
  declarationName: ts.Identifier,
  scope: { callback: ts.ArrowFunction | ts.FunctionExpression; repeated: ts.CallExpression },
): boolean {
  let found = false;
  let safe = true;
  visit(scope.callback.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== declarationName.text ||
      node === declarationName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    found = true;
    safe =
      nearestRepeatedRenderCall(node, scope.repeated.parent) === scope.repeated &&
      findAncestorUntil(node, isJsxNode, scope.repeated) !== null &&
      isSafeJsxProjectionReference(node, scope.callback);
  });
  return found && safe;
}

export function hasStaleUseCallbackCapture(state: StateCandidate): boolean {
  let stale = false;
  visit(state.owner.body, (node) => {
    if (
      stale ||
      !ts.isIdentifier(node) ||
      node.text !== state.valueName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node) ||
      node.parent === state.call.parent
    ) {
      return;
    }
    const callback = nearestNestedFunction(node, state.owner);
    const call = callback?.parent;
    if (
      callback &&
      call &&
      ts.isCallExpression(call) &&
      hookCallName(call) === "useCallback" &&
      call.arguments[0] === callback
    ) {
      const [, dependencies] = call.arguments;
      stale =
        !dependencies ||
        !ts.isArrayLiteralExpression(dependencies) ||
        !dependencies.elements.some(
          (element) => ts.isIdentifier(element) && element.text === state.valueName,
        );
    }
  });
  return stale;
}

function referenceFeedsHook(reference: ts.Identifier, owner: RuntimeFunctionLike): boolean {
  return (
    findAncestorUntil(
      reference,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        isHookCallOtherThan(node, NO_HOOKS) &&
        node.arguments.some((argument) => nodeWithin(reference, argument)),
      owner,
    ) !== null
  );
}

function hookResultFeedsLifecycle(call: ts.CallExpression, owner: RuntimeFunctionLike): boolean {
  const declaration = findAncestorUntil(call, ts.isVariableDeclaration, owner);
  if (!declaration || declaration.initializer !== call || !ts.isIdentifier(declaration.name)) {
    return true;
  }
  const name = declaration.name.text;
  let feedsLifecycle = false;
  visit(owner.body, (node) => {
    if (feedsLifecycle || !ts.isIdentifier(node) || node.text !== name || isDeclarationName(node)) {
      return;
    }
    for (
      let current: ts.Node | undefined = node.parent;
      current && current !== owner;
      current = current.parent
    ) {
      if (
        ts.isCallExpression(current) &&
        isHookCallOtherThan(current, new Set(["useCallback", "useMemo"])) &&
        current.arguments.some((argument) => nodeWithin(node, argument))
      ) {
        feedsLifecycle = true;
        return;
      }
    }
  });
  return feedsLifecycle;
}

function isHookCallOtherThan(call: ts.CallExpression, allowed: ReadonlySet<string>): boolean {
  const name = hookCallName(call);
  return name !== null && /^use[A-Z0-9]/u.test(name) && !allowed.has(name);
}

function expressionControlsRepeatedItems(node: ts.Node, repeated: ts.CallExpression): boolean {
  const receiver = ts.isPropertyAccessExpression(repeated.expression)
    ? repeated.expression.expression
    : null;
  return receiver !== null && nodeWithin(node, receiver);
}
