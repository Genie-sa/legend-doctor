import ts from "typescript";

import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
  isPureExpression,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import {
  findAncestorUntil,
  nearestNestedFunction,
  nodeWithin,
  type RuntimeFunctionLike,
  visit,
  visitSkippingNestedFunctions,
  visitSkippingNestedRuntimeFunctions,
} from "../ast.js";
import type { StateCandidate, StateUsage } from "../analyze-source.js";
import {
  expressionContainsJsx,
  isRenderGateReference,
  isSafeProjectionExpression,
} from "./deferred-reveal.js";
import { mutationRegionOnlyCallsStateSetters } from "./effect-drafts.js";
import {
  callbackIsEventRooted,
  expressionDependsOnBinding,
  hasDirectPrimitiveInitializer,
  hasOnlyEventCommandReads,
  isHookDependencyReference,
  isInsideJsxEventCallback,
  isJsxNode,
  isSafeJsxProjectionReference,
  isSynchronousRenderCallback,
  jsxElementCount,
  jsxElementCountIn,
  lowestCommonJsxSubtree,
  nearestRepeatedRenderCall,
  oneHopRenderProjectionReferences,
  repeatedRenderHasStableItemKey,
  stateMayHoldCallable,
} from "./state-proofs.js";

const KEYED_COLLECTION_PROPERTIES = new Set(["entries", "has", "keys", "size", "values"]);
const MEMO_CALLBACK_HOOKS = new Set(["useCallback", "useMemo"]);

export interface KeyedSelectionAnalysis {
  collectionStates: ReadonlySet<StateCandidate>;
  scalarStates: ReadonlySet<StateCandidate>;
  secondaryLeafStates: ReadonlySet<StateCandidate>;
}

export function analyzeKeyedSelections(
  states: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
  safeCommandStates: ReadonlySet<StateCandidate>,
  statesWithCompanionWrites: ReadonlySet<StateCandidate>
): KeyedSelectionAnalysis {
  const collectionStates = new Set(
    states.filter(state =>
      !statesWithCompanionWrites.has(state) &&
      safeCommandStates.has(state) &&
      isKeyedLeafCollectionState(state, usageByState.get(state))
    )
  );
  const scalarStates = new Set(
    states.filter(state => {
      const usage = usageByState.get(state);
      return safeCommandStates.has(state) &&
        (!statesWithCompanionWrites.has(state) || hasIndependentRepeatedEventWrite(state, usage)) &&
        isKeyedLeafScalarState(state, usage);
    })
  );
  const secondaryLeafStates = new Set(
    states.filter(state => {
      const usage = usageByState.get(state);
      return safeCommandStates.has(state) &&
        (!statesWithCompanionWrites.has(state) || hasIndependentRepeatedEventWrite(state, usage)) &&
        isKeyedScalarWithSecondaryLeaf(state, usage);
    })
  );
  return { collectionStates, scalarStates, secondaryLeafStates };
}





















export function isSetOrMapState(call: ts.CallExpression): boolean {
  const type = call.typeArguments?.[0];
  if (type && /^(?:Readonly)?(?:Set|Map)</.test(type.getText())) return true;
  const initial = call.arguments[0];
  if (!initial) return false;
  if (isSetOrMapConstruction(initial)) return true;
  if (ts.isArrowFunction(initial) || ts.isFunctionExpression(initial)) {
    if (ts.isBlock(initial.body)) {
      return initial.body.statements.some(
        statement => ts.isReturnStatement(statement) && !!statement.expression && isSetOrMapConstruction(statement.expression)
      );
    }
    return isSetOrMapConstruction(initial.body);
  }
  return false;
}

function isSetOrMapConstruction(node: ts.Expression): boolean {
  return (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    (node.expression.text === "Set" || node.expression.text === "Map")
  );
}

function isArrayState(call: ts.CallExpression): boolean {
  const type = call.typeArguments?.[0];
  if (
    type &&
    (ts.isArrayTypeNode(type) ||
      (ts.isTypeReferenceNode(type) &&
        ["Array", "ReadonlyArray"].includes(type.typeName.getText())))
  ) {
    return true;
  }
  const initial = call.arguments[0];
  return initial !== undefined && ts.isArrayLiteralExpression(unwrapTransparentExpression(initial));
}

function localSetAliasForArrayState(state: StateCandidate): ts.VariableDeclaration | null {
  if (!isArrayState(state.call) || !state.owner.body) return null;
  const matches: ts.VariableDeclaration[] = [];
  visitSkippingNestedRuntimeFunctions(state.owner.body, node => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      !node.initializer ||
      !ts.isVariableDeclarationList(node.parent) ||
      (node.parent.flags & ts.NodeFlags.Const) === 0
    ) {
      return;
    }
    const initializer = unwrapTransparentExpression(node.initializer);
    if (
      !ts.isNewExpression(initializer) ||
      !ts.isIdentifier(initializer.expression) ||
      initializer.expression.text !== "Set" ||
      initializer.arguments?.length !== 1
    ) {
      return;
    }
    const source = unwrapTransparentExpression(initializer.arguments[0]!);
    if (ts.isIdentifier(source) && source.text === state.valueName) matches.push(node);
  });
  const match = matches.length === 1 ? matches[0]! : null;
  return match && bindingDeclarationCount(state.owner, match.name.getText()) === 1 ? match : null;
}

function hasIndependentRepeatedEventWrite(
  state: StateCandidate,
  usage: StateUsage | undefined
): boolean {
  if (!state.setterName || !usage) return false;
  return usage.setterCallNodes.some(call => {
    const repeated = nearestRepeatedRenderCall(call, state.owner);
    const event = nearestNestedFunction(call, state.owner);
    if (
      !repeated ||
      !event ||
      event === repeated.arguments[0] ||
      (!ts.isArrowFunction(event) && !ts.isFunctionExpression(event))
    ) {
      return false;
    }
    const expression = event.parent;
    const attribute = ts.isJsxExpression(expression) ? expression.parent : null;
    return !!attribute &&
      ts.isJsxAttribute(attribute) &&
      /^on[A-Z]/.test(attribute.name.getText()) &&
      mutationRegionOnlyCallsStateSetters(event, new Set([state.setterName!]));
  });
}

function isKeyedLeafScalarState(
  state: StateCandidate,
  usage: StateUsage | undefined
): boolean {
  return !!usage &&
    hasDirectPrimitiveInitializer(state) &&
    !stateMayHoldCallable(state) &&
    jsxElementCount(state.owner) >= 12 &&
    usage.directRenderNodes.length > 0 &&
    usage.localRenderReads === usage.directRenderNodes.length &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.transportedOccurrences === 0 &&
    usage.setterCalls > 0 &&
    usage.setterReferences === usage.setterCalls &&
    usage.setterCallNodes.every(call =>
      call.arguments.length === 1 &&
      !!call.arguments[0] &&
      isPureExpression(call.arguments[0])
    ) &&
    (usage.deferredReads === 0 || hasOnlyEventCommandReads(state)) &&
    !usage.shadowed &&
    !usage.escaped &&
    usage.directRenderNodes.every(node => isRepeatedScalarKeyProjection(node, state));
}

function isKeyedScalarWithSecondaryLeaf(
  state: StateCandidate,
  usage: StateUsage | undefined
): boolean {
  if (
    !usage ||
    !hasSupportedKeyedSelectionInitializer(state) ||
    stateMayHoldCallable(state) ||
    jsxElementCount(state.owner) < 12 ||
    usage.directRenderNodes.length === 0 ||
    usage.localRenderReads !== usage.directRenderNodes.length ||
    usage.effectReads > 0 ||
    usage.effectWrites > 0 ||
    usage.transportedOccurrences > 0 ||
    usage.setterCalls === 0 ||
    usage.setterReferences !== usage.setterCalls ||
    usage.setterCallNodes.some(call =>
      call.arguments.length !== 1 ||
      !call.arguments[0] ||
      !isPureExpression(call.arguments[0])
    ) ||
    usage.shadowed ||
    usage.escaped ||
    !hasOnlyEventCommandReads(state, new Set(usage.directRenderNodes))
  ) {
    return false;
  }

  const producer = repeatedScalarSelectionProducer(state, usage);
  if (!producer) return false;

  const secondaryNodes: ts.Node[] = [];
  for (const node of usage.directRenderNodes) {
    if (isRepeatedScalarKeyProjection(node, state)) {
      if (nearestRepeatedRenderCall(node, state.owner) !== producer) return false;
      continue;
    }
    secondaryNodes.push(node);
  }
  const secondaryReferences = oneHopRenderProjectionReferences(
    state.owner,
    secondaryNodes,
    (initializer, reference) =>
      isPureExpression(initializer) ||
      (ts.isIdentifier(reference) && isSelectedItemLookup(initializer, reference))
  );
  if (!secondaryReferences) return false;

  const renderReferences: ts.Identifier[] = [];
  for (const reference of secondaryReferences) {
    const callback = nearestNestedFunction(reference, state.owner);
    if (callback) {
      if (
        (ts.isArrowFunction(callback) ||
          ts.isFunctionDeclaration(callback) ||
          ts.isFunctionExpression(callback)) &&
        callbackIsEventRooted(callback, state.owner, reference.text, new Set())
      ) {
        continue;
      }
      return false;
    }
    if (findAncestorUntil(reference, isJsxNode, state.owner)) {
      if (
        nearestRepeatedRenderCall(reference, state.owner) ||
        (isRenderGateReference(reference, state.owner) &&
          !findAncestorUntil(reference, ts.isJsxAttribute, state.owner)) ||
        !isSafeJsxProjectionReference(reference, state.owner, new Set(["cn"]))
      ) {
        return false;
      }
      renderReferences.push(reference);
      continue;
    }
    if (isHookDependencyReference(reference, new Set(["useCallback"]))) {
      const call = findAncestorUntil(reference, ts.isCallExpression, state.owner);
      const candidate = call?.arguments[0];
      if (
        candidate &&
        (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) &&
        callbackIsEventRooted(candidate, state.owner, reference.text, new Set())
      ) {
        continue;
      }
    }
    return false;
  }

  const consumer = lowestCommonJsxSubtree(renderReferences, state.owner);
  const producerReturn = findAncestorUntil(producer, ts.isReturnStatement, state.owner);
  const consumerReturn = consumer
    ? findAncestorUntil(consumer, ts.isReturnStatement, state.owner)
    : null;
  return !!consumer &&
    jsxElementCountIn(consumer) / jsxElementCount(state.owner) <= 0.4 &&
    producerReturn !== null &&
    producerReturn === consumerReturn &&
    !nodeWithin(producer, consumer) &&
    !nodeWithin(consumer, producer);
}

function hasSupportedKeyedSelectionInitializer(state: StateCandidate): boolean {
  if (hasDirectPrimitiveInitializer(state)) return true;
  if (state.call.arguments.length !== 0) return false;
  const type = state.call.typeArguments?.[0];
  return !!type && primitiveScalarType(type);
}

function primitiveScalarType(type: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(type) || ts.isTypeOperatorNode(type)) {
    return primitiveScalarType(type.type);
  }
  if (ts.isUnionTypeNode(type)) return type.types.every(primitiveScalarType);
  if (ts.isLiteralTypeNode(type)) return true;
  return [
    ts.SyntaxKind.StringKeyword,
    ts.SyntaxKind.NumberKeyword,
    ts.SyntaxKind.BooleanKeyword,
    ts.SyntaxKind.BigIntKeyword,
    ts.SyntaxKind.NullKeyword,
    ts.SyntaxKind.UndefinedKeyword,
  ].includes(type.kind);
}

function repeatedScalarSelectionProducer(
  state: StateCandidate,
  usage: StateUsage
): ts.CallExpression | null {
  if (!state.setterName) return null;
  const producers = new Set<ts.CallExpression>();
  for (const call of usage.setterCallNodes) {
    const repeated = nearestRepeatedRenderCall(call, state.owner);
    const callback = repeated?.arguments[0];
    const event = nearestNestedFunction(call, state.owner);
    const argument = call.arguments[0];
    if (
      !repeated ||
      !callback ||
      (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
      !event ||
      event === callback ||
      (!ts.isArrowFunction(event) && !ts.isFunctionExpression(event)) ||
      !argument ||
      !callback.parameters.some(parameter =>
        expressionDependsOnBinding(argument, parameter.name, callback)
      ) ||
      !repeatedRenderHasStableItemKey(callback) ||
      !isInsideJsxEventCallback(call, state.owner) ||
      !mutationRegionOnlyCallsStateSetters(event, new Set([state.setterName]))
    ) {
      continue;
    }
    producers.add(repeated);
  }
  return producers.size === 1 ? [...producers][0]! : null;
}

function isSelectedItemLookup(
  initializer: ts.Expression,
  stateReference: ts.Identifier
): boolean {
  let expression = unwrapTransparentExpression(initializer);
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
    unwrapTransparentExpression(expression.right).kind === ts.SyntaxKind.NullKeyword
  ) {
    expression = unwrapTransparentExpression(expression.left);
  }
  if (
    !ts.isCallExpression(expression) ||
    !ts.isPropertyAccessExpression(expression.expression) ||
    expression.expression.name.text !== "find" ||
    expression.arguments.length !== 1
  ) {
    return false;
  }
  const callback = expression.arguments[0];
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    ts.isBlock(callback.body) ||
    callback.parameters.length !== 1
  ) {
    return false;
  }
  const comparison = unwrapTransparentExpression(callback.body);
  if (
    !ts.isBinaryExpression(comparison) ||
    comparison.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
  ) {
    return false;
  }
  const left = unwrapTransparentExpression(comparison.left);
  const right = unwrapTransparentExpression(comparison.right);
  const other = left === stateReference
    ? right
    : right === stateReference
      ? left
      : null;
  if (
    !other ||
    !expressionDependsOnBinding(other, callback.parameters[0]!.name, callback)
  ) {
    return false;
  }
  let stateReads = 0;
  visit(initializer, node => {
    if (
      ts.isIdentifier(node) &&
      node.text === stateReference.text &&
      !isNonValueIdentifier(node)
    ) {
      stateReads += 1;
    }
  });
  return stateReads === 1;
}

function isRepeatedScalarKeyProjection(
  node: ts.Node,
  state: StateCandidate
): boolean {
  if (!ts.isIdentifier(node)) return false;
  const repeated = nearestRepeatedRenderCall(node, state.owner);
  const callback = repeated?.arguments[0];
  if (
    !repeated ||
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    nearestNestedFunction(node, state.owner) !== callback ||
    !repeatedRenderHasStableItemKey(callback) ||
    !scalarComparisonUsesRepeatedKey(node, callback)
  ) {
    return false;
  }

  const declaration = findAncestorUntil(node, ts.isVariableDeclaration, callback);
  if (
    declaration?.initializer &&
    ts.isIdentifier(declaration.name) &&
    nodeWithin(node, declaration.initializer)
  ) {
    if (
      !ts.isVariableDeclarationList(declaration.parent) ||
      (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
      bindingDeclarationCount(callback, declaration.name.text) !== 1
    ) {
      return false;
    }
    const references: ts.Identifier[] = [];
    visit(callback.body, reference => {
      if (
        ts.isIdentifier(reference) &&
        reference.text === declaration.name.getText() &&
        reference !== declaration.name &&
        !isDeclarationName(reference) &&
        !isNonValueIdentifier(reference)
      ) {
        references.push(reference);
      }
    });
    return references.length > 0 && references.every(reference =>
      nearestRepeatedRenderCall(reference, state.owner) === repeated &&
      !isMembershipMountGate(reference, callback) &&
      !!findAncestorUntil(reference, isJsxNode, callback) &&
      isSafeJsxProjectionReference(reference, callback, new Set(["cn"]))
    );
  }

  return !isMembershipMountGate(node, callback) &&
    !!findAncestorUntil(node, isJsxNode, callback) &&
    isSafeJsxProjectionReference(node, callback, new Set(["cn"]));
}

function scalarComparisonUsesRepeatedKey(
  node: ts.Identifier,
  callback: ts.ArrowFunction | ts.FunctionExpression
): boolean {
  for (let current: ts.Node | undefined = node.parent; current && current !== callback; current = current.parent) {
    if (
      !ts.isBinaryExpression(current) ||
      ![
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ].includes(current.operatorToken.kind)
    ) {
      continue;
    }
    const other = nodeWithin(node, current.left)
      ? current.right
      : nodeWithin(node, current.right)
        ? current.left
        : null;
    if (
      other &&
      callback.parameters.some(parameter =>
        expressionDependsOnBinding(other, parameter.name, callback)
      )
    ) {
      return true;
    }
  }
  return false;
}

function isKeyedLeafCollectionState(
  state: StateCandidate,
  usage: StateUsage | undefined
): boolean {
  if (
    !usage ||
    !isKeyedCollectionName(state.valueName) ||
    usage.effectReads > 0
  ) {
    return false;
  }

  const directCollection = isSetOrMapState(state.call);
  const arraySetAlias = directCollection ? null : localSetAliasForArrayState(state);
  if ((!directCollection && !arraySetAlias) || jsxElementCount(state.owner) < 12) return false;
  const aliasName = arraySetAlias?.name.getText() ?? null;

  let repeatedMembership = false;
  let unsafe = false;
  visit(state.owner.body, node => {
    if (
      unsafe ||
      !ts.isIdentifier(node) ||
      (node.text !== state.valueName && node.text !== aliasName)
    ) {
      return;
    }
    if (isDeclarationName(node) || isNonValueIdentifier(node)) return;
    if (arraySetAlias && node.text === state.valueName && nodeWithin(node, arraySetAlias.initializer!)) {
      return;
    }
    const property = ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
      ? node.parent
      : null;
    if (arraySetAlias && node.text === state.valueName) {
      if (property?.name.text === "length") {
        if (collectionSummaryControlsRepeatedRendering(property, state.owner)) unsafe = true;
        return;
      }
      if (isDeferredCollectionRead(node, state.owner)) return;
      if (isHookDependencyReference(node, MEMO_CALLBACK_HOOKS)) return;
      if (isListExtraDataReference(node, state.owner)) return;
      unsafe = true;
      return;
    }
    if (property && KEYED_COLLECTION_PROPERTIES.has(property.name.text)) {
      if (property.name.text === "size") {
        if (collectionSummaryControlsRepeatedRendering(property, state.owner)) unsafe = true;
        return;
      }
      if (["entries", "keys", "values"].includes(property.name.text)) return;
      if (
        property.name.text !== "has" ||
        !ts.isCallExpression(property.parent) ||
        property.parent.expression !== property ||
        !isRepeatedMembershipRender(property.parent, state.owner)
      ) {
        unsafe = true;
        return;
      }
      if (membershipControlsRepeatedMount(property.parent, state.owner)) unsafe = true;
      else repeatedMembership = true;
      return;
    }
    if (ts.isSpreadElement(node.parent)) return;
    if (isCollectionCopyArgument(node) && isDeferredCollectionRead(node, state.owner)) return;
    if (isHookDependencyReference(node, MEMO_CALLBACK_HOOKS)) return;
    if (isListExtraDataReference(node, state.owner)) return;
    unsafe = true;
  });
  return repeatedMembership && !unsafe;
}

function collectionSummaryControlsRepeatedRendering(
  summary: ts.PropertyAccessExpression,
  owner: RuntimeFunctionLike
): boolean {
  if (!owner.body) return true;
  if (nearestRepeatedRenderCall(summary, owner)) return true;
  const declaration = findAncestorUntil(summary, ts.isVariableDeclaration, owner);
  if (
    !declaration ||
    !ts.isIdentifier(declaration.name) ||
    !declaration.initializer ||
    !nodeWithin(summary, declaration.initializer)
  ) {
    return referenceControlsRepeatedRendering(summary, owner);
  }
  if (bindingDeclarationCount(owner, declaration.name.text) !== 1) return true;
  const references: ts.Identifier[] = [];
  visit(owner.body, node => {
    if (
      ts.isIdentifier(node) &&
      node.text === declaration.name.getText() &&
      node !== declaration.name &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return references.some(reference => referenceControlsRepeatedRendering(reference, owner));
}

function referenceControlsRepeatedRendering(node: ts.Node, owner: RuntimeFunctionLike): boolean {
  const repeated = nearestRepeatedRenderCall(node, owner);
  if (repeated) {
    const callback = repeated.arguments[0];
    if (
      callback &&
      (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
      summaryFeedsStableRowProjection(node, callback)
    ) {
      return false;
    }
    return true;
  }
  for (let current: ts.Node | undefined = node.parent; current && current !== owner; current = current.parent) {
    if (
      (ts.isBinaryExpression(current) &&
        nodeWithin(node, current.left) &&
        containsRepeatedRender(current.right)) ||
      (ts.isConditionalExpression(current) &&
        nodeWithin(node, current.condition) &&
        (containsRepeatedRender(current.whenTrue) ||
          containsRepeatedRender(current.whenFalse))) ||
      (ts.isIfStatement(current) &&
        nodeWithin(node, current.expression) &&
        (containsRepeatedRender(current.thenStatement) ||
          (!!current.elseStatement && containsRepeatedRender(current.elseStatement))))
    ) {
      return true;
    }
  }
  return false;
}

function summaryFeedsStableRowProjection(
  summaryReference: ts.Node,
  callback: ts.ArrowFunction | ts.FunctionExpression
): boolean {
  const declaration = findAncestorUntil(summaryReference, ts.isVariableDeclaration, callback);
  if (
    !declaration?.initializer ||
    !ts.isIdentifier(declaration.name) ||
    !nodeWithin(summaryReference, declaration.initializer) ||
    !isSafeProjectionExpression(declaration.initializer, summaryReference)
  ) {
    return false;
  }
  const projectionName = declaration.name.text;
  const references: ts.Identifier[] = [];
  visitSkippingNestedFunctions(callback.body, callback, node => {
    if (
      ts.isIdentifier(node) &&
      node.text === projectionName &&
      node !== declaration.name &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return references.length > 0 && references.every(reference =>
    !isMembershipMountGate(reference, callback) &&
    !!findAncestorUntil(reference, isJsxNode, callback) &&
    isSafeJsxProjectionReference(reference, callback, new Set(["cn"]))
  );
}

function containsRepeatedRender(root: ts.Node): boolean {
  let found = false;
  visitSkippingNestedRuntimeFunctions(root, node => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["map", "flatMap"].includes(node.expression.name.text)
    ) {
      found = true;
    }
  });
  return found;
}

function isDeferredCollectionRead(node: ts.Identifier, owner: RuntimeFunctionLike): boolean {
  const callback = nearestNestedFunction(node, owner);
  if (!callback || isSynchronousRenderCallback(callback) || renderedListCallback(node, owner)) return false;
  const attribute = findAncestorUntil(callback, ts.isJsxAttribute, owner);
  return !attribute || /^on[A-Z]/.test(attribute.name.getText());
}

function isRepeatedMembershipRender(call: ts.CallExpression, owner: RuntimeFunctionLike): boolean {
  const repeated = nearestRepeatedRenderCall(call, owner);
  const callback = repeated?.arguments[0] ?? renderedListCallback(call, owner);
  return !!callback &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
    membershipUsesCallbackKey(call, callback) &&
    (!repeated || repeatedRenderHasStableItemKey(callback));
}

function membershipUsesCallbackKey(
  call: ts.CallExpression,
  callback: ts.ArrowFunction | ts.FunctionExpression
): boolean {
  const argument = call.arguments[0];
  const parameter = callback.parameters[0]?.name;
  if (!argument || !parameter) return false;
  return expressionDependsOnBinding(argument, parameter, callback);
}





function renderedListCallback(
  node: ts.Node,
  owner: RuntimeFunctionLike
): ts.ArrowFunction | ts.FunctionExpression | null {
  const callback = nearestNestedFunction(node, owner);
  if (!callback) return null;
  const initializer = callback.parent;
  const declaration = ts.isCallExpression(initializer) &&
      ts.isIdentifier(initializer.expression) &&
      initializer.expression.text === "useCallback"
    ? initializer.parent
    : callback.parent;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return null;
  const bindingName = declaration.name.text;
  let rendered = false;
  visit(owner.body, current => {
    if (
      ts.isIdentifier(current) &&
      current.text === bindingName &&
      isListRenderAttributeReference(current)
    ) {
      rendered = true;
    }
  });
  return rendered ? callback as ts.ArrowFunction | ts.FunctionExpression : null;
}

function isListRenderAttributeReference(node: ts.Identifier): boolean {
  const expression = node.parent;
  if (!ts.isJsxExpression(expression) || expression.expression !== node) return false;
  const attribute = expression.parent;
  return ts.isJsxAttribute(attribute) && attribute.name.getText() === "renderItem";
}

function isListExtraDataReference(node: ts.Identifier, owner: RuntimeFunctionLike): boolean {
  const expression = node.parent;
  if (!ts.isJsxExpression(expression) || expression.expression !== node) return false;
  const attribute = expression.parent;
  return ts.isJsxAttribute(attribute) &&
    attribute.name.getText() === "extraData" &&
    isInsideOwner(attribute, owner);
}

function isInsideOwner(node: ts.Node, owner: RuntimeFunctionLike): boolean {
  return node.getStart() >= owner.getStart() && node.end <= owner.end;
}

function isKeyedCollectionName(name: string): boolean {
  return /(?:selected|selection|added|checked|chosen|open|expanded|requested)/i.test(name) &&
    !/(?:mounted|failed|loaded|requestedAt)/i.test(name);
}

function isCollectionCopyArgument(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (
    ts.isCallExpression(parent) &&
    parent.arguments.includes(node) &&
    ts.isPropertyAccessExpression(parent.expression) &&
    ts.isIdentifier(parent.expression.expression) &&
    parent.expression.expression.text === "Array" &&
    parent.expression.name.text === "from"
  ) {
    return true;
  }
  return (
    ts.isNewExpression(parent) &&
    parent.arguments?.includes(node) === true &&
    ts.isIdentifier(parent.expression) &&
    (parent.expression.text === "Set" || parent.expression.text === "Map")
  );
}


function membershipControlsRepeatedMount(call: ts.CallExpression, owner: RuntimeFunctionLike): boolean {
  const repeated = nearestRepeatedRenderCall(call, owner);
  const callback = repeated?.arguments[0] ?? renderedListCallback(call, owner);
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return true;
  const declaration = findAncestorUntil(call, ts.isVariableDeclaration, callback);
  if (
    declaration &&
    ts.isIdentifier(declaration.name) &&
    declaration.initializer &&
    nodeWithin(call, declaration.initializer)
  ) {
    const aliasName = declaration.name.text;
    const references: ts.Identifier[] = [];
    visitSkippingNestedFunctions(callback.body, callback, node => {
      if (
        ts.isIdentifier(node) &&
        node.text === aliasName &&
        node !== declaration.name &&
        !isNonValueIdentifier(node)
      ) {
        references.push(node);
      }
    });
    return references.length > 0 && references.every(reference => isMembershipMountGate(reference, callback));
  }
  return isMembershipMountGate(call, callback);
}

function isMembershipMountGate(node: ts.Node, callback: RuntimeFunctionLike): boolean {
  for (let current: ts.Node | undefined = node.parent; current && current !== callback; current = current.parent) {
    if (
      (ts.isIfStatement(current) &&
        nodeWithin(node, current.expression) &&
        statementContainsReturn(current.thenStatement)) ||
      (ts.isConditionalExpression(current) &&
        nodeWithin(node, current.condition) &&
        !findAncestorUntil(current, ts.isJsxAttribute, callback) &&
        (expressionIsNullish(current.whenTrue) || expressionIsNullish(current.whenFalse))) ||
      (ts.isBinaryExpression(current) &&
        (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          current.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
        nodeWithin(node, current.left) &&
        expressionContainsJsx(current.right))
    ) {
      return true;
    }
  }
  return false;
}

function statementContainsReturn(statement: ts.Statement): boolean {
  let found = false;
  visitSkippingNestedRuntimeFunctions(statement, node => {
    if (ts.isReturnStatement(node)) found = true;
  });
  return found;
}

function expressionIsNullish(expression: ts.Expression): boolean {
  return expression.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(expression) && expression.text === "undefined");
}

export function isSelectionStateName(name: string): boolean {
  return /(?:selected|selection|added|checked)/i.test(name);
}

export function setterCallUsesPreviousValue(call: ts.CallExpression): boolean {
  const argument = call.arguments[0];
  if (!argument || (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument))) return false;
  const parameter = argument.parameters[0];
  if (!parameter || !ts.isIdentifier(parameter.name)) return false;
  const parameterName = parameter.name.text;
  let referenced = false;
  visit(argument.body, node => {
    if (ts.isIdentifier(node) && node.text === parameterName && node !== parameter.name) referenced = true;
  });
  return referenced;
}
