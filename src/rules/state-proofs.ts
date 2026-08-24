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
const PURE_MATH_PROJECTION_CALLS: ReadonlySet<string> = new Set(["Math.max", "Math.min"]);

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

export function boundedRenderProjectionReferences(
  owner: RuntimeFunctionLike,
  renderNodes: readonly ts.Node[],
  maxHops = 3
): readonly ts.Identifier[] | null {
  if (
    renderNodes.length === 0 ||
    renderNodes.some(node => !ts.isIdentifier(node))
  ) {
    return null;
  }

  let references = renderNodes as readonly ts.Identifier[];
  let hops = 0;
  while (hops < maxHops) {
    const declarations = new Set(
      references.map(node => findAncestorUntil(node, ts.isVariableDeclaration, owner))
    );
    const declaration = declarations.size === 1 ? [...declarations][0] : null;
    if (!declaration) return hops >= 2 ? references : null;
    if (
      !declaration.initializer ||
      !ts.isIdentifier(declaration.name) ||
      !references.every(node => nodeWithin(node, declaration.initializer!)) ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
      bindingDeclarationCount(owner, declaration.name.text) !== 1 ||
      !references.every(node =>
        isSafeProjectionExpression(
          declaration.initializer!,
          node,
          EMPTY_BINDINGS,
          sourceHasRuntimeBinding(owner.getSourceFile(), "Math")
            ? EMPTY_BINDINGS
            : PURE_MATH_PROJECTION_CALLS
        )
      )
    ) {
      return null;
    }

    const declarationName = declaration.name.text;
    const next: ts.Identifier[] = [];
    visit(owner.body, node => {
      if (
        ts.isIdentifier(node) &&
        node.text === declarationName &&
        node !== declaration.name &&
        !isDeclarationName(node) &&
        !isNonValueIdentifier(node)
      ) {
        next.push(node);
      }
    });
    if (next.length === 0) return null;
    references = next;
    hops += 1;
  }

  return references.some(node =>
    findAncestorUntil(node, ts.isVariableDeclaration, owner)
  ) ? null : references;
}

export function sourceHasRuntimeBinding(sourceFile: ts.SourceFile, name: string): boolean {
  let found = false;
  visit(sourceFile, node => {
    if (found) return;
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
      bindingContainsName(node.name, name)
    ) {
      found = true;
      return;
    }
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)) &&
      node.name?.text === name
    ) {
      found = true;
      return;
    }
    if (
      (ts.isImportClause(node) && node.name?.text === name) ||
      (ts.isImportSpecifier(node) && node.name.text === name) ||
      (ts.isNamespaceImport(node) && node.name.text === name) ||
      (ts.isCatchClause(node) && node.variableDeclaration &&
        bindingContainsName(node.variableDeclaration.name, name))
    ) {
      found = true;
    }
  });
  return found;
}

export function isUnshadowedMathCall(
  owner: RuntimeFunctionLike,
  call: ts.CallExpression,
  methods: ReadonlySet<string>
): boolean {
  const callee = call.expression;
  return !sourceHasRuntimeBinding(owner.getSourceFile(), "Math") &&
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Math" &&
    methods.has(callee.name.text);
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

export function isJsxEventHandlerReference(
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

export function hasRepeatedJsxRenderWorkOutside(
  owner: RuntimeFunctionLike,
  excludedSubtree: ts.Node
): boolean {
  if (!owner.body) return false;
  let repeated = false;
  visitSkippingNestedRuntimeFunctions(owner.body, node => {
    if (
      repeated ||
      !ts.isCallExpression(node) ||
      nodeWithin(node, excludedSubtree) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      !["map", "flatMap"].includes(node.expression.name.text) ||
      node.questionDotToken !== undefined ||
      node.expression.questionDotToken !== undefined ||
      isConditionallyEvaluated(node, owner)
    ) {
      return;
    }
    const callback = node.arguments[0];
    if (
      callback &&
      (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
      jsxElementCountIn(callback.body) > 0
    ) {
      repeated = true;
    }
  });
  return repeated;
}

function isConditionallyEvaluated(node: ts.Node, boundary: ts.Node): boolean {
  for (let current = node.parent; current && current !== boundary; current = current.parent) {
    if (
      ts.isConditionalExpression(current) ||
      ts.isIfStatement(current) ||
      ts.isSwitchStatement(current) ||
      ts.isCaseClause(current) ||
      ts.isDefaultClause(current) ||
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current) ||
      ts.isTryStatement(current) ||
      ts.isCatchClause(current) ||
      (ts.isBinaryExpression(current) &&
        (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))
    ) {
      return true;
    }
  }
  return false;
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

export function isUniquelySelectedRepeatedProjection(
  nodes: readonly ts.Node[],
  boundary: RuntimeFunctionLike
): boolean {
  const repeatedCalls = nodes.map(node => nearestRepeatedRenderCall(node, boundary));
  const repeated = repeatedCalls[0];
  if (
    !repeated ||
    repeatedCalls.some(call => call !== repeated) ||
    !ts.isPropertyAccessExpression(repeated.expression) ||
    repeated.expression.name.text !== "map"
  ) {
    return false;
  }
  const callback = repeated.arguments[0];
  const item = callback &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
    callback.parameters[0]?.name;
  if (!callback || !item || !ts.isIdentifier(item)) return false;
  const receiver = unwrapTransparentExpression(repeated.expression.expression);
  if (ts.isIdentifier(receiver) && bindingIsReferenced(callback, receiver.text)) return false;
  if (!expressionIsUniquelyFiltered(repeated.expression.expression, boundary)) return false;

  const clauses = new Set(
    nodes.map(node => findAncestorUntil(node, ts.isCaseClause, callback))
  );
  const clause = clauses.size === 1 ? [...clauses][0] : null;
  if (!clause || !isPrimitiveLiteral(clause.expression)) return false;
  const switchStatement = findAncestorUntil(clause, ts.isSwitchStatement, callback);
  const switchExpression = switchStatement &&
    unwrapTransparentExpression(switchStatement.expression);
  const returnStatement = clause.statements[0];
  if (
    !switchExpression ||
    !ts.isIdentifier(switchExpression) ||
    switchExpression.text !== item.text ||
    clause.statements.length !== 1 ||
    !returnStatement ||
    !ts.isReturnStatement(returnStatement) ||
    !returnStatement.expression ||
    !nodes.every(node => nodeWithin(node, returnStatement.expression!))
  ) {
    return false;
  }
  const leaf = nearestJsxElement(nodes[0]!, clause);
  return !!leaf &&
    nodes.every(node => nearestJsxElement(node, clause) === leaf) &&
    jsxKeyMatchesLiteral(leaf, clause.expression);
}

function expressionIsUniquelyFiltered(expression: ts.Expression, boundary: ts.Node): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(value)) {
    const declaration = uniqueVariableDeclaration(boundary, value.text);
    return !!declaration?.initializer &&
      ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
      expressionIsUniquelyFiltered(declaration.initializer, boundary);
  }
  if (!ts.isCallExpression(value) || !ts.isPropertyAccessExpression(value.expression)) return false;
  if (value.expression.name.text !== "filter") return false;
  if (isExactUniquenessFilter(value, boundary)) return true;
  return isPureSubsetFilter(value, boundary) &&
    expressionIsUniquelyFiltered(value.expression.expression, boundary);
}

function bindingIsReferenced(node: ts.Node, name: string): boolean {
  let found = false;
  visit(node, current => {
    if (
      ts.isIdentifier(current) &&
      current.text === name &&
      !isDeclarationName(current) &&
      !isNonValueIdentifier(current)
    ) {
      found = true;
    }
  });
  return found;
}

function isPureSubsetFilter(call: ts.CallExpression, boundary: ts.Node): boolean {
  const callback = call.arguments[0];
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    ts.isBlock(callback.body)
  ) {
    return false;
  }
  const allowedCalls = new Set<string>();
  let callsAreReadOnly = true;
  visit(callback.body, node => {
    if (!ts.isCallExpression(node)) return;
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "includes" &&
      ts.isIdentifier(node.expression.expression) &&
      expressionHasArrayType(node.expression.expression, boundary)
    ) {
      allowedCalls.add(`${node.expression.expression.text}.includes`);
    } else {
      callsAreReadOnly = false;
    }
  });
  return callsAreReadOnly && isSafeProjectionExpression(
    callback.body,
    callback.body,
    EMPTY_BINDINGS,
    allowedCalls
  );
}

function isExactUniquenessFilter(call: ts.CallExpression, boundary: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  if (!expressionHasArrayType(call.expression.expression, boundary)) return false;
  const callback = call.arguments[0];
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return false;
  const [item, index, array] = callback.parameters.map(parameter => parameter.name);
  if (!item || !index || !array ||
    !ts.isIdentifier(item) || !ts.isIdentifier(index) || !ts.isIdentifier(array)) {
    return false;
  }
  const onlyStatement = ts.isBlock(callback.body) ? callback.body.statements[0] : undefined;
  const body = ts.isBlock(callback.body)
    ? callback.body.statements.length === 1 && onlyStatement && ts.isReturnStatement(onlyStatement)
      ? onlyStatement.expression
      : undefined
    : callback.body;
  if (!body) return false;
  const comparison = unwrapTransparentExpression(body);
  if (
    !ts.isBinaryExpression(comparison) ||
    comparison.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
  ) {
    return false;
  }
  return isIndexOfItem(comparison.left, array.text, item.text) &&
    ts.isIdentifier(comparison.right) && comparison.right.text === index.text;
}

function expressionHasArrayType(expression: ts.Expression, boundary: ts.Node): boolean {
  let value: ts.Expression = expression;
  while (ts.isParenthesizedExpression(value)) value = value.expression;
  if (ts.isArrayLiteralExpression(value)) return true;
  if (ts.isAsExpression(value) || ts.isTypeAssertionExpression(value)) {
    return ts.isArrayTypeNode(value.type);
  }
  if (!ts.isIdentifier(value)) return false;
  const name = value.text;
  const types: ts.TypeNode[] = [];
  visit(boundary.getSourceFile(), node => {
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      const type = destructuredBindingType(node);
      if (type) types.push(type);
      return;
    }
    if (
      (!ts.isParameter(node) && !ts.isVariableDeclaration(node)) ||
      !ts.isIdentifier(node.name) ||
      node.name.text !== name
    ) {
      return;
    }
    if (node.type) types.push(node.type);
  });
  return types.length === 1 && ts.isArrayTypeNode(types[0]!);
}

function destructuredBindingType(binding: ts.BindingElement): ts.TypeNode | undefined {
  const declaration = findAncestor(
    binding,
    (node): node is ts.ParameterDeclaration | ts.VariableDeclaration =>
      ts.isParameter(node) || ts.isVariableDeclaration(node)
  );
  if (!declaration?.type || !ts.isTypeLiteralNode(declaration.type)) return undefined;
  const sourceName = binding.propertyName?.getText() ?? binding.name.getText();
  const property = declaration.type.members.find(member =>
    ts.isPropertySignature(member) && member.name?.getText() === sourceName
  );
  return property && ts.isPropertySignature(property) ? property.type : undefined;
}

function isIndexOfItem(expression: ts.Expression, array: string, item: string): boolean {
  const value = unwrapTransparentExpression(expression);
  const argument = ts.isCallExpression(value) ? value.arguments[0] : undefined;
  return ts.isCallExpression(value) &&
    value.arguments.length === 1 &&
    ts.isPropertyAccessExpression(value.expression) &&
    value.expression.name.text === "indexOf" &&
    ts.isIdentifier(value.expression.expression) &&
    value.expression.expression.text === array &&
    !!argument && ts.isIdentifier(argument) &&
    argument.text === item;
}

function isPrimitiveLiteral(expression: ts.Expression): boolean {
  const value = unwrapTransparentExpression(expression);
  return ts.isStringLiteralLike(value) || ts.isNumericLiteral(value);
}

function nearestJsxElement(
  node: ts.Node,
  boundary: ts.Node
): ts.JsxElement | ts.JsxSelfClosingElement | null {
  return findAncestorUntil(
    node,
    (candidate): candidate is ts.JsxElement | ts.JsxSelfClosingElement =>
      ts.isJsxElement(candidate) || ts.isJsxSelfClosingElement(candidate),
    boundary
  );
}

function jsxKeyMatchesLiteral(
  element: ts.JsxElement | ts.JsxSelfClosingElement,
  literal: ts.Expression
): boolean {
  const opening = ts.isJsxElement(element) ? element.openingElement : element;
  const key = opening.attributes.properties.find(
    property => ts.isJsxAttribute(property) && property.name.getText() === "key"
  );
  if (!key || !ts.isJsxAttribute(key) || !key.initializer) return false;
  const keyValue = ts.isStringLiteral(key.initializer)
    ? key.initializer
    : ts.isJsxExpression(key.initializer) && key.initializer.expression
      ? unwrapTransparentExpression(key.initializer.expression)
      : null;
  const caseValue = unwrapTransparentExpression(literal);
  return !!keyValue &&
    ((ts.isStringLiteralLike(keyValue) && ts.isStringLiteralLike(caseValue) &&
      keyValue.text === caseValue.text) ||
      (ts.isNumericLiteral(keyValue) && ts.isNumericLiteral(caseValue) &&
        keyValue.text === caseValue.text));
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
