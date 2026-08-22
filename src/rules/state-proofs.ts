import ts from "typescript";

import {
  bindingDeclarationCount,
  hookCallName,
  isDeclarationName,
  isInsideJsxAttribute,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import {
  findAncestor,
  findAncestorUntil,
  isRuntimeFunctionLike,
  nearestNestedFunction,
  nodeWithin,
  type RuntimeFunctionLike,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../ast.js";
import type { StateCandidate } from "../analyze-source.js";
import {
  isSafeProjectionExpression,
  jsxSubtreeAncestors,
  type JsxSubtreeNode,
} from "./deferred-reveal.js";

const EMPTY_BINDINGS: ReadonlySet<string> = new Set();
const EMPTY_NODES: ReadonlySet<ts.Node> = new Set();
const EMPTY_RUNTIME_FUNCTIONS: ReadonlySet<RuntimeFunctionLike> = new Set();

export { stateMayHoldCallable, stateTypeMayBeCallable } from "./callable-state.js";

export function hasIndependentRenderCutWitness(
  returned: ts.Expression,
  excluded: readonly ts.Node[],
  localComponents: ReadonlySet<string>,
  sourceComponents: ReadonlySet<string>
): boolean {
  let hasIndependentComponent = false;
  let independentElements = 0;
  visitSkippingNestedRuntimeFunctions(returned, node => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
    const candidateSubtree: ts.Node = ts.isJsxOpeningElement(node) ? node.parent : node;
    const independent = excluded.every(subtree =>
      candidateSubtree !== subtree &&
      !nodeWithin(candidateSubtree, subtree) &&
      !nodeWithin(subtree, candidateSubtree)
    );
    if (!independent) return;
    for (
      let current: ts.Node | undefined = candidateSubtree.parent;
      current && current !== returned;
      current = current.parent
    ) {
      if (
        (ts.isJsxElement(current) ||
          ts.isJsxFragment(current) ||
          ts.isJsxSelfClosingElement(current)) &&
        excluded.every(subtree =>
          current !== subtree &&
          !nodeWithin(current, subtree) &&
          !nodeWithin(subtree, current)
        )
      ) {
        return;
      }
    }
    independentElements += 1;
    if (hasIndependentComponent) return;
    visit(candidateSubtree, descendant => {
      if (
        hasIndependentComponent ||
        (!ts.isJsxOpeningElement(descendant) && !ts.isJsxSelfClosingElement(descendant))
      ) {
        return;
      }
      const name = descendant.tagName.getText();
      hasIndependentComponent = isComponentBoundaryName(name) ||
        localComponents.has(name) ||
        sourceComponents.has(name);
    });
  });
  return hasIndependentComponent || independentElements >= 2;
}

function isComponentBoundaryName(name: string): boolean {
  const member = name.slice(name.lastIndexOf(".") + 1);
  return member !== "Fragment" && (name.includes(".") || /^[A-Z]/.test(name));
}

export function oneHopRenderProjectionReferences(
  owner: RuntimeFunctionLike,
  renderNodes: readonly ts.Node[],
  isAllowedProjection: (expression: ts.Expression, reference: ts.Node) => boolean =
    isSafeProjectionExpression
): readonly ts.Identifier[] | null {
  if (renderNodes.length === 0 || renderNodes.some(node => !ts.isIdentifier(node))) return null;
  const declarations = new Set(
    renderNodes.map(node => findAncestorUntil(node, ts.isVariableDeclaration, owner))
  );
  const declaration = declarations.size === 1 ? [...declarations][0] : null;
  if (!declaration) return renderNodes as readonly ts.Identifier[];
  if (
    !declaration.initializer ||
    !ts.isIdentifier(declaration.name) ||
    !renderNodes.every(node => nodeWithin(node, declaration.initializer!)) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(owner, declaration.name.text) !== 1 ||
    !renderNodes.every(node => isAllowedProjection(declaration.initializer!, node))
  ) {
    return null;
  }
  const declarationName = declaration.name;
  const references: ts.Identifier[] = [];
  visit(owner.body, node => {
    if (
      ts.isIdentifier(node) &&
      node.text === declarationName.text &&
      node !== declarationName &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return references.length > 0 ? references : null;
}

export function hasDirectPrimitiveInitializer(state: StateCandidate): boolean {
  const initializer = state.call.arguments[0];
  return initializer !== undefined && isDirectPrimitiveExpression(initializer);
}

export function setterCallUsesPreviousValue(call: ts.CallExpression): boolean {
  const argument = call.arguments[0];
  if (!argument || (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument))) return false;
  const parameter = argument.parameters[0];
  if (!parameter || !ts.isIdentifier(parameter.name)) return false;
  const parameterName = parameter.name.text;
  let referenced = false;
  visit(argument.body, node => {
    if (ts.isIdentifier(node) && node.text === parameterName && node !== parameter.name) {
      referenced = true;
    }
  });
  return referenced;
}

export function isDirectPrimitiveExpression(expression: ts.Expression): boolean {
  const value = unwrapTransparentExpression(expression);
  if (
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword ||
    ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    ts.isBigIntLiteral(value) ||
    ts.isNoSubstitutionTemplateLiteral(value)
  ) {
    return true;
  }
  return ts.isPrefixUnaryExpression(value) &&
    (value.operator === ts.SyntaxKind.PlusToken || value.operator === ts.SyntaxKind.MinusToken) &&
    (ts.isNumericLiteral(value.operand) || ts.isBigIntLiteral(value.operand));
}

export function hasOnlyEventCommandReads(
  state: StateCandidate,
  ignored: ReadonlySet<ts.Node> = EMPTY_NODES,
  additionalRoots: ReadonlySet<RuntimeFunctionLike> = EMPTY_RUNTIME_FUNCTIONS
): boolean {
  let safe = true;
  visit(state.owner.body, node => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== state.valueName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node) ||
      node.parent === state.call.parent ||
      ignored.has(node)
    ) {
      return;
    }
    if (findAncestorUntil(node, isJsxNode, state.owner)) return;
    const callback = nearestNestedFunction(node, state.owner);
    if (callback) {
      safe = callbackOrAncestorIsEventRooted(
        callback,
        state,
        additionalRoots
      );
      return;
    }
    if (isHookDependencyReference(node, new Set(["useCallback"]))) {
      const call = findAncestorUntil(node, ts.isCallExpression, state.owner);
      const candidate = call?.arguments[0];
      safe = !!candidate &&
        (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) &&
        callbackIsEventRooted(
          candidate,
          state.owner,
          state.valueName,
          new Set(),
          root => additionalRoots.has(root)
        );
      return;
    }
    safe = false;
  });
  return safe;
}

function callbackOrAncestorIsEventRooted(
  callback: RuntimeFunctionLike,
  state: StateCandidate,
  additionalRoots: ReadonlySet<RuntimeFunctionLike>
): boolean {
  for (
    let candidate: ts.Node | undefined = callback;
    candidate && candidate !== state.owner;
    candidate = additionalRoots.size > 0
      ? findAncestor(candidate, isRuntimeFunctionLike) ?? undefined
      : undefined
  ) {
    if (
      (ts.isArrowFunction(candidate) ||
        ts.isFunctionDeclaration(candidate) ||
        ts.isFunctionExpression(candidate)) &&
      callbackIsEventRooted(
        candidate,
        state.owner,
        state.valueName,
        new Set(),
        root => additionalRoots.has(root)
      )
    ) {
      return true;
    }
  }
  return false;
}

export function callbackIsEventRooted(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
  dependencyName: string,
  seen: ReadonlySet<string>,
  additionalRoot: (
    callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
    owner: RuntimeFunctionLike
  ) => boolean = () => false
): boolean {
  if (additionalRoot(callback, owner)) return true;
  if (callback.body && isInsideJsxEventCallback(callback.body, owner)) return true;
  const name = ts.isFunctionDeclaration(callback)
    ? callback.name?.text
    : ts.isVariableDeclaration(callback.parent) && ts.isIdentifier(callback.parent.name)
      ? callback.parent.name.text
      : ts.isCallExpression(callback.parent) &&
          ts.isVariableDeclaration(callback.parent.parent) &&
          ts.isIdentifier(callback.parent.parent.name)
        ? callback.parent.parent.name.text
        : undefined;
  if (!name || seen.has(name) || bindingDeclarationCount(owner, name) !== 1) return false;
  if (
    dependencyName &&
    ts.isCallExpression(callback.parent) &&
    hookCallName(callback.parent) === "useCallback"
  ) {
    const dependencies = callback.parent.arguments[1];
    if (
      !dependencies ||
      !ts.isArrayLiteralExpression(dependencies) ||
      !dependencies.elements.some(element => ts.isIdentifier(element) && element.text === dependencyName)
    ) {
      return false;
    }
  }

  const nextSeen = new Set(seen).add(name);
  let referenced = false;
  let safe = true;
  visit(owner.body, node => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (isHookDependencyReference(node, new Set(["useCallback"]))) return;
    referenced = true;
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
    if (
      attribute &&
      /^on[A-Z]/.test(attribute.name.getText()) &&
      isJsxEventHandlerReference(attribute, node)
    ) {
      return;
    }
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
      const caller = nearestNestedFunction(node, owner);
      if (
        caller &&
        (ts.isArrowFunction(caller) || ts.isFunctionDeclaration(caller) || ts.isFunctionExpression(caller)) &&
        callbackIsEventRooted(caller, owner, dependencyName, nextSeen, additionalRoot)
      ) {
        return;
      }
    }
    safe = false;
  });
  return referenced && safe;
}

function isJsxEventHandlerReference(
  attribute: ts.JsxAttribute,
  reference: ts.Identifier
): boolean {
  const initializer = attribute.initializer;
  if (
    !initializer ||
    !ts.isJsxExpression(initializer) ||
    !initializer.expression
  ) {
    return false;
  }
  return isConditionalHandlerBranch(initializer.expression, reference);
}

function isConditionalHandlerBranch(
  expression: ts.Expression,
  reference: ts.Identifier
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (value === reference) return true;
  return ts.isConditionalExpression(value) &&
    (isConditionalHandlerBranch(value.whenTrue, reference) ||
      isConditionalHandlerBranch(value.whenFalse, reference));
}

export function isSafeJsxProjectionReference(
  node: ts.Node,
  boundary: ts.Node,
  allowedIdentifierCalls: ReadonlySet<string> = EMPTY_BINDINGS
): boolean {
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, boundary);
  if (attribute) {
    if (attribute.name.getText() === "key") return false;
    const initializer = attribute.initializer;
    return !!initializer &&
      ts.isJsxExpression(initializer) &&
      !!initializer.expression &&
      isSafeProjectionExpression(initializer.expression, node, allowedIdentifierCalls);
  }
  const expression = findAncestorUntil(node, ts.isJsxExpression, boundary);
  return !!expression?.expression &&
    isSafeProjectionExpression(expression.expression, node, allowedIdentifierCalls);
}

export function nearestRepeatedRenderCall(node: ts.Node, boundary: ts.Node): ts.CallExpression | null {
  for (let current: ts.Node | undefined = node; current && current !== boundary; current = current.parent) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      ["map", "flatMap"].includes(current.expression.name.text)
    ) {
      return current;
    }
  }
  return null;
}

export function lowestCommonJsxSubtree(
  nodes: readonly ts.Node[],
  boundary: ts.Node
): JsxSubtreeNode | null {
  const ancestorLists = nodes.map(node => jsxSubtreeAncestors(node, boundary));
  const first = ancestorLists[0];
  if (!first || ancestorLists.some(ancestors => ancestors.length === 0)) return null;
  return first.find(candidate => ancestorLists.every(ancestors => ancestors.includes(candidate))) ?? null;
}

export function jsxElementCountIn(node: ts.Node): number {
  let count = 0;
  visit(node, current => {
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) count += 1;
  });
  return count;
}

export function jsxElementCount(owner: RuntimeFunctionLike): number {
  let count = 0;
  visit(owner.body, node => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) count += 1;
  });
  return count;
}

export function hasUnstableSubtreeLifetime(
  node: JsxSubtreeNode,
  boundary: ts.Node
): boolean {
  let renderReturns = 0;
  visitSkippingNestedRuntimeFunctions(boundary, current => {
    if (ts.isReturnStatement(current) && current.expression) renderReturns += 1;
  });
  if (renderReturns > 1) return true;
  for (let current: ts.Node | undefined = node; current && current !== boundary; current = current.parent) {
    if (
      (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) &&
      (ts.isJsxElement(current) ? current.openingElement : current).attributes.properties.some(
        property => ts.isJsxAttribute(property) && property.name.getText() === "key"
      )
    ) {
      return true;
    }
    if (
      ts.isConditionalExpression(current) ||
      ts.isIfStatement(current) ||
      ts.isSwitchStatement(current) ||
      ts.isCaseClause(current) ||
      ts.isDefaultClause(current) ||
      (ts.isBinaryExpression(current) &&
        (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) ||
      (ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression) &&
        ["map", "flatMap"].includes(current.expression.name.text))
    ) {
      return true;
    }
  }
  return false;
}

export function isInsideJsxEventCallback(node: ts.Node, boundary: RuntimeFunctionLike): boolean {
  for (let current: ts.Node | undefined = node.parent; current && current !== boundary; current = current.parent) {
    if (!isRuntimeFunctionLike(current)) continue;
    const attribute = findAncestorUntil(current, ts.isJsxAttribute, boundary);
    if (
      attribute &&
      isInsideJsxAttribute(current, attribute) &&
      /^on[A-Z]/.test(attribute.name.getText())
    ) {
      return true;
    }
  }
  return false;
}

export function isSynchronousRenderCallback(node: ts.FunctionLikeDeclaration): boolean {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    let expression: ts.Expression = node;
    while (
      (ts.isParenthesizedExpression(expression.parent) ||
        ts.isAsExpression(expression.parent) ||
        ts.isTypeAssertionExpression(expression.parent) ||
        ts.isSatisfiesExpression(expression.parent) ||
        ts.isNonNullExpression(expression.parent)) &&
      expression.parent.expression === expression
    ) {
      expression = expression.parent;
    }
    if (ts.isCallExpression(expression.parent) && expression.parent.expression === expression) {
      return true;
    }
  }
  const parent = node.parent;
  if (!ts.isCallExpression(parent)) return false;
  if (ts.isIdentifier(parent.expression) && parent.expression.text === "useMemo") return true;
  return (
    ts.isPropertyAccessExpression(parent.expression) &&
    ["every", "filter", "find", "findIndex", "flatMap", "map", "reduce", "reduceRight", "some"].includes(
      parent.expression.name.text
    )
  );
}

export function isJsxNode(
  node: ts.Node
): node is ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxExpression | ts.JsxAttribute | ts.JsxFragment {
  return (
    ts.isJsxElement(node) ||
    ts.isJsxSelfClosingElement(node) ||
    ts.isJsxExpression(node) ||
    ts.isJsxAttribute(node) ||
    ts.isJsxFragment(node)
  );
}

export function isHookDependencyReference(
  node: ts.Identifier,
  hookNames: ReadonlySet<string>
): boolean {
  const array = node.parent;
  if (!ts.isArrayLiteralExpression(array) || !array.elements.includes(node)) return false;
  const call = array.parent;
  return ts.isCallExpression(call) &&
    call.arguments[1] === array &&
    ts.isIdentifier(call.expression) &&
    hookNames.has(call.expression.text);
}

export function repeatedRenderHasStableItemKey(
  callback: ts.ArrowFunction | ts.FunctionExpression
): boolean {
  const parameter = callback.parameters[0]?.name;
  if (!parameter) return false;
  let stable = false;
  visitSkippingNestedRuntimeFunctions(callback.body, node => {
    if (!ts.isJsxAttribute(node) || node.name.getText() !== "key" || !node.initializer) return;
    const expression = ts.isJsxExpression(node.initializer) ? node.initializer.expression : null;
    if (!expression) return;
    if (expressionDependsOnBinding(expression, parameter, callback)) stable = true;
  });
  return stable;
}

export function expressionDependsOnBinding(
  expression: ts.Expression,
  binding: ts.BindingName,
  boundary: ts.Node
): boolean {
  let found = false;
  visit(expression, node => {
    if (!ts.isIdentifier(node)) return;
    if (bindingContainsName(binding, node.text)) {
      found = true;
      return;
    }
    const declaration = uniqueVariableDeclaration(boundary, node.text);
    if (declaration?.initializer && expressionDependsOnBinding(declaration.initializer, binding, declaration)) {
      found = true;
    }
  });
  return found;
}

export function bindingContainsName(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some(
    element => ts.isBindingElement(element) && bindingContainsName(element.name, name)
  );
}

export function uniqueVariableDeclaration(boundary: ts.Node, name: string): ts.VariableDeclaration | null {
  const matches: ts.VariableDeclaration[] = [];
  visitSkippingNestedRuntimeFunctions(boundary, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) matches.push(node);
  });
  return matches.length === 1 ? matches[0]! : null;
}

export function localFunctionBinding(
  owner: RuntimeFunctionLike,
  name: string
): ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression | null {
  if (!owner.body || bindingDeclarationCount(owner, name) !== 1) return null;
  let match: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression | null = null;
  visit(owner.body, node => {
    if (match) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      match = node;
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      match = node.initializer;
    }
  });
  return match;
}
