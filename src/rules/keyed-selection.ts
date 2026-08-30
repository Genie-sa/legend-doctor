import ts from "typescript";

import {
  bindingDeclarationCount,
  callRootIdentifier,
  hookCallName,
  isControlledInteractionProp,
  isDeclarationName,
  isDirectJsxAttributeExpression,
  isNonValueIdentifier,
  isPureExpression,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import {
  findAncestorUntil,
  nearestNestedFunction,
  nodeWithin,
  visit,
  visitSkippingNestedFunctions,
  visitSkippingNestedRuntimeFunctions,
} from "../ast.js";
import type { StateCandidate, StateUsage } from "../analyze-source.js";
import { isImportedHookCall } from "../imports.js";
import {
  commonRenderGateSubtree,
  expressionContainsJsx,
  isRenderGateReference,
  isSafeProjectionExpression,
} from "./deferred-reveal.js";
import { mutationRegionOnlyCallsStateSetters } from "./effect-drafts.js";
import type { ChildContractResolver } from "./child-contract.js";
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
  uniqueVariableDeclaration,
} from "./state-proofs.js";
import type { RuntimeFunctionLike } from "../ast.js";
import type { HookImports } from "../imports.js";

const KEYED_COLLECTION_PROPERTIES = new Set(["entries", "has", "keys", "size", "values"]),
  MEMO_CALLBACK_HOOKS = new Set(["useCallback", "useMemo"]);

export interface KeyedSelectionAnalysis {
  collectionStates: ReadonlySet<StateCandidate>;
  recordStates: ReadonlySet<StateCandidate>;
  scalarStates: ReadonlySet<StateCandidate>;
  secondaryLeafStates: ReadonlySet<StateCandidate>;
}

export function analyzeKeyedSelections(
  states: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
  safeCommandStates: ReadonlySet<StateCandidate>,
  statesWithCompanionWrites: ReadonlySet<StateCandidate>,
  imports: HookImports,
  childContracts: ChildContractResolver | null,
): KeyedSelectionAnalysis {
  const settersByOwner = new Map<RuntimeFunctionLike, Set<string>>();
  for (const state of states) {
    if (!state.setterName) {
      continue;
    }
    const setters = settersByOwner.get(state.owner) ?? new Set<string>();
    setters.add(state.setterName);
    settersByOwner.set(state.owner, setters);
  }
  const collectionStates = new Set(
      states.filter(
        (state) =>
          safeCommandStates.has(state) &&
          ((hasIndependentCollectionEventWrite(
            state,
            usageByState.get(state),
            settersByOwner.get(state.owner) ?? new Set(),
          ) &&
            isKeyedLeafCollectionState(state, usageByState.get(state))) ||
            (!statesWithCompanionWrites.has(state) &&
              isImperativeRenderedCollectionState(state, usageByState.get(state), imports))),
      ),
    ),
    scalarStates = new Set(
      states.filter((state) => {
        const usage = usageByState.get(state);
        return (
          safeCommandStates.has(state) &&
          (!statesWithCompanionWrites.has(state) ||
            hasIndependentRepeatedEventWrite(state, usage)) &&
          isKeyedLeafScalarState(state, usage)
        );
      }),
    ),
    secondaryLeafStates = new Set(
      states.filter((state) => {
        const usage = usageByState.get(state);
        return (
          safeCommandStates.has(state) &&
          (!statesWithCompanionWrites.has(state) ||
            hasIndependentRepeatedEventWrite(state, usage)) &&
          isKeyedScalarWithSecondaryLeaf(state, usage)
        );
      }),
    ),
    recordStates = new Set(
      states.filter(
        (state) =>
          !statesWithCompanionWrites.has(state) &&
          isKeyedLeafRecordState(state, usageByState.get(state), childContracts),
      ),
    );
  return { collectionStates, recordStates, scalarStates, secondaryLeafStates };
}

function hasIndependentCollectionEventWrite(
  state: StateCandidate,
  usage: StateUsage | undefined,
  ownerSetters: ReadonlySet<string>,
): boolean {
  if (!state.setterName || !usage) {
    return false;
  }
  return usage.setterCallNodes.some((call) => {
    const region = nearestNestedFunction(call, state.owner);
    if (
      !region ||
      (!ts.isArrowFunction(region) &&
        !ts.isFunctionDeclaration(region) &&
        !ts.isFunctionExpression(region)) ||
      !region.body ||
      !callbackIsEventRooted(region, state.owner, "", new Set())
    ) {
      return false;
    }
    if (
      (ts.isArrowFunction(region) || ts.isFunctionExpression(region)) &&
      ts.isCallExpression(region.parent) &&
      region.parent.arguments.includes(region) &&
      hookCallName(region.parent) !== "useCallback"
    ) {
      return false;
    }

    let safe = true;
    visitSkippingNestedFunctions(region.body, region, (node) => {
      if (!safe || !ts.isCallExpression(node)) {
        return;
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === state.setterName) {
        safe = !setterArgumentCallsOwnerCommand(node, state, ownerSetters);
        return;
      }
      const root = callRootIdentifier(node.expression);
      if (root && (ownerSetters.has(root) || bindingDeclarationCount(state.owner, root) > 0)) {
        safe = false;
      }
    });
    return safe;
  });
}

function setterArgumentCallsOwnerCommand(
  setterCall: ts.CallExpression,
  state: StateCandidate,
  ownerSetters: ReadonlySet<string>,
): boolean {
  let found = false;
  const findOwnerCommand = (node: ts.Node): void => {
    if (
      found ||
      !ts.isCallExpression(node) ||
      !ts.isIdentifier(node.expression) ||
      node.expression.text === state.setterName
    ) {
      return;
    }
    if (
      ownerSetters.has(node.expression.text) ||
      bindingDeclarationCount(state.owner, node.expression.text) > 0
    ) {
      found = true;
    }
  };
  for (const argument of setterCall.arguments) {
    visit(argument, findOwnerCommand);
  }
  return found;
}

export function isSetOrMapState(call: ts.CallExpression): boolean {
  const type = call.typeArguments?.[0];
  if (type && /^(?:Readonly)?(?:Set|Map)</u.test(type.getText())) {
    return true;
  }
  const initial = call.arguments[0];
  if (!initial) {
    return false;
  }
  if (isSetOrMapConstruction(initial)) {
    return true;
  }
  if (ts.isArrowFunction(initial) || ts.isFunctionExpression(initial)) {
    if (ts.isBlock(initial.body)) {
      return initial.body.statements.some(
        (statement) =>
          ts.isReturnStatement(statement) &&
          statement.expression !== undefined &&
          isSetOrMapConstruction(statement.expression),
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

function isImperativeRenderedCollectionState(
  state: StateCandidate,
  usage: StateUsage | undefined,
  imports: HookImports,
): boolean {
  if (
    !usage ||
    !state.setterName ||
    !state.owner.body ||
    (!isSetOrMapState(state.call) && !isNullableSetState(state.call)) ||
    usage.localRenderReads === 0 ||
    usage.localRenderReads !== usage.directRenderNodes.length ||
    usage.effectReads > 0 ||
    usage.effectWrites > 0 ||
    usage.transportedOccurrences > 0 ||
    usage.setterCalls === 0 ||
    usage.setterReferences !== usage.setterCalls ||
    usage.setterUsesPreviousValue ||
    usage.shadowed ||
    usage.escaped
  ) {
    return false;
  }

  const commandCallbacks = new Set<ts.ArrowFunction | ts.FunctionExpression>();
  let renderedMembership = false,
    safe = true;
  visit(state.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== state.valueName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node) ||
      node.parent === state.call.parent
    ) {
      return;
    }
    const dependencyCallback = useCallbackDependencyOwner(node, state.owner, imports);
    if (dependencyCallback) {
      commandCallbacks.add(dependencyCallback);
      return;
    }
    const property =
        ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
          ? node.parent
          : null,
      membership =
        property?.name.text === "has" &&
        ts.isCallExpression(property.parent) &&
        property.parent.expression === property
          ? property.parent
          : null;
    if (membership) {
      if (!isStableRenderedMembership(membership, state.owner)) {
        safe = false;
        return;
      }
      renderedMembership = true;
      return;
    }
    const callback = imperativeCommandCallback(node, state.owner, imports);
    if (!callback) {
      safe = false;
      return;
    }
    commandCallbacks.add(callback);
  });
  for (const call of usage.setterCallNodes) {
    const callback = imperativeCommandCallback(call, state.owner, imports);
    if (!callback) {
      return false;
    }
    commandCallbacks.add(callback);
  }
  if (!safe || !renderedMembership || commandCallbacks.size !== 1) {
    return false;
  }
  const callback = [...commandCallbacks][0]!;
  return (
    callbackReadsStateWithDependency(callback, state) &&
    callbackIsExposedOnlyByImperativeHandle(callback, state.owner, imports)
  );
}

function useCallbackDependencyOwner(
  node: ts.Identifier,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const call = findAncestorUntil(node, ts.isCallExpression, owner),
    callback = call?.arguments[0];
  return call &&
    call.arguments[1] &&
    nodeWithin(node, call.arguments[1]) &&
    isUnshadowedReactHookCall(call, owner, imports, "useCallback") &&
    callback &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
    ? callback
    : null;
}

function isNullableSetState(call: ts.CallExpression): boolean {
  const initial = call.arguments[0],
    type = call.typeArguments?.[0];
  if (
    !initial ||
    initial.kind !== ts.SyntaxKind.NullKeyword ||
    !type ||
    !ts.isUnionTypeNode(type)
  ) {
    return false;
  }
  const values = type.types.filter((member) => member.kind !== ts.SyntaxKind.NullKeyword);
  return (
    values.length === 1 &&
    ts.isTypeReferenceNode(values[0]!) &&
    values[0]!.typeName.getText() === "Set"
  );
}

function imperativeCommandCallback(
  node: ts.Node,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): ts.ArrowFunction | ts.FunctionExpression | null {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (!ts.isArrowFunction(current) && !ts.isFunctionExpression(current)) {
      continue;
    }
    const call: ts.Node = current.parent;
    if (
      ts.isCallExpression(call) &&
      call.arguments[0] === current &&
      isUnshadowedReactHookCall(call, owner, imports, "useCallback") &&
      ts.isVariableDeclaration(call.parent) &&
      ts.isIdentifier(call.parent.name)
    ) {
      return current;
    }
  }
  return null;
}

function callbackReadsStateWithDependency(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  state: StateCandidate,
): boolean {
  const call = callback.parent,
    dependencies = ts.isCallExpression(call) ? call.arguments[1] : undefined;
  if (!dependencies || !ts.isArrayLiteralExpression(dependencies)) {
    return false;
  }
  let readsState = false;
  visit(callback.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === state.valueName &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      readsState = true;
    }
  });
  return (
    !readsState ||
    dependencies.elements.some(
      (element) => ts.isIdentifier(element) && element.text === state.valueName,
    )
  );
}

function callbackIsExposedOnlyByImperativeHandle(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): boolean {
  const hookCall = callback.parent,
    declaration =
      ts.isCallExpression(hookCall) && ts.isVariableDeclaration(hookCall.parent)
        ? hookCall.parent
        : null;
  if (!declaration || !ts.isIdentifier(declaration.name)) {
    return false;
  }
  const name = declaration.name.text;
  if (bindingDeclarationCount(owner, name) !== 1) {
    return false;
  }

  let exposed = false,
    safe = true;
  visit(owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      node === declaration.name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const imperativeCall = findAncestorUntil(node, ts.isCallExpression, owner);
    if (
      !imperativeCall ||
      !isUnshadowedReactHookCall(imperativeCall, owner, imports, "useImperativeHandle")
    ) {
      safe = false;
      return;
    }
    if (imperativeCall.arguments[1] && nodeWithin(node, imperativeCall.arguments[1])) {
      exposed = imperativeFactoryReturnsBinding(imperativeCall.arguments[1]!, node);
      if (!exposed) {
        safe = false;
      }
      return;
    }
    if (imperativeCall.arguments[2] && nodeWithin(node, imperativeCall.arguments[2])) {
      return;
    }
    safe = false;
  });
  return safe && exposed;
}

function isUnshadowedReactHookCall(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
  imports: HookImports,
  hook: "useCallback" | "useImperativeHandle",
): boolean {
  const names = hook === "useCallback" ? imports.useCallback : imports.useImperativeHandle;
  if (!isImportedHookCall(call, names, imports.reactNamespaces, hook)) {
    return false;
  }
  const root = ts.isIdentifier(call.expression)
    ? call.expression
    : ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression)
      ? call.expression.expression
      : null;
  return root !== null && bindingDeclarationCount(owner, root.text) === 0;
}

function imperativeFactoryReturnsBinding(
  factory: ts.Expression,
  reference: ts.Identifier,
): boolean {
  const value = unwrapTransparentExpression(factory),
    object =
      (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) && !ts.isBlock(value.body)
        ? unwrapTransparentExpression(value.body)
        : null;
  return (
    object !== null &&
    ts.isObjectLiteralExpression(object) &&
    object.properties.some(
      (property) =>
        (ts.isShorthandPropertyAssignment(property) && property.name === reference) ||
        (ts.isPropertyAssignment(property) &&
          unwrapTransparentExpression(property.initializer) === reference),
    )
  );
}

function isStableRenderedMembership(
  membership: ts.CallExpression,
  owner: RuntimeFunctionLike,
): boolean {
  const callback = renderedListCallback(membership, owner);
  if (
    !callback ||
    !membershipUsesCallbackKey(membership, callback) ||
    membershipControlsRepeatedMount(membership, owner)
  ) {
    return false;
  }
  const declaration = callback.parent,
    callbackName =
      ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)
        ? declaration.name.text
        : ts.isCallExpression(declaration) &&
            ts.isVariableDeclaration(declaration.parent) &&
            ts.isIdentifier(declaration.parent.name)
          ? declaration.parent.name.text
          : null;
  if (!callbackName) {
    return false;
  }

  const openings = new Set<ts.JsxOpeningLikeElement>();
  let callbackConfined = true;
  visit(owner.body, (node) => {
    if (
      !callbackConfined ||
      !ts.isIdentifier(node) ||
      node.text !== callbackName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const expression = node.parent,
      attribute = ts.isJsxExpression(expression) ? expression.parent : null;
    if (
      attribute &&
      ts.isJsxAttribute(attribute) &&
      attribute.name.getText() === "renderItem" &&
      ts.isJsxExpression(expression) &&
      expression.expression === node &&
      ts.isJsxAttributes(attribute.parent)
    ) {
      openings.add(attribute.parent.parent);
      return;
    }
    callbackConfined = false;
  });
  if (!callbackConfined || openings.size !== 1) {
    return false;
  }
  const opening = [...openings][0]!,
    keyExtractor = opening.attributes.properties.find(
      (property) => ts.isJsxAttribute(property) && property.name.getText() === "keyExtractor",
    );
  if (!keyExtractor || !ts.isJsxAttribute(keyExtractor)) {
    return false;
  }
  const { initializer } = keyExtractor;
  const expression = initializer && ts.isJsxExpression(initializer) ? initializer.expression : null;
  if (!expression) {
    return false;
  }
  const extractor = unwrapTransparentExpression(expression);
  if (
    (!ts.isArrowFunction(extractor) && !ts.isFunctionExpression(extractor)) ||
    extractor.parameters.length === 0 ||
    !ts.isIdentifier(extractor.parameters[0]!.name)
  ) {
    return false;
  }
  if (ts.isBlock(extractor.body)) {
    return false;
  }
  let root = unwrapTransparentExpression(extractor.body),
    propertyDepth = 0;
  while (ts.isPropertyAccessExpression(root)) {
    propertyDepth += 1;
    root = unwrapTransparentExpression(root.expression);
  }
  return (
    propertyDepth > 0 && ts.isIdentifier(root) && root.text === extractor.parameters[0]!.name.text
  );
}

interface ArraySetAlias {
  declaration: ts.VariableDeclaration;
  stateSource: ts.Identifier;
}

function localSetAliasForArrayState(state: StateCandidate): ArraySetAlias | null {
  if (
    !isArrayState(state.call) ||
    !state.owner.body ||
    bindingDeclarationCount(state.owner, "Set") !== 0
  ) {
    return null;
  }
  const matches: ArraySetAlias[] = [];
  visitSkippingNestedRuntimeFunctions(state.owner.body, (node) => {
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
    if (ts.isIdentifier(source) && source.text === state.valueName) {
      matches.push({ declaration: node, stateSource: source });
      return;
    }
    if (!ts.isIdentifier(source)) {
      return;
    }
    const filtered = filteredSelectionDeclaration(state, source.text);
    if (filtered && filteredSelectionHasOneControlledLeaf(state, filtered, node)) {
      matches.push({ declaration: node, stateSource: filtered.stateSource });
    }
  });
  const match = matches.length === 1 ? matches[0]! : null;
  return match && bindingDeclarationCount(state.owner, match.declaration.name.getText()) === 1
    ? match
    : null;
}

interface FilteredSelectionDeclaration {
  declaration: ts.VariableDeclaration;
  stateSource: ts.Identifier;
}

function filteredSelectionDeclaration(
  state: StateCandidate,
  name: string,
): FilteredSelectionDeclaration | null {
  if (!state.owner.body) {
    return null;
  }
  const declaration = uniqueVariableDeclaration(state.owner.body, name);
  if (
    !declaration?.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(state.owner, name) !== 1
  ) {
    return null;
  }
  const filter = unwrapTransparentExpression(declaration.initializer);
  if (
    !ts.isCallExpression(filter) ||
    filter.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(filter.expression) ||
    filter.expression.name.text !== "filter"
  ) {
    return null;
  }
  const stateSource = unwrapTransparentExpression(filter.expression.expression),
    callback = filter.arguments[0];
  if (
    !callback ||
    !ts.isIdentifier(stateSource) ||
    stateSource.text !== state.valueName ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    callback.parameters.length !== 1 ||
    !ts.isIdentifier(callback.parameters[0]!.name) ||
    ts.isBlock(callback.body)
  ) {
    return null;
  }
  const membership = unwrapTransparentExpression(callback.body);
  if (
    !ts.isCallExpression(membership) ||
    membership.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(membership.expression) ||
    membership.expression.name.text !== "has"
  ) {
    return null;
  }
  const membershipSource = unwrapTransparentExpression(membership.expression.expression);
  return ts.isIdentifier(membershipSource) &&
    membershipSource.text !== state.valueName &&
    isReadOnlyMembershipSource(state.owner, membershipSource.text) &&
    expressionDependsOnBinding(membership.arguments[0]!, callback.parameters[0]!.name, callback)
    ? { declaration, stateSource }
    : null;
}

function isReadOnlyMembershipSource(owner: RuntimeFunctionLike, name: string): boolean {
  if (!owner.body || bindingDeclarationCount(owner, name) !== 1) {
    return false;
  }
  const declaration = uniqueVariableDeclaration(owner.body, name),
    initializer = declaration?.initializer && unwrapTransparentExpression(declaration.initializer);
  if (
    !declaration ||
    !initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    !ts.isNewExpression(initializer) ||
    !ts.isIdentifier(initializer.expression) ||
    initializer.expression.text !== "Set" ||
    initializer.arguments?.length !== 1
  ) {
    return false;
  }
  let reads = 0,
    safe = true;
  visit(owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const property =
      ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
        ? node.parent
        : null;
    if (
      property?.name.text === "has" &&
      ts.isCallExpression(property.parent) &&
      property.parent.expression === property
    ) {
      reads += 1;
      return;
    }
    safe = false;
  });
  return safe && reads > 0;
}

function filteredSelectionHasOneControlledLeaf(
  state: StateCandidate,
  filtered: FilteredSelectionDeclaration,
  setDeclaration: ts.VariableDeclaration,
): boolean {
  if (!state.setterName || !ts.isIdentifier(filtered.declaration.name)) {
    return false;
  }
  const references: ts.Identifier[] = [];
  visit(state.owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === filtered.declaration.name.getText() &&
      node !== filtered.declaration.name &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  const setReference = references.find(
      (reference) =>
        setDeclaration.initializer !== undefined &&
        nodeWithin(reference, setDeclaration.initializer),
    ),
    leafReferences = references.filter((reference) => reference !== setReference);
  if (!setReference || leafReferences.length !== 1) {
    return false;
  }

  const leafReference = leafReferences[0]!,
    attribute = findAncestorUntil(leafReference, ts.isJsxAttribute, state.owner);
  if (
    !attribute ||
    attribute.name.getText() === "key" ||
    !isDirectJsxAttributeExpression(attribute, leafReference)
  ) {
    return false;
  }
  const opening = attribute.parent.parent;
  if (
    (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) ||
    !/^[A-Z]/u.test(opening.tagName.getText()) ||
    nearestRepeatedRenderCall(opening, state.owner)
  ) {
    return false;
  }
  return opening.attributes.properties.some((property) => {
    if (
      !ts.isJsxAttribute(property) ||
      !isControlledInteractionProp(property.name.getText()) ||
      !property.initializer ||
      !ts.isJsxExpression(property.initializer) ||
      !property.initializer.expression
    ) {
      return false;
    }
    const expression = unwrapTransparentExpression(property.initializer.expression);
    return ts.isIdentifier(expression) && expression.text === state.setterName;
  });
}

function hasIndependentRepeatedEventWrite(
  state: StateCandidate,
  usage: StateUsage | undefined,
): boolean {
  if (!state.setterName || !usage) {
    return false;
  }
  return usage.setterCallNodes.some((call) => {
    const repeated = nearestRepeatedRenderCall(call, state.owner),
      event = nearestNestedFunction(call, state.owner);
    if (
      !repeated ||
      !event ||
      event === repeated.arguments[0] ||
      (!ts.isArrowFunction(event) && !ts.isFunctionExpression(event))
    ) {
      return false;
    }
    const expression = event.parent,
      attribute = ts.isJsxExpression(expression) ? expression.parent : null;
    return (
      attribute !== null &&
      ts.isJsxAttribute(attribute) &&
      /^on[A-Z]/u.test(attribute.name.getText()) &&
      mutationRegionOnlyCallsStateSetters(event, new Set([state.setterName!]))
    );
  });
}

interface KeyedRecordEntry {
  path: readonly string[];
  repeated: ts.CallExpression;
}

function isKeyedLeafRecordState(
  state: StateCandidate,
  usage: StateUsage | undefined,
  childContracts: ChildContractResolver | null,
): boolean {
  if (
    !usage ||
    !state.setterName ||
    !state.owner.body ||
    !isEmptyPrimitiveRecordState(state) ||
    jsxElementCount(state.owner) < 12 ||
    usage.directRenderNodes.length === 0 ||
    usage.localRenderReads !== usage.directRenderNodes.length ||
    usage.effectReads > 0 ||
    usage.effectWrites > 0 ||
    usage.deferredReads > 0 ||
    usage.transportedOccurrences > 0 ||
    usage.setterCalls === 0 ||
    usage.setterReferences !== usage.setterCalls ||
    usage.shadowed ||
    usage.escaped
  ) {
    return false;
  }

  const rendered = renderedRecordEntry(state, usage.directRenderNodes);
  if (!rendered) {
    return false;
  }
  return usage.setterCallNodes.every((call) => {
    const key = exactRecordEntryUpdaterKey(call),
      written = key && writtenRecordEntry(state, call, key, childContracts);
    return (
      written !== null &&
      written.repeated === rendered.repeated &&
      accessPathsEqual(written.path, rendered.path)
    );
  });
}

function isEmptyPrimitiveRecordState(state: StateCandidate): boolean {
  const initial = state.call.arguments[0],
    initialValue = initial && unwrapTransparentExpression(initial),
    type = state.call.typeArguments?.[0];
  if (
    !initialValue ||
    !ts.isObjectLiteralExpression(initialValue) ||
    initialValue.properties.length > 0 ||
    !type ||
    !ts.isTypeReferenceNode(type) ||
    !ts.isIdentifier(type.typeName) ||
    type.typeName.text !== "Record" ||
    type.typeArguments?.length !== 2 ||
    sourceDeclaresTypeName(state.call.getSourceFile(), "Record") ||
    !recordKeyTypeIsSupported(type.typeArguments[0]!) ||
    !primitiveRecordValueType(type.typeArguments[1]!, state.call.getSourceFile(), new Set())
  ) {
    return false;
  }
  return !stateMayHoldCallable(state);
}

function sourceDeclaresTypeName(sourceFile: ts.SourceFile, name: string): boolean {
  let declared = false;
  visit(sourceFile, (node) => {
    if (declared) {
      return;
    }
    if (
      ((ts.isTypeAliasDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
        node.name?.text === name) ||
      (ts.isTypeParameterDeclaration(node) && node.name.text === name) ||
      (ts.isImportSpecifier(node) && node.name.text === name) ||
      (ts.isImportClause(node) && node.name?.text === name) ||
      (ts.isNamespaceImport(node) && node.name.text === name)
    ) {
      declared = true;
    }
  });
  return declared;
}

function recordKeyTypeIsSupported(type: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(type) || ts.isTypeOperatorNode(type)) {
    return recordKeyTypeIsSupported(type.type);
  }
  if (ts.isUnionTypeNode(type)) {
    return type.types.every(recordKeyTypeIsSupported);
  }
  if (ts.isLiteralTypeNode(type)) {
    return ts.isStringLiteralLike(type.literal) || ts.isNumericLiteral(type.literal);
  }
  return type.kind === ts.SyntaxKind.StringKeyword || type.kind === ts.SyntaxKind.NumberKeyword;
}

function primitiveRecordValueType(
  type: ts.TypeNode,
  sourceFile: ts.SourceFile,
  seen: ReadonlySet<string>,
): boolean {
  if (primitiveScalarType(type)) {
    return true;
  }
  if (
    !ts.isTypeReferenceNode(type) ||
    !ts.isIdentifier(type.typeName) ||
    type.typeArguments?.length
  ) {
    return false;
  }
  const name = type.typeName.text;
  if (seen.has(name)) {
    return false;
  }
  const aliases: ts.TypeAliasDeclaration[] = [];
  visit(sourceFile, (node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === name) {
      aliases.push(node);
    }
  });
  const alias = aliases.length === 1 ? aliases[0]! : null;
  return (
    alias !== null &&
    !alias.typeParameters?.length &&
    primitiveRecordValueType(alias.type, sourceFile, new Set(seen).add(name))
  );
}

function renderedRecordEntry(
  state: StateCandidate,
  nodes: readonly ts.Node[],
): KeyedRecordEntry | null {
  let result: KeyedRecordEntry | null = null;
  for (const node of nodes) {
    if (!ts.isIdentifier(node)) {
      return null;
    }
    const access = node.parent;
    if (
      !ts.isElementAccessExpression(access) ||
      access.expression !== node ||
      !access.argumentExpression
    ) {
      return null;
    }
    const repeated = nearestRepeatedRenderCall(access, state.owner),
      callback = repeated?.arguments[0];
    if (
      !repeated ||
      !callback ||
      (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
      nearestNestedFunction(node, state.owner) !== callback ||
      !callback.parameters[0] ||
      !ts.isIdentifier(callback.parameters[0]!.name)
    ) {
      return null;
    }
    const path = accessPathFromBinding(
      access.argumentExpression,
      callback.parameters[0]!.name.text,
    );
    if (
      !path ||
      path.length === 0 ||
      !hasMatchingKeyedAncestor(access, callback, path) ||
      isMembershipMountGate(access, callback) ||
      !isSafeJsxProjectionReference(node, callback, new Set(["cn"]))
    ) {
      return null;
    }
    if (result && (result.repeated !== repeated || !accessPathsEqual(result.path, path))) {
      return null;
    }
    result = { path, repeated };
  }
  return result;
}

function hasMatchingKeyedAncestor(
  node: ts.Node,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  path: readonly string[],
): boolean {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== callback;
    current = current.parent
  ) {
    const opening = ts.isJsxElement(current)
      ? current.openingElement
      : ts.isJsxSelfClosingElement(current)
        ? current
        : null;
    if (!opening) {
      continue;
    }
    const key = opening.attributes.properties.find(
        (property) => ts.isJsxAttribute(property) && property.name.getText() === "key",
      ),
      initializer = key && ts.isJsxAttribute(key) ? key.initializer : null,
      expression = initializer && ts.isJsxExpression(initializer) ? initializer.expression : null,
      item = callback.parameters[0]?.name;
    if (
      expression &&
      item &&
      ts.isIdentifier(item) &&
      accessPathsEqual(accessPathFromBinding(expression, item.text), path)
    ) {
      return true;
    }
  }
  return false;
}

function exactRecordEntryUpdaterKey(call: ts.CallExpression): ts.Expression | null {
  if (call.arguments.length !== 1) {
    return null;
  }
  const updater = unwrapTransparentExpression(call.arguments[0]!);
  if (
    (!ts.isArrowFunction(updater) && !ts.isFunctionExpression(updater)) ||
    updater.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    updater.parameters.length !== 1 ||
    !ts.isIdentifier(updater.parameters[0]!.name)
  ) {
    return null;
  }
  const previous = updater.parameters[0]!.name.text;
  if (!ts.isBlock(updater.body)) {
    const object = unwrapTransparentExpression(updater.body);
    if (!ts.isObjectLiteralExpression(object) || object.properties.length !== 2) {
      return null;
    }
    const spread = object.properties[0],
      entry = object.properties[1];
    if (
      !spread ||
      !ts.isSpreadAssignment(spread) ||
      !isIdentifierNamed(unwrapTransparentExpression(spread.expression), previous) ||
      !entry ||
      !ts.isPropertyAssignment(entry) ||
      !ts.isComputedPropertyName(entry.name) ||
      !isPureExpression(entry.name.expression) ||
      !isPureExpression(entry.initializer)
    ) {
      return null;
    }
    return entry.name.expression;
  }

  if (updater.body.statements.length !== 3) {
    return null;
  }
  const [cloneStatement, deleteStatement, returnStatement] = updater.body.statements;
  if (
    !cloneStatement ||
    !ts.isVariableStatement(cloneStatement) ||
    (cloneStatement.declarationList.flags & ts.NodeFlags.Const) === 0 ||
    cloneStatement.declarationList.declarations.length !== 1 ||
    !deleteStatement ||
    !ts.isExpressionStatement(deleteStatement) ||
    !ts.isDeleteExpression(deleteStatement.expression) ||
    !returnStatement ||
    !ts.isReturnStatement(returnStatement) ||
    !returnStatement.expression
  ) {
    return null;
  }
  const clone = cloneStatement.declarationList.declarations[0]!,
    cloneValue = clone.initializer && unwrapTransparentExpression(clone.initializer),
    deleted = unwrapTransparentExpression(deleteStatement.expression.expression);
  if (
    !ts.isIdentifier(clone.name) ||
    !cloneValue ||
    !ts.isObjectLiteralExpression(cloneValue) ||
    cloneValue.properties.length !== 1 ||
    !ts.isSpreadAssignment(cloneValue.properties[0]!) ||
    !isIdentifierNamed(
      unwrapTransparentExpression(cloneValue.properties[0]!.expression),
      previous,
    ) ||
    !ts.isElementAccessExpression(deleted) ||
    !isIdentifierNamed(unwrapTransparentExpression(deleted.expression), clone.name.text) ||
    !deleted.argumentExpression ||
    !isPureExpression(deleted.argumentExpression) ||
    !isIdentifierNamed(unwrapTransparentExpression(returnStatement.expression), clone.name.text)
  ) {
    return null;
  }
  return deleted.argumentExpression;
}

function writtenRecordEntry(
  state: StateCandidate,
  call: ts.CallExpression,
  key: ts.Expression,
  childContracts: ChildContractResolver | null,
): KeyedRecordEntry | null {
  const directRepeated = nearestRepeatedRenderCall(call, state.owner),
    directCallback = directRepeated?.arguments[0];
  if (
    directRepeated &&
    directCallback &&
    (ts.isArrowFunction(directCallback) || ts.isFunctionExpression(directCallback)) &&
    directCallback.parameters[0] &&
    ts.isIdentifier(directCallback.parameters[0]!.name)
  ) {
    const path = accessPathFromBinding(key, directCallback.parameters[0]!.name.text);
    if (path && path.length > 0 && jsxEventCallIsDeferred(call, state.owner, childContracts)) {
      return { path, repeated: directRepeated };
    }
  }

  const command = nearestNestedFunction(call, state.owner);
  if (
    !command ||
    (!ts.isArrowFunction(command) &&
      !ts.isFunctionDeclaration(command) &&
      !ts.isFunctionExpression(command))
  ) {
    return null;
  }
  const matches = command.parameters.flatMap((parameter, index) => {
    if (!ts.isIdentifier(parameter.name)) {
      return [];
    }
    const suffix = accessPathFromBinding(key, parameter.name.text);
    return suffix ? [{ index, suffix }] : [];
  });
  if (matches.length !== 1) {
    return null;
  }
  return recordCommandEntry(state, command, matches[0]!.index, matches[0]!.suffix, childContracts);
}

function recordCommandEntry(
  state: StateCandidate,
  command: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  parameterIndex: number,
  suffix: readonly string[],
  childContracts: ChildContractResolver | null,
): KeyedRecordEntry | null {
  const name = localRuntimeFunctionName(command);
  if (!name || bindingDeclarationCount(state.owner, name) !== 1) {
    return null;
  }
  let result: KeyedRecordEntry | null = null,
    references = 0,
    safe = true;
  visit(state.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    references += 1;
    const invocation = node.parent;
    if (!ts.isCallExpression(invocation) || invocation.expression !== node) {
      safe = false;
      return;
    }
    const repeated = nearestRepeatedRenderCall(invocation, state.owner),
      callback = repeated?.arguments[0],
      argument = invocation.arguments[parameterIndex];
    if (
      !repeated ||
      !callback ||
      (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
      !callback.parameters[0] ||
      !ts.isIdentifier(callback.parameters[0]!.name) ||
      !argument ||
      ts.isSpreadElement(argument) ||
      !jsxEventCallIsDeferred(invocation, state.owner, childContracts)
    ) {
      safe = false;
      return;
    }
    const prefix = accessPathFromBinding(argument, callback.parameters[0]!.name.text);
    if (!prefix) {
      safe = false;
      return;
    }
    const path = [...prefix, ...suffix];
    if (
      path.length === 0 ||
      (result && (result.repeated !== repeated || !accessPathsEqual(result.path, path)))
    ) {
      safe = false;
      return;
    }
    result = { path, repeated };
  });
  return safe && references > 0 ? result : null;
}

function jsxEventCallIsDeferred(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
  childContracts: ChildContractResolver | null,
): boolean {
  const attribute = findAncestorUntil(call, ts.isJsxAttribute, owner);
  if (
    !attribute ||
    !/^on[A-Z]/u.test(attribute.name.getText()) ||
    !attribute.initializer ||
    !ts.isJsxExpression(attribute.initializer) ||
    !attribute.initializer.expression ||
    !nodeWithin(call, attribute.initializer.expression)
  ) {
    return false;
  }
  const opening = attribute.parent.parent;
  if (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) {
    return false;
  }
  const component = opening.tagName.getText();
  if (/^[a-z]/u.test(component)) {
    return true;
  }
  return (
    childContracts !== null &&
    (childContracts.frameworkEventComponent(component) ||
      childContracts.componentCallbackPropIsDeferred(component, attribute.name.getText()))
  );
}

function localRuntimeFunctionName(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
): string | null {
  if (ts.isFunctionDeclaration(callback)) {
    return callback.name?.text ?? null;
  }
  return ts.isVariableDeclaration(callback.parent) &&
    callback.parent.initializer === callback &&
    ts.isIdentifier(callback.parent.name)
    ? callback.parent.name.text
    : null;
}

function accessPathFromBinding(
  expression: ts.Expression,
  binding: string,
): readonly string[] | null {
  const value = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(value)) {
    return value.text === binding ? [] : null;
  }
  if (ts.isPropertyAccessExpression(value)) {
    const parent = accessPathFromBinding(value.expression, binding);
    return parent ? [...parent, `.${value.name.text}`] : null;
  }
  if (ts.isElementAccessExpression(value) && value.argumentExpression) {
    const parent = accessPathFromBinding(value.expression, binding),
      key = unwrapTransparentExpression(value.argumentExpression);
    if (!parent) {
      return null;
    }
    if (ts.isStringLiteralLike(key)) {
      return [...parent, `[s:${key.text}]`];
    }
    if (ts.isNumericLiteral(key)) {
      return [...parent, `[n:${key.text}]`];
    }
  }
  return null;
}

function accessPathsEqual(
  left: readonly string[] | null,
  right: readonly string[] | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.length === right.length &&
    left.every((part, index) => part === right[index])
  );
}

function isIdentifierNamed(node: ts.Expression, name: string): boolean {
  return ts.isIdentifier(node) && node.text === name;
}

function isKeyedLeafScalarState(state: StateCandidate, usage: StateUsage | undefined): boolean {
  return (
    usage !== undefined &&
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
    usage.setterCallNodes.every(
      (call) =>
        call.arguments.length === 1 &&
        call.arguments[0] !== undefined &&
        isPureExpression(call.arguments[0]),
    ) &&
    (usage.deferredReads === 0 || hasOnlyEventCommandReads(state)) &&
    !usage.shadowed &&
    !usage.escaped &&
    usage.directRenderNodes.every((node) => isRepeatedScalarKeyProjection(node, state))
  );
}

function isKeyedScalarWithSecondaryLeaf(
  state: StateCandidate,
  usage: StateUsage | undefined,
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
    usage.setterCallNodes.some(
      (call) =>
        call.arguments.length !== 1 || !call.arguments[0] || !isPureExpression(call.arguments[0]),
    ) ||
    usage.shadowed ||
    usage.escaped ||
    !hasOnlyEventCommandReads(state, new Set(usage.directRenderNodes))
  ) {
    return false;
  }

  const producer = repeatedScalarSelectionProducer(state, usage);
  if (!producer) {
    return false;
  }

  const secondaryNodes: ts.Node[] = [];
  for (const node of usage.directRenderNodes) {
    if (isRepeatedScalarKeyProjection(node, state)) {
      if (nearestRepeatedRenderCall(node, state.owner) !== producer) {
        return false;
      }
      continue;
    }
    secondaryNodes.push(node);
  }
  const secondaryReferences = oneHopRenderProjectionReferences(
    state.owner,
    secondaryNodes,
    (initializer, reference) =>
      isPureExpression(initializer) ||
      (ts.isIdentifier(reference) && isSelectedItemLookup(initializer, reference)),
  );
  if (!secondaryReferences) {
    return false;
  }

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
      const call = findAncestorUntil(reference, ts.isCallExpression, state.owner),
        candidate = call?.arguments[0];
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

  const consumer = lowestCommonJsxSubtree(renderReferences, state.owner),
    producerReturn = findAncestorUntil(producer, ts.isReturnStatement, state.owner),
    consumerReturn = consumer
      ? findAncestorUntil(consumer, ts.isReturnStatement, state.owner)
      : null;
  return (
    consumer !== null &&
    jsxElementCountIn(consumer) / jsxElementCount(state.owner) <= 0.4 &&
    producerReturn !== null &&
    producerReturn === consumerReturn &&
    !nodeWithin(producer, consumer) &&
    !nodeWithin(consumer, producer)
  );
}

function hasSupportedKeyedSelectionInitializer(state: StateCandidate): boolean {
  if (hasDirectPrimitiveInitializer(state)) {
    return true;
  }
  if (state.call.arguments.length > 0) {
    return false;
  }
  const type = state.call.typeArguments?.[0];
  return type !== undefined && primitiveScalarType(type);
}

function primitiveScalarType(type: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(type) || ts.isTypeOperatorNode(type)) {
    return primitiveScalarType(type.type);
  }
  if (ts.isUnionTypeNode(type)) {
    return type.types.every(primitiveScalarType);
  }
  if (ts.isLiteralTypeNode(type)) {
    return true;
  }
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
  usage: StateUsage,
): ts.CallExpression | null {
  if (!state.setterName) {
    return null;
  }
  const producers = new Set<ts.CallExpression>();
  for (const call of usage.setterCallNodes) {
    const repeated = nearestRepeatedRenderCall(call, state.owner),
      callback = repeated?.arguments[0],
      event = nearestNestedFunction(call, state.owner),
      argument = call.arguments[0];
    if (
      !repeated ||
      !callback ||
      (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
      !event ||
      event === callback ||
      (!ts.isArrowFunction(event) && !ts.isFunctionExpression(event)) ||
      !argument ||
      !callback.parameters.some((parameter) =>
        expressionDependsOnBinding(argument, parameter.name, callback),
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

function isSelectedItemLookup(initializer: ts.Expression, stateReference: ts.Identifier): boolean {
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
  const left = unwrapTransparentExpression(comparison.left),
    right = unwrapTransparentExpression(comparison.right),
    other = left === stateReference ? right : right === stateReference ? left : null;
  if (!other || !expressionDependsOnBinding(other, callback.parameters[0]!.name, callback)) {
    return false;
  }
  let stateReads = 0;
  visit(initializer, (node) => {
    if (ts.isIdentifier(node) && node.text === stateReference.text && !isNonValueIdentifier(node)) {
      stateReads += 1;
    }
  });
  return stateReads === 1;
}

function isRepeatedScalarKeyProjection(node: ts.Node, state: StateCandidate): boolean {
  if (!ts.isIdentifier(node)) {
    return false;
  }
  const repeated = nearestRepeatedRenderCall(node, state.owner),
    callback = repeated?.arguments[0];
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
    visit(callback.body, (reference) => {
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
    return (
      references.length > 0 &&
      references.every(
        (reference) =>
          nearestRepeatedRenderCall(reference, state.owner) === repeated &&
          !isMembershipMountGate(reference, callback) &&
          findAncestorUntil(reference, isJsxNode, callback) !== null &&
          isSafeJsxProjectionReference(reference, callback, new Set(["cn"])),
      )
    );
  }

  return (
    !isMembershipMountGate(node, callback) &&
    findAncestorUntil(node, isJsxNode, callback) !== null &&
    isSafeJsxProjectionReference(node, callback, new Set(["cn"]))
  );
}

function scalarComparisonUsesRepeatedKey(
  node: ts.Identifier,
  callback: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== callback;
    current = current.parent
  ) {
    if (
      !ts.isBinaryExpression(current) ||
      ![ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(
        current.operatorToken.kind,
      )
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
      callback.parameters.some((parameter) =>
        expressionDependsOnBinding(other, parameter.name, callback),
      )
    ) {
      return true;
    }
  }
  return false;
}

function isKeyedLeafCollectionState(state: StateCandidate, usage: StateUsage | undefined): boolean {
  if (!usage || usage.effectReads > 0) {
    return false;
  }

  const directCollection = isSetOrMapState(state.call),
    arraySetAlias = directCollection ? null : localSetAliasForArrayState(state);
  if ((!directCollection && !arraySetAlias) || jsxElementCount(state.owner) < 12) {
    return false;
  }
  const aliasName = arraySetAlias?.declaration.name.getText() ?? null;

  let repeatedMembership = false,
    unsafe = false;
  visit(state.owner.body, (node) => {
    if (
      unsafe ||
      !ts.isIdentifier(node) ||
      (node.text !== state.valueName && node.text !== aliasName)
    ) {
      return;
    }
    if (isDeclarationName(node) || isNonValueIdentifier(node)) {
      return;
    }
    if (arraySetAlias && node === arraySetAlias.stateSource) {
      return;
    }
    const property =
      ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
        ? node.parent
        : null;
    if (arraySetAlias && node.text === state.valueName) {
      if (property?.name.text === "length") {
        if (collectionSummaryControlsRepeatedRendering(property, state.owner)) {
          unsafe = true;
        }
        return;
      }
      if (isDeferredCollectionRead(node, state.owner)) {
        return;
      }
      if (isHookDependencyReference(node, MEMO_CALLBACK_HOOKS)) {
        return;
      }
      if (isListExtraDataReference(node, state.owner)) {
        return;
      }
      unsafe = true;
      return;
    }
    if (property && KEYED_COLLECTION_PROPERTIES.has(property.name.text)) {
      if (property.name.text === "size") {
        if (collectionSummaryControlsRepeatedRendering(property, state.owner)) {
          unsafe = true;
        }
        return;
      }
      if (["entries", "keys", "values"].includes(property.name.text)) {
        return;
      }
      if (
        property.name.text !== "has" ||
        !ts.isCallExpression(property.parent) ||
        property.parent.expression !== property
      ) {
        unsafe = true;
        return;
      }
      const membershipCall = property.parent,
        summaryCall = collectionMembershipSummaryCall(membershipCall, state.owner);
      if (summaryCall) {
        if (collectionSummaryControlsRepeatedRendering(summaryCall, state.owner)) {
          unsafe = true;
        }
        return;
      }
      if (isBoundedFilteredSelectionSummary(membershipCall, state)) {
        return;
      }
      if (!isRepeatedMembershipRender(membershipCall, state.owner)) {
        unsafe = true;
      } else if (membershipControlsRepeatedMount(membershipCall, state.owner)) {
        unsafe = true;
      } else {
        repeatedMembership = true;
      }
      return;
    }
    if (ts.isSpreadElement(node.parent)) {
      return;
    }
    if (isCollectionCopyArgument(node) && isDeferredCollectionRead(node, state.owner)) {
      return;
    }
    if (isHookDependencyReference(node, MEMO_CALLBACK_HOOKS)) {
      return;
    }
    if (isListExtraDataReference(node, state.owner)) {
      return;
    }
    unsafe = true;
  });
  return repeatedMembership && !unsafe;
}

function isBoundedFilteredSelectionSummary(
  membership: ts.CallExpression,
  state: StateCandidate,
): boolean {
  const callback = nearestNestedFunction(membership, state.owner);
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    ts.isBlock(callback.body) ||
    unwrapTransparentExpression(callback.body) !== membership ||
    !membershipUsesCallbackKey(membership, callback)
  ) {
    return false;
  }
  const filter = callback.parent;
  if (
    !ts.isCallExpression(filter) ||
    !filter.arguments.includes(callback) ||
    !ts.isPropertyAccessExpression(filter.expression) ||
    filter.expression.name.text !== "filter" ||
    !ts.isIdentifier(unwrapTransparentExpression(filter.expression.expression))
  ) {
    return false;
  }
  const declaration = filter.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer !== filter ||
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(state.owner, declaration.name.text) !== 1
  ) {
    return false;
  }

  const aliasName = declaration.name.text,
    references: ts.Identifier[] = [];
  visit(state.owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === aliasName &&
      node !== declaration.name &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  const gates = new Set(
      references.flatMap((reference) => {
        const gate = commonRenderGateSubtree([reference], state.owner);
        return gate ? [gate] : [];
      }),
    ),
    gate = gates.size === 1 ? [...gates][0]! : null;
  if (!gate || jsxElementCountIn(gate) / jsxElementCount(state.owner) > 0.4) {
    return false;
  }

  return (
    references.length > 0 &&
    references.every((reference) => {
      const property =
        ts.isPropertyAccessExpression(reference.parent) && reference.parent.expression === reference
          ? reference.parent
          : null;
      if (property?.name.text === "length") {
        return commonRenderGateSubtree([reference], state.owner) === gate;
      }
      if (
        property?.name.text !== "map" ||
        !ts.isCallExpression(property.parent) ||
        property.parent.expression !== property ||
        !nodeWithin(reference, gate)
      ) {
        return false;
      }
      const row = property.parent.arguments[0];
      return (
        row !== undefined &&
        (ts.isArrowFunction(row) || ts.isFunctionExpression(row)) &&
        repeatedRenderHasStableItemKey(row)
      );
    })
  );
}

function collectionMembershipSummaryCall(
  membership: ts.CallExpression,
  owner: RuntimeFunctionLike,
): ts.CallExpression | null {
  const callback = nearestNestedFunction(membership, owner);
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    ts.isBlock(callback.body) ||
    unwrapTransparentExpression(callback.body) !== membership ||
    !membershipUsesCallbackKey(membership, callback)
  ) {
    return null;
  }
  const summary = callback.parent;
  if (
    !ts.isCallExpression(summary) ||
    !summary.arguments.includes(callback) ||
    !ts.isPropertyAccessExpression(summary.expression) ||
    !["every", "some"].includes(summary.expression.name.text) ||
    !ts.isIdentifier(unwrapTransparentExpression(summary.expression.expression))
  ) {
    return null;
  }
  return summary;
}

function collectionSummaryControlsRepeatedRendering(
  summary: ts.Expression,
  owner: RuntimeFunctionLike,
): boolean {
  if (!owner.body) {
    return true;
  }
  if (nearestRepeatedRenderCall(summary, owner)) {
    return true;
  }
  const declaration = findAncestorUntil(summary, ts.isVariableDeclaration, owner);
  if (
    !declaration ||
    !ts.isIdentifier(declaration.name) ||
    !declaration.initializer ||
    !nodeWithin(summary, declaration.initializer)
  ) {
    return referenceControlsRepeatedRendering(summary, owner);
  }
  if (bindingDeclarationCount(owner, declaration.name.text) !== 1) {
    return true;
  }
  const references: ts.Identifier[] = [];
  visit(owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === declaration.name.getText() &&
      node !== declaration.name &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return references.some((reference) => referenceControlsRepeatedRendering(reference, owner));
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
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (
      (ts.isBinaryExpression(current) &&
        nodeWithin(node, current.left) &&
        containsRepeatedRender(current.right)) ||
      (ts.isConditionalExpression(current) &&
        nodeWithin(node, current.condition) &&
        (containsRepeatedRender(current.whenTrue) || containsRepeatedRender(current.whenFalse))) ||
      (ts.isIfStatement(current) &&
        nodeWithin(node, current.expression) &&
        (containsRepeatedRender(current.thenStatement) ||
          (current.elseStatement !== undefined && containsRepeatedRender(current.elseStatement))))
    ) {
      return true;
    }
  }
  return false;
}

function summaryFeedsStableRowProjection(
  summaryReference: ts.Node,
  callback: ts.ArrowFunction | ts.FunctionExpression,
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
  const projectionName = declaration.name.text,
    references: ts.Identifier[] = [];
  visitSkippingNestedFunctions(callback.body, callback, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === projectionName &&
      node !== declaration.name &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return (
    references.length > 0 &&
    references.every(
      (reference) =>
        !isMembershipMountGate(reference, callback) &&
        findAncestorUntil(reference, isJsxNode, callback) !== null &&
        isSafeJsxProjectionReference(reference, callback, new Set(["cn"])),
    )
  );
}

function containsRepeatedRender(root: ts.Node): boolean {
  let found = false;
  visitSkippingNestedRuntimeFunctions(root, (node) => {
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
  if (!callback || isSynchronousRenderCallback(callback) || renderedListCallback(node, owner)) {
    return false;
  }
  const attribute = findAncestorUntil(callback, ts.isJsxAttribute, owner);
  return !attribute || /^on[A-Z]/u.test(attribute.name.getText());
}

function isRepeatedMembershipRender(call: ts.CallExpression, owner: RuntimeFunctionLike): boolean {
  const repeated = nearestRepeatedRenderCall(call, owner),
    callback = repeated?.arguments[0] ?? renderedListCallback(call, owner);
  return (
    callback !== null &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
    membershipUsesCallbackKey(call, callback) &&
    (!repeated || repeatedRenderHasStableItemKey(callback))
  );
}

function membershipUsesCallbackKey(
  call: ts.CallExpression,
  callback: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  const argument = call.arguments[0],
    parameter = callback.parameters[0]?.name;
  if (!argument || !parameter) {
    return false;
  }
  return expressionDependsOnBinding(argument, parameter, callback);
}

function renderedListCallback(
  node: ts.Node,
  owner: RuntimeFunctionLike,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const callback = nearestNestedFunction(node, owner);
  if (!callback) {
    return null;
  }
  const initializer = callback.parent,
    declaration =
      ts.isCallExpression(initializer) &&
      ts.isIdentifier(initializer.expression) &&
      initializer.expression.text === "useCallback"
        ? initializer.parent
        : callback.parent;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) {
    return null;
  }
  const bindingName = declaration.name.text;
  let rendered = false;
  visit(owner.body, (current) => {
    if (
      ts.isIdentifier(current) &&
      current.text === bindingName &&
      isListRenderAttributeReference(current)
    ) {
      rendered = true;
    }
  });
  // SAFETY: Reaching this branch requires a variable declaration initialized
  // It is initialized directly by this callback or by a useCallback call containing it.
  return rendered ? (callback as ts.ArrowFunction | ts.FunctionExpression) : null;
}

function isListRenderAttributeReference(node: ts.Identifier): boolean {
  const expression = node.parent;
  if (!ts.isJsxExpression(expression) || expression.expression !== node) {
    return false;
  }
  const attribute = expression.parent;
  return ts.isJsxAttribute(attribute) && attribute.name.getText() === "renderItem";
}

function isListExtraDataReference(node: ts.Identifier, owner: RuntimeFunctionLike): boolean {
  const expression = node.parent;
  if (!ts.isJsxExpression(expression) || expression.expression !== node) {
    return false;
  }
  const attribute = expression.parent;
  return (
    ts.isJsxAttribute(attribute) &&
    attribute.name.getText() === "extraData" &&
    isInsideOwner(attribute, owner)
  );
}

function isInsideOwner(node: ts.Node, owner: RuntimeFunctionLike): boolean {
  return node.getStart() >= owner.getStart() && node.end <= owner.end;
}

function isCollectionCopyArgument(node: ts.Identifier): boolean {
  const { parent } = node;
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

function membershipControlsRepeatedMount(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
): boolean {
  const repeated = nearestRepeatedRenderCall(call, owner),
    callback = repeated?.arguments[0] ?? renderedListCallback(call, owner);
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return true;
  }
  const declaration = findAncestorUntil(call, ts.isVariableDeclaration, callback);
  if (
    declaration &&
    ts.isIdentifier(declaration.name) &&
    declaration.initializer &&
    nodeWithin(call, declaration.initializer)
  ) {
    const aliasName = declaration.name.text,
      references: ts.Identifier[] = [];
    visitSkippingNestedFunctions(callback.body, callback, (node) => {
      if (
        ts.isIdentifier(node) &&
        node.text === aliasName &&
        node !== declaration.name &&
        !isNonValueIdentifier(node)
      ) {
        references.push(node);
      }
    });
    return (
      references.length > 0 &&
      references.every((reference) => isMembershipMountGate(reference, callback))
    );
  }
  return isMembershipMountGate(call, callback);
}

function isMembershipMountGate(node: ts.Node, callback: RuntimeFunctionLike): boolean {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== callback;
    current = current.parent
  ) {
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
  visitSkippingNestedRuntimeFunctions(statement, (node) => {
    if (ts.isReturnStatement(node)) {
      found = true;
    }
  });
  return found;
}

function expressionIsNullish(expression: ts.Expression): boolean {
  return (
    expression.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(expression) && expression.text === "undefined")
  );
}

export function isSelectionStateName(name: string): boolean {
  return /(?:selected|selection|added|checked)/iu.test(name);
}
