import type { StateCandidate, StateUsage } from "../analyze-source.js";
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
import {
  commonRenderGateSubtree,
  expressionContainsJsx,
  isRenderGateReference,
  isSafeProjectionExpression,
} from "./deferred-reveal.js";
import {
  findAncestorUntil,
  nearestNestedFunction,
  nodeWithin,
  visit,
  visitSkippingNestedFunctions,
  visitSkippingNestedRuntimeFunctions,
} from "../ast.js";

import type { ChildContractResolver } from "./child-contract.js";
import type { HookImports } from "../imports.js";
import type { JsxSubtreeNode } from "./deferred-reveal.js";
import type { RuntimeFunctionLike } from "../ast.js";
import { isImportedHookCall } from "../imports.js";
import { mutationRegionOnlyCallsStateSetters } from "./effect-drafts.js";
import ts from "typescript";

const KEYED_COLLECTION_PROPERTIES = new Set(["entries", "has", "keys", "size", "values"]);
const LIST_SIZED_OWNER_JSX_ELEMENTS = 12;
const MAX_CONSUMER_JSX_SHARE = 0.4;
const RECORD_TYPE_ARGUMENT_COUNT = 2;
const RECORD_UPDATER_OBJECT_PROPERTY_COUNT = 2;
const RECORD_UPDATER_STATEMENT_COUNT = 3;
const MEMO_CALLBACK_HOOKS = new Set(["useCallback", "useMemo"]);

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
  const inputs: KeyedSelectionInputs = {
    childContracts,
    imports,
    safeCommandStates,
    states,
    statesWithCompanionWrites,
    usageByState,
  };
  return {
    collectionStates: keyedCollectionStates(inputs),
    recordStates: keyedRecordStates(inputs),
    scalarStates: keyedLeafSelections(inputs, isKeyedLeafScalarState),
    secondaryLeafStates: keyedLeafSelections(inputs, isKeyedScalarWithSecondaryLeaf),
  };
}

interface KeyedSelectionInputs {
  childContracts: ChildContractResolver | null;
  imports: HookImports;
  safeCommandStates: ReadonlySet<StateCandidate>;
  states: readonly StateCandidate[];
  statesWithCompanionWrites: ReadonlySet<StateCandidate>;
  usageByState: ReadonlyMap<StateCandidate, StateUsage>;
}

function keyedCollectionStates(inputs: KeyedSelectionInputs): Set<StateCandidate> {
  const { imports, safeCommandStates, states, statesWithCompanionWrites, usageByState } = inputs;
  const settersByOwner = ownerSetterNames(states);
  return new Set(
    states.filter(
      (state) =>
        safeCommandStates.has(state) &&
        isKeyedCollectionSelection({
          imports,
          ownerSetters: settersByOwner.get(state.owner) ?? new Set(),
          state,
          statesWithCompanionWrites,
          usage: usageByState.get(state),
        }),
    ),
  );
}

function keyedRecordStates(inputs: KeyedSelectionInputs): Set<StateCandidate> {
  const { childContracts, states, statesWithCompanionWrites, usageByState } = inputs;
  return new Set(
    states.filter(
      (state) =>
        !statesWithCompanionWrites.has(state) &&
        isKeyedLeafRecordState(state, usageByState.get(state), childContracts),
    ),
  );
}

function keyedLeafSelections(
  inputs: KeyedSelectionInputs,
  isKeyedLeaf: (state: StateCandidate, usage: StateUsage | undefined) => boolean,
): Set<StateCandidate> {
  const { safeCommandStates, states, statesWithCompanionWrites, usageByState } = inputs;
  return new Set(
    states.filter((state) => {
      const usage = usageByState.get(state);
      return (
        safeCommandStates.has(state) &&
        writesIndependentlyOfCompanions(state, usage, statesWithCompanionWrites) &&
        isKeyedLeaf(state, usage)
      );
    }),
  );
}

function ownerSetterNames(
  states: readonly StateCandidate[],
): Map<RuntimeFunctionLike, Set<string>> {
  const settersByOwner = new Map<RuntimeFunctionLike, Set<string>>();
  for (const state of states) {
    if (!state.setterName) {
      continue;
    }
    const setters = settersByOwner.get(state.owner) ?? new Set<string>();
    setters.add(state.setterName);
    settersByOwner.set(state.owner, setters);
  }
  return settersByOwner;
}

interface KeyedCollectionSelectionCheck {
  imports: HookImports;
  ownerSetters: ReadonlySet<string>;
  state: StateCandidate;
  statesWithCompanionWrites: ReadonlySet<StateCandidate>;
  usage: StateUsage | undefined;
}

function isKeyedCollectionSelection(check: KeyedCollectionSelectionCheck): boolean {
  const { imports, ownerSetters, state, statesWithCompanionWrites, usage } = check;
  return (
    (hasIndependentCollectionEventWrite(state, usage, ownerSetters) &&
      isKeyedLeafCollectionState(state, usage)) ||
    (!statesWithCompanionWrites.has(state) &&
      isImperativeRenderedCollectionState(state, usage, imports))
  );
}

function writesIndependentlyOfCompanions(
  state: StateCandidate,
  usage: StateUsage | undefined,
  statesWithCompanionWrites: ReadonlySet<StateCandidate>,
): boolean {
  return !statesWithCompanionWrites.has(state) || hasIndependentRepeatedEventWrite(state, usage);
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
  const [initial] = call.arguments;
  if (!initial) {
    return false;
  }
  if (isSetOrMapConstruction(initial)) {
    return true;
  }
  return (
    (ts.isArrowFunction(initial) || ts.isFunctionExpression(initial)) &&
    lazyInitializerReturnsSetOrMap(initial)
  );
}

function lazyInitializerReturnsSetOrMap(
  initial: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  if (!ts.isBlock(initial.body)) {
    return isSetOrMapConstruction(initial.body);
  }
  return initial.body.statements.some(
    (statement) =>
      ts.isReturnStatement(statement) &&
      statement.expression !== undefined &&
      isSetOrMapConstruction(statement.expression),
  );
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
  const [initial] = call.arguments;
  return initial !== undefined && ts.isArrayLiteralExpression(unwrapTransparentExpression(initial));
}

function isImperativeRenderedCollectionState(
  state: StateCandidate,
  usage: StateUsage | undefined,
  imports: HookImports,
): boolean {
  const { body } = state.owner;
  if (!usage || !state.setterName || !body || !usageAllowsImperativeCollection(state, usage)) {
    return false;
  }
  const reads = collectImperativeCollectionReads(body, state, imports);
  const setterCallbacks = setterCommandCallbacks(usage, state, imports);
  const commandCallbacks =
    reads.safe && reads.renderedMembership && setterCallbacks
      ? new Set([...reads.commandCallbacks, ...setterCallbacks])
      : null;
  const soleCallback = commandCallbacks?.size === 1 ? [...commandCallbacks][0]! : null;
  if (!soleCallback) {
    return false;
  }
  return (
    callbackReadsStateWithDependency(soleCallback, state) &&
    callbackIsExposedOnlyByImperativeHandle(soleCallback, state.owner, imports)
  );
}

function usageAllowsImperativeCollection(state: StateCandidate, usage: StateUsage): boolean {
  return (
    (isSetOrMapState(state.call) || isNullableSetState(state.call)) &&
    usage.localRenderReads > 0 &&
    usage.localRenderReads === usage.directRenderNodes.length &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.transportedOccurrences === 0 &&
    usage.setterCalls > 0 &&
    usage.setterReferences === usage.setterCalls &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped
  );
}

interface ImperativeCollectionReads {
  commandCallbacks: Set<ts.ArrowFunction | ts.FunctionExpression>;
  renderedMembership: boolean;
  safe: boolean;
}

function collectImperativeCollectionReads(
  body: ts.Node,
  state: StateCandidate,
  imports: HookImports,
): ImperativeCollectionReads {
  const commandCallbacks = new Set<ts.ArrowFunction | ts.FunctionExpression>();
  let renderedMembership = false;
  let safe = true;
  visit(body, (node) => {
    if (!safe || !isCollectionValueRead(node, state)) {
      return;
    }
    const read = classifyCollectionRead(node, state, imports);
    if (read.kind === "unsafe") {
      safe = false;
    } else if (read.kind === "membership") {
      renderedMembership = true;
    } else {
      commandCallbacks.add(read.callback);
    }
  });
  return { commandCallbacks, renderedMembership, safe };
}

function isCollectionValueRead(node: ts.Node, state: StateCandidate): node is ts.Identifier {
  return (
    ts.isIdentifier(node) &&
    node.text === state.valueName &&
    !isDeclarationName(node) &&
    !isNonValueIdentifier(node) &&
    node.parent !== state.call.parent
  );
}

type CollectionRead =
  | { callback: ts.ArrowFunction | ts.FunctionExpression; kind: "command" }
  | { kind: "membership" }
  | { kind: "unsafe" };

function classifyCollectionRead(
  node: ts.Identifier,
  state: StateCandidate,
  imports: HookImports,
): CollectionRead {
  const dependencyCallback = useCallbackDependencyOwner(node, state.owner, imports);
  if (dependencyCallback) {
    return { callback: dependencyCallback, kind: "command" };
  }
  const membership = membershipCallOn(node);
  if (membership) {
    return isStableRenderedMembership(membership, state.owner)
      ? { kind: "membership" }
      : { kind: "unsafe" };
  }
  const callback = imperativeCommandCallback(node, state.owner, imports);
  return callback ? { callback, kind: "command" } : { kind: "unsafe" };
}

function membershipCallOn(node: ts.Identifier): ts.CallExpression | null {
  const property =
    ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
      ? node.parent
      : null;
  return property?.name.text === "has" &&
    ts.isCallExpression(property.parent) &&
    property.parent.expression === property
    ? property.parent
    : null;
}

function setterCommandCallbacks(
  usage: StateUsage,
  state: StateCandidate,
  imports: HookImports,
): Set<ts.ArrowFunction | ts.FunctionExpression> | null {
  const callbacks = new Set<ts.ArrowFunction | ts.FunctionExpression>();
  for (const call of usage.setterCallNodes) {
    const callback = imperativeCommandCallback(call, state.owner, imports);
    if (!callback) {
      return null;
    }
    callbacks.add(callback);
  }
  return callbacks;
}

function useCallbackDependencyOwner(
  node: ts.Identifier,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const call = findAncestorUntil(node, ts.isCallExpression, owner);
  const callback = call?.arguments[0];
  return call &&
    call.arguments[1] &&
    nodeWithin(node, call.arguments[1]) &&
    isUnshadowedReactHookCall({ call, hook: "useCallback", imports, owner }) &&
    callback &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
    ? callback
    : null;
}

function isNullableSetState(call: ts.CallExpression): boolean {
  const [initial] = call.arguments;
  const type = call.typeArguments?.[0];
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
      isUnshadowedReactHookCall({ call, hook: "useCallback", imports, owner }) &&
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
  const call = callback.parent;
  const dependencies = ts.isCallExpression(call) ? call.arguments[1] : undefined;
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
  const binding = imperativeCallbackBinding(callback, owner);
  if (!binding) {
    return false;
  }
  let exposed = false;
  let safe = true;
  visit(owner.body, (node) => {
    if (!safe || !isOtherBindingReference(node, binding)) {
      return;
    }
    const exposure = classifyImperativeHandleReference(node, owner, imports);
    if (exposure === "unsafe") {
      safe = false;
    } else if (exposure === "exposed") {
      exposed = true;
    }
  });
  return safe && exposed;
}

function imperativeCallbackBinding(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
): ts.Identifier | null {
  const hookCall = callback.parent;
  const declaration =
    ts.isCallExpression(hookCall) && ts.isVariableDeclaration(hookCall.parent)
      ? hookCall.parent
      : null;
  if (!declaration || !ts.isIdentifier(declaration.name)) {
    return null;
  }
  return bindingDeclarationCount(owner, declaration.name.text) === 1 ? declaration.name : null;
}

function isOtherBindingReference(node: ts.Node, binding: ts.Identifier): node is ts.Identifier {
  return (
    ts.isIdentifier(node) &&
    node.text === binding.text &&
    node !== binding &&
    !isDeclarationName(node) &&
    !isNonValueIdentifier(node)
  );
}

type ImperativeExposure = "exposed" | "ignored" | "unsafe";

function classifyImperativeHandleReference(
  node: ts.Identifier,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): ImperativeExposure {
  const imperativeCall = findAncestorUntil(node, ts.isCallExpression, owner);
  if (
    !imperativeCall ||
    !isUnshadowedReactHookCall({
      call: imperativeCall,
      hook: "useImperativeHandle",
      imports,
      owner,
    })
  ) {
    return "unsafe";
  }
  const [, factory, dependencies] = imperativeCall.arguments;
  if (factory && nodeWithin(node, factory)) {
    return imperativeFactoryReturnsBinding(factory, node) ? "exposed" : "unsafe";
  }
  return dependencies && nodeWithin(node, dependencies) ? "ignored" : "unsafe";
}

interface ReactHookCallCheck {
  call: ts.CallExpression;
  hook: "useCallback" | "useImperativeHandle";
  imports: HookImports;
  owner: RuntimeFunctionLike;
}

function isUnshadowedReactHookCall(check: ReactHookCallCheck): boolean {
  const { call, hook, imports, owner } = check;
  const names = hook === "useCallback" ? imports.useCallback : imports.useImperativeHandle;
  if (!isImportedHookCall(call, names, imports.reactNamespaces, hook)) {
    return false;
  }
  const root = hookCallRootIdentifier(call);
  return root !== null && bindingDeclarationCount(owner, root.text) === 0;
}

function imperativeFactoryReturnsBinding(
  factory: ts.Expression,
  reference: ts.Identifier,
): boolean {
  const value = unwrapTransparentExpression(factory);
  const object =
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
  const callbackName = memoizedCallbackName(callback.parent);
  const opening = callbackName ? soleRenderItemOpening(owner, callbackName) : null;
  const extractor = opening ? keyExtractorFunction(opening) : null;
  return extractor !== null && returnsItemPropertyPath(extractor);
}

function soleRenderItemOpening(
  owner: RuntimeFunctionLike,
  callbackName: string,
): ts.JsxOpeningLikeElement | null {
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
    const opening = renderItemAttributeOwner(node);
    if (opening) {
      openings.add(opening);
    } else {
      callbackConfined = false;
    }
  });
  return callbackConfined && openings.size === 1 ? [...openings][0]! : null;
}

function renderItemAttributeOwner(node: ts.Identifier): ts.JsxOpeningLikeElement | null {
  const expression = node.parent;
  if (!ts.isJsxExpression(expression) || expression.expression !== node) {
    return null;
  }
  const attribute = expression.parent;
  return ts.isJsxAttribute(attribute) &&
    attribute.name.getText() === "renderItem" &&
    ts.isJsxAttributes(attribute.parent)
    ? attribute.parent.parent
    : null;
}

function keyExtractorFunction(
  opening: ts.JsxOpeningLikeElement,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const keyExtractor = opening.attributes.properties.find(
    (property) => ts.isJsxAttribute(property) && property.name.getText() === "keyExtractor",
  );
  if (!keyExtractor || !ts.isJsxAttribute(keyExtractor)) {
    return null;
  }
  const { initializer } = keyExtractor;
  const expression = initializer && ts.isJsxExpression(initializer) ? initializer.expression : null;
  if (!expression) {
    return null;
  }
  const extractor = unwrapTransparentExpression(expression);
  return ts.isArrowFunction(extractor) || ts.isFunctionExpression(extractor) ? extractor : null;
}

function returnsItemPropertyPath(extractor: ts.ArrowFunction | ts.FunctionExpression): boolean {
  const parameter = extractor.parameters[0]?.name;
  if (!parameter || !ts.isIdentifier(parameter) || ts.isBlock(extractor.body)) {
    return false;
  }
  let root = unwrapTransparentExpression(extractor.body);
  let propertyDepth = 0;
  while (ts.isPropertyAccessExpression(root)) {
    propertyDepth += 1;
    root = unwrapTransparentExpression(root.expression);
  }
  return propertyDepth > 0 && ts.isIdentifier(root) && root.text === parameter.text;
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
    if (!ts.isVariableDeclaration(node)) {
      return;
    }
    const alias = setAliasFromDeclaration(node, state);
    if (alias) {
      matches.push(alias);
    }
  });
  const match = matches.length === 1 ? matches[0]! : null;
  return match && bindingDeclarationCount(state.owner, match.declaration.name.getText()) === 1
    ? match
    : null;
}

function setAliasFromDeclaration(
  declaration: ts.VariableDeclaration,
  state: StateCandidate,
): ArraySetAlias | null {
  const source = constSetConstructionSource(declaration);
  if (!source) {
    return null;
  }
  if (source.text === state.valueName) {
    return { declaration, stateSource: source };
  }
  const filtered = filteredSelectionDeclaration(state, source.text);
  return filtered && filteredSelectionHasOneControlledLeaf(state, filtered, declaration)
    ? { declaration, stateSource: filtered.stateSource }
    : null;
}

function constSetConstructionSource(declaration: ts.VariableDeclaration): ts.Identifier | null {
  if (
    !ts.isIdentifier(declaration.name) ||
    !declaration.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return null;
  }
  const initializer = unwrapTransparentExpression(declaration.initializer);
  if (
    !ts.isNewExpression(initializer) ||
    !ts.isIdentifier(initializer.expression) ||
    initializer.expression.text !== "Set" ||
    initializer.arguments?.length !== 1
  ) {
    return null;
  }
  const source = unwrapTransparentExpression(initializer.arguments[0]!);
  return ts.isIdentifier(source) ? source : null;
}

interface FilteredSelectionDeclaration {
  declaration: ts.VariableDeclaration;
  stateSource: ts.Identifier;
}

function filteredSelectionDeclaration(
  state: StateCandidate,
  name: string,
): FilteredSelectionDeclaration | null {
  const filter = constFilterOnState(state, name);
  if (!filter) {
    return null;
  }
  const { callback, declaration, stateSource } = filter;
  return callbackTestsForeignMembership(callback, state) ? { declaration, stateSource } : null;
}

interface ConstBinding {
  declaration: ts.VariableDeclaration;
  initializer: ts.Expression;
}

function uniqueConstBinding(state: StateCandidate, name: string): ConstBinding | null {
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
  return { declaration, initializer: declaration.initializer };
}

interface FilteredSelectionCall {
  callback: ts.ArrowFunction | ts.FunctionExpression;
  declaration: ts.VariableDeclaration;
  stateSource: ts.Identifier;
}

function constFilterOnState(state: StateCandidate, name: string): FilteredSelectionCall | null {
  const binding = uniqueConstBinding(state, name);
  const filter = binding ? unwrapTransparentExpression(binding.initializer) : null;
  if (
    !binding ||
    !filter ||
    !ts.isCallExpression(filter) ||
    filter.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(filter.expression) ||
    filter.expression.name.text !== "filter"
  ) {
    return null;
  }
  const stateSource = unwrapTransparentExpression(filter.expression.expression);
  const [callback] = filter.arguments;
  if (
    !callback ||
    !ts.isIdentifier(stateSource) ||
    stateSource.text !== state.valueName ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    callback.parameters.length !== 1 ||
    !ts.isIdentifier(callback.parameters[0]!.name)
  ) {
    return null;
  }
  return { callback, declaration: binding.declaration, stateSource };
}

function callbackTestsForeignMembership(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  state: StateCandidate,
): boolean {
  if (ts.isBlock(callback.body)) {
    return false;
  }
  const membership = unwrapTransparentExpression(callback.body);
  if (
    !ts.isCallExpression(membership) ||
    membership.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(membership.expression) ||
    membership.expression.name.text !== "has"
  ) {
    return false;
  }
  const membershipSource = unwrapTransparentExpression(membership.expression.expression);
  return (
    ts.isIdentifier(membershipSource) &&
    membershipSource.text !== state.valueName &&
    isReadOnlyMembershipSource(state.owner, membershipSource.text) &&
    expressionDependsOnBinding(membership.arguments[0]!, callback.parameters[0]!.name, callback)
  );
}

function isReadOnlyMembershipSource(owner: RuntimeFunctionLike, name: string): boolean {
  if (!owner.body || bindingDeclarationCount(owner, name) !== 1) {
    return false;
  }
  const declaration = uniqueVariableDeclaration(owner.body, name);
  const initializer =
    declaration?.initializer && unwrapTransparentExpression(declaration.initializer);
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
  let reads = 0;
  let safe = true;
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
  const references = bindingReferencesIn(
    state.owner,
    filtered.declaration.name,
    filtered.declaration.name.getText(),
  );
  const setReference = references.find(
    (reference) =>
      setDeclaration.initializer !== undefined && nodeWithin(reference, setDeclaration.initializer),
  );
  const leafReferences = references.filter((reference) => reference !== setReference);
  if (!setReference || leafReferences.length !== 1) {
    return false;
  }
  return leafIsControlledByStateSetter(leafReferences[0]!, state);
}

function bindingReferencesIn(
  owner: RuntimeFunctionLike,
  binding: ts.Identifier,
  name: string,
): ts.Identifier[] {
  const references: ts.Identifier[] = [];
  visit(owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === name &&
      node !== binding &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return references;
}

function leafIsControlledByStateSetter(
  leafReference: ts.Identifier,
  state: StateCandidate,
): boolean {
  const attribute = findAncestorUntil(leafReference, ts.isJsxAttribute, state.owner);
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
  return opening.attributes.properties.some((property) =>
    isSetterBoundInteractionProp(property, state.setterName),
  );
}

function isSetterBoundInteractionProp(
  property: ts.JsxAttributeLike,
  setterName: string | null,
): boolean {
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
  return ts.isIdentifier(expression) && expression.text === setterName;
}

function hasIndependentRepeatedEventWrite(
  state: StateCandidate,
  usage: StateUsage | undefined,
): boolean {
  if (!state.setterName || !usage) {
    return false;
  }
  return usage.setterCallNodes.some((call) => {
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
    jsxElementCount(state.owner) < LIST_SIZED_OWNER_JSX_ELEMENTS ||
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
    const key = exactRecordEntryUpdaterKey(call);
    const written = key && writtenRecordEntry({ call, childContracts, key, state });
    return (
      written !== null &&
      written.repeated === rendered.repeated &&
      accessPathsEqual(written.path, rendered.path)
    );
  });
}

function isEmptyPrimitiveRecordState(state: StateCandidate): boolean {
  const [initial] = state.call.arguments;
  const initialValue = initial && unwrapTransparentExpression(initial);
  const type = state.call.typeArguments?.[0];
  if (
    !initialValue ||
    !ts.isObjectLiteralExpression(initialValue) ||
    initialValue.properties.length > 0 ||
    !type ||
    !ts.isTypeReferenceNode(type) ||
    !ts.isIdentifier(type.typeName) ||
    type.typeName.text !== "Record" ||
    type.typeArguments?.length !== RECORD_TYPE_ARGUMENT_COUNT ||
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
  const alias = soleTypeAlias(sourceFile, name);
  return (
    alias !== null &&
    !alias.typeParameters?.length &&
    primitiveRecordValueType(alias.type, sourceFile, new Set(seen).add(name))
  );
}

function soleTypeAlias(sourceFile: ts.SourceFile, name: string): ts.TypeAliasDeclaration | null {
  const aliases: ts.TypeAliasDeclaration[] = [];
  visit(sourceFile, (node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === name) {
      aliases.push(node);
    }
  });
  return aliases.length === 1 ? aliases[0]! : null;
}

function renderedRecordEntry(
  state: StateCandidate,
  nodes: readonly ts.Node[],
): KeyedRecordEntry | null {
  let result: KeyedRecordEntry | null = null;
  for (const node of nodes) {
    const entry = renderedRecordEntryForNode(node, state);
    if (
      !entry ||
      (result && (result.repeated !== entry.repeated || !accessPathsEqual(result.path, entry.path)))
    ) {
      return null;
    }
    result = entry;
  }
  return result;
}

function renderedRecordEntryForNode(node: ts.Node, state: StateCandidate): KeyedRecordEntry | null {
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
  const render = repeatedRecordRender(node, access, state.owner);
  const path = render && accessPathFromBinding(access.argumentExpression, render.itemName);
  if (
    !render ||
    !path ||
    path.length === 0 ||
    !hasMatchingKeyedAncestor(access, render.callback, path) ||
    isMembershipMountGate(access, render.callback) ||
    !isSafeJsxProjectionReference(node, render.callback, new Set(["cn"]))
  ) {
    return null;
  }
  return { path, repeated: render.repeated };
}

interface RepeatedRecordRender {
  callback: ts.ArrowFunction | ts.FunctionExpression;
  itemName: string;
  repeated: ts.CallExpression;
}

function repeatedRecordRender(
  node: ts.Identifier,
  access: ts.ElementAccessExpression,
  owner: RuntimeFunctionLike,
): RepeatedRecordRender | null {
  const repeated = nearestRepeatedRenderCall(access, owner);
  const callback = repeated?.arguments[0];
  if (
    !repeated ||
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    nearestNestedFunction(node, owner) !== callback ||
    !callback.parameters[0] ||
    !ts.isIdentifier(callback.parameters[0]!.name)
  ) {
    return null;
  }
  return { callback, itemName: callback.parameters[0]!.name.text, repeated };
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
    const opening = jsxOpeningOf(current);
    const expression = opening && jsxKeyExpression(opening);
    const item = callback.parameters[0]?.name;
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

function jsxKeyExpression(opening: ts.JsxOpeningLikeElement): ts.Expression | null {
  const key = opening.attributes.properties.find(
    (property) => ts.isJsxAttribute(property) && property.name.getText() === "key",
  );
  const initializer = key && ts.isJsxAttribute(key) ? key.initializer : null;
  return initializer && ts.isJsxExpression(initializer) ? (initializer.expression ?? null) : null;
}

function exactRecordEntryUpdaterKey(call: ts.CallExpression): ts.Expression | null {
  const updater = recordUpdaterFunction(call);
  if (!updater) {
    return null;
  }
  const { body, previous } = updater;
  return ts.isBlock(body)
    ? deletedRecordEntryKey(body, previous)
    : mergedRecordEntryKey(body, previous);
}

interface RecordUpdater {
  body: ts.ConciseBody;
  previous: string;
}

function recordUpdaterFunction(call: ts.CallExpression): RecordUpdater | null {
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
  return { body: updater.body, previous: updater.parameters[0]!.name.text };
}

function mergedRecordEntryKey(body: ts.Expression, previous: string): ts.Expression | null {
  const object = unwrapTransparentExpression(body);
  if (
    !ts.isObjectLiteralExpression(object) ||
    object.properties.length !== RECORD_UPDATER_OBJECT_PROPERTY_COUNT
  ) {
    return null;
  }
  const [spread, entry] = object.properties;
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

function deletedRecordEntryKey(body: ts.Block, previous: string): ts.Expression | null {
  if (body.statements.length !== RECORD_UPDATER_STATEMENT_COUNT) {
    return null;
  }
  const [cloneStatement, deleteStatement, returnStatement] = body.statements;
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
  const clone = cloneStatement.declarationList.declarations[0]!;
  const deleted = unwrapTransparentExpression(deleteStatement.expression.expression);
  if (
    !ts.isIdentifier(clone.name) ||
    !clonesPreviousRecord(clone, previous) ||
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

function clonesPreviousRecord(clone: ts.VariableDeclaration, previous: string): boolean {
  const cloneValue = clone.initializer && unwrapTransparentExpression(clone.initializer);
  return (
    cloneValue !== undefined &&
    ts.isObjectLiteralExpression(cloneValue) &&
    cloneValue.properties.length === 1 &&
    ts.isSpreadAssignment(cloneValue.properties[0]!) &&
    isIdentifierNamed(unwrapTransparentExpression(cloneValue.properties[0]!.expression), previous)
  );
}

interface WrittenRecordEntryCheck {
  call: ts.CallExpression;
  childContracts: ChildContractResolver | null;
  key: ts.Expression;
  state: StateCandidate;
}

function writtenRecordEntry(check: WrittenRecordEntryCheck): KeyedRecordEntry | null {
  const { call, childContracts, key, state } = check;
  const direct = directRepeatedRecordEntry(check);
  if (direct) {
    return direct;
  }
  const command = writeCommandFunction(call, state.owner);
  const match = command && commandParameterMatch(command, key);
  if (!command || !match) {
    return null;
  }
  return recordCommandEntry({
    childContracts,
    command,
    parameterIndex: match.index,
    state,
    suffix: match.suffix,
  });
}

function directRepeatedRecordEntry(check: WrittenRecordEntryCheck): KeyedRecordEntry | null {
  const { call, childContracts, key, state } = check;
  const repeated = nearestRepeatedRenderCall(call, state.owner);
  const callback = repeated?.arguments[0];
  if (
    !repeated ||
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    !callback.parameters[0] ||
    !ts.isIdentifier(callback.parameters[0]!.name)
  ) {
    return null;
  }
  const path = accessPathFromBinding(key, callback.parameters[0]!.name.text);
  return path && path.length > 0 && jsxEventCallIsDeferred(call, state.owner, childContracts)
    ? { path, repeated }
    : null;
}

function writeCommandFunction(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
): ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression | null {
  const command = nearestNestedFunction(call, owner);
  return command &&
    (ts.isArrowFunction(command) ||
      ts.isFunctionDeclaration(command) ||
      ts.isFunctionExpression(command))
    ? command
    : null;
}

interface CommandParameterMatch {
  index: number;
  suffix: readonly string[];
}

function commandParameterMatch(
  command: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  key: ts.Expression,
): CommandParameterMatch | null {
  const matches = command.parameters.flatMap((parameter, index) => {
    if (!ts.isIdentifier(parameter.name)) {
      return [];
    }
    const suffix = accessPathFromBinding(key, parameter.name.text);
    return suffix ? [{ index, suffix }] : [];
  });
  return matches.length === 1 ? matches[0]! : null;
}

interface RecordCommandEntryCheck {
  childContracts: ChildContractResolver | null;
  command: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;
  parameterIndex: number;
  state: StateCandidate;
  suffix: readonly string[];
}

function recordCommandEntry(check: RecordCommandEntryCheck): KeyedRecordEntry | null {
  const { command, state } = check;
  const name = localRuntimeFunctionName(command);
  if (!name || bindingDeclarationCount(state.owner, name) !== 1) {
    return null;
  }
  let references = 0;
  let result: KeyedRecordEntry | null = null;
  let safe = true;
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
    const entry = commandInvocationEntry(node, check);
    if (
      !entry ||
      (result && (result.repeated !== entry.repeated || !accessPathsEqual(result.path, entry.path)))
    ) {
      safe = false;
      return;
    }
    result = entry;
  });
  return safe && references > 0 ? result : null;
}

function commandInvocationEntry(
  node: ts.Identifier,
  check: RecordCommandEntryCheck,
): KeyedRecordEntry | null {
  const invocation = node.parent;
  if (!ts.isCallExpression(invocation) || invocation.expression !== node) {
    return null;
  }
  const render = deferredRepeatedInvocation(invocation, check);
  const prefix = render && accessPathFromBinding(render.argument, render.itemName);
  const path = prefix ? [...prefix, ...check.suffix] : null;
  return render && path && path.length > 0 ? { path, repeated: render.repeated } : null;
}

interface DeferredRepeatedInvocation {
  argument: ts.Expression;
  itemName: string;
  repeated: ts.CallExpression;
}

function deferredRepeatedInvocation(
  invocation: ts.CallExpression,
  check: RecordCommandEntryCheck,
): DeferredRepeatedInvocation | null {
  const { childContracts, parameterIndex, state } = check;
  const repeated = nearestRepeatedRenderCall(invocation, state.owner);
  const callback = repeated?.arguments[0];
  const argument = invocation.arguments[parameterIndex];
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
    return null;
  }
  return { argument, itemName: callback.parameters[0]!.name.text, repeated };
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
  const segment = accessPathSegment(value);
  if (!segment) {
    return null;
  }
  const parent = accessPathFromBinding(segment.target, binding);
  return parent ? [...parent, segment.part] : null;
}

interface AccessPathSegment {
  part: string;
  target: ts.Expression;
}

function accessPathSegment(value: ts.Expression): AccessPathSegment | null {
  if (ts.isPropertyAccessExpression(value)) {
    return { part: `.${value.name.text}`, target: value.expression };
  }
  if (!ts.isElementAccessExpression(value) || !value.argumentExpression) {
    return null;
  }
  const key = unwrapTransparentExpression(value.argumentExpression);
  if (ts.isStringLiteralLike(key)) {
    return { part: `[s:${key.text}]`, target: value.expression };
  }
  return ts.isNumericLiteral(key) ? { part: `[n:${key.text}]`, target: value.expression } : null;
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
    jsxElementCount(state.owner) >= LIST_SIZED_OWNER_JSX_ELEMENTS &&
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
  if (!usage || !usageAllowsKeyedScalarSelection(state, usage)) {
    return false;
  }
  const producer = repeatedScalarSelectionProducer(state, usage);
  const secondaryNodes = producer && secondaryRenderNodes(usage.directRenderNodes, state, producer);
  const secondaryReferences = secondaryNodes && secondaryLeafReferences(state, secondaryNodes);
  const renderReferences =
    secondaryReferences && secondaryRenderReferences(secondaryReferences, state);
  return (
    producer !== null &&
    renderReferences !== null &&
    consumerIsBoundedSibling(producer, renderReferences, state)
  );
}

function usageAllowsKeyedScalarSelection(state: StateCandidate, usage: StateUsage): boolean {
  return (
    hasSupportedKeyedSelectionInitializer(state) &&
    !stateMayHoldCallable(state) &&
    jsxElementCount(state.owner) >= LIST_SIZED_OWNER_JSX_ELEMENTS &&
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
    !usage.shadowed &&
    !usage.escaped &&
    hasOnlyEventCommandReads(state, new Set(usage.directRenderNodes))
  );
}

function secondaryRenderNodes(
  directRenderNodes: readonly ts.Node[],
  state: StateCandidate,
  producer: ts.CallExpression,
): ts.Node[] | null {
  const secondaryNodes: ts.Node[] = [];
  for (const node of directRenderNodes) {
    if (!isRepeatedScalarKeyProjection(node, state)) {
      secondaryNodes.push(node);
    } else if (nearestRepeatedRenderCall(node, state.owner) !== producer) {
      return null;
    }
  }
  return secondaryNodes;
}

function secondaryLeafReferences(
  state: StateCandidate,
  secondaryNodes: readonly ts.Node[],
): readonly ts.Identifier[] | null {
  return oneHopRenderProjectionReferences(
    state.owner,
    secondaryNodes,
    (initializer, reference) =>
      isPureExpression(initializer) ||
      (ts.isIdentifier(reference) && isSelectedItemLookup(initializer, reference)),
  );
}

function secondaryRenderReferences(
  references: readonly ts.Identifier[],
  state: StateCandidate,
): ts.Identifier[] | null {
  const renderReferences: ts.Identifier[] = [];
  for (const reference of references) {
    const kind = classifySecondaryReference(reference, state);
    if (kind === "unsafe") {
      return null;
    }
    if (kind === "render") {
      renderReferences.push(reference);
    }
  }
  return renderReferences;
}

type SecondaryReferenceKind = "deferred" | "render" | "unsafe";

function classifySecondaryReference(
  reference: ts.Identifier,
  state: StateCandidate,
): SecondaryReferenceKind {
  const callback = nearestNestedFunction(reference, state.owner);
  if (callback) {
    return (ts.isArrowFunction(callback) ||
      ts.isFunctionDeclaration(callback) ||
      ts.isFunctionExpression(callback)) &&
      callbackIsEventRooted(callback, state.owner, reference.text, new Set())
      ? "deferred"
      : "unsafe";
  }
  if (findAncestorUntil(reference, isJsxNode, state.owner)) {
    return isSafeSecondaryRenderReference(reference, state) ? "render" : "unsafe";
  }
  return isDeferredHookDependency(reference, state) ? "deferred" : "unsafe";
}

function isSafeSecondaryRenderReference(reference: ts.Identifier, state: StateCandidate): boolean {
  return (
    !nearestRepeatedRenderCall(reference, state.owner) &&
    !(
      isRenderGateReference(reference, state.owner) &&
      !findAncestorUntil(reference, ts.isJsxAttribute, state.owner)
    ) &&
    isSafeJsxProjectionReference(reference, state.owner, new Set(["cn"]))
  );
}

function isDeferredHookDependency(reference: ts.Identifier, state: StateCandidate): boolean {
  if (!isHookDependencyReference(reference, new Set(["useCallback"]))) {
    return false;
  }
  const call = findAncestorUntil(reference, ts.isCallExpression, state.owner);
  const candidate = call?.arguments[0];
  return (
    candidate !== undefined &&
    (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) &&
    callbackIsEventRooted(candidate, state.owner, reference.text, new Set())
  );
}

function consumerIsBoundedSibling(
  producer: ts.CallExpression,
  renderReferences: readonly ts.Identifier[],
  state: StateCandidate,
): boolean {
  const consumer = lowestCommonJsxSubtree(renderReferences, state.owner);
  const producerReturn = findAncestorUntil(producer, ts.isReturnStatement, state.owner);
  const consumerReturn = consumer
    ? findAncestorUntil(consumer, ts.isReturnStatement, state.owner)
    : null;
  return (
    consumer !== null &&
    jsxElementCountIn(consumer) / jsxElementCount(state.owner) <= MAX_CONSUMER_JSX_SHARE &&
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
  const { setterName } = state;
  if (!setterName) {
    return null;
  }
  const producers = new Set<ts.CallExpression>();
  for (const call of usage.setterCallNodes) {
    const repeated = keyedEventProducerCall(call, state, setterName);
    if (repeated) {
      producers.add(repeated);
    }
  }
  return producers.size === 1 ? [...producers][0]! : null;
}

function keyedEventProducerCall(
  call: ts.CallExpression,
  state: StateCandidate,
  setterName: string,
): ts.CallExpression | null {
  const repeated = nearestRepeatedRenderCall(call, state.owner);
  const callback = repeated?.arguments[0];
  const event = nearestNestedFunction(call, state.owner);
  const [argument] = call.arguments;
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
    !mutationRegionOnlyCallsStateSetters(event, new Set([setterName]))
  ) {
    return null;
  }
  return repeated;
}

function isSelectedItemLookup(initializer: ts.Expression, stateReference: ts.Identifier): boolean {
  const callback = nullCoalescedFindCallback(initializer);
  if (!callback || !comparesStateToItem(callback, stateReference)) {
    return false;
  }
  return identifierReadCount(initializer, stateReference.text) === 1;
}

function nullCoalescedFindCallback(
  initializer: ts.Expression,
): ts.ArrowFunction | ts.FunctionExpression | null {
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
    return null;
  }
  const [callback] = expression.arguments;
  return callback &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
    !ts.isBlock(callback.body) &&
    callback.parameters.length === 1
    ? callback
    : null;
}

function comparesStateToItem(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  stateReference: ts.Identifier,
): boolean {
  if (ts.isBlock(callback.body)) {
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
  const other = oppositeComparisonOperand(left, right, stateReference);
  return (
    other !== null && expressionDependsOnBinding(other, callback.parameters[0]!.name, callback)
  );
}

function identifierReadCount(node: ts.Node, name: string): number {
  let reads = 0;
  visit(node, (child) => {
    if (ts.isIdentifier(child) && child.text === name && !isNonValueIdentifier(child)) {
      reads += 1;
    }
  });
  return reads;
}

function isRepeatedScalarKeyProjection(node: ts.Node, state: StateCandidate): boolean {
  if (!ts.isIdentifier(node)) {
    return false;
  }
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
  return declaration?.initializer &&
    ts.isIdentifier(declaration.name) &&
    nodeWithin(node, declaration.initializer)
    ? aliasedKeyProjectionIsSafe({ callback, declaration, owner: state.owner, repeated })
    : isSafeKeyProjectionReference(node, callback);
}

function isSafeKeyProjectionReference(
  reference: ts.Identifier,
  callback: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  return (
    !isMembershipMountGate(reference, callback) &&
    findAncestorUntil(reference, isJsxNode, callback) !== null &&
    isSafeJsxProjectionReference(reference, callback, new Set(["cn"]))
  );
}

interface AliasedKeyProjection {
  callback: ts.ArrowFunction | ts.FunctionExpression;
  declaration: ts.VariableDeclaration;
  owner: RuntimeFunctionLike;
  repeated: ts.CallExpression;
}

function aliasedKeyProjectionIsSafe(projection: AliasedKeyProjection): boolean {
  const { callback, declaration, owner, repeated } = projection;
  if (
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(callback, declaration.name.text) !== 1
  ) {
    return false;
  }
  const references = bindingReferencesIn(callback, declaration.name, declaration.name.getText());
  return (
    references.length > 0 &&
    references.every(
      (reference) =>
        nearestRepeatedRenderCall(reference, owner) === repeated &&
        isSafeKeyProjectionReference(reference, callback),
    )
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
    const other = oppositeContainingOperand(current, node);
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
  const directCollection = isSetOrMapState(state.call);
  const arraySetAlias = directCollection ? null : localSetAliasForArrayState(state);
  if (
    (!directCollection && !arraySetAlias) ||
    jsxElementCount(state.owner) < LIST_SIZED_OWNER_JSX_ELEMENTS
  ) {
    return false;
  }
  return collectionReadsAreKeyedMembership({
    aliasName: arraySetAlias?.declaration.name.getText() ?? null,
    arraySetAlias,
    state,
  });
}

interface CollectionReadContext {
  aliasName: string | null;
  arraySetAlias: ArraySetAlias | null;
  state: StateCandidate;
}

type CollectionReadOutcome = "ignored" | "membership" | "unsafe";

function collectionReadsAreKeyedMembership(context: CollectionReadContext): boolean {
  let repeatedMembership = false;
  let unsafe = false;
  visit(context.state.owner.body, (node) => {
    if (unsafe || !isKeyedCollectionRead(node, context)) {
      return;
    }
    const outcome = classifyKeyedCollectionRead(node, context);
    if (outcome === "unsafe") {
      unsafe = true;
    } else if (outcome === "membership") {
      repeatedMembership = true;
    }
  });
  return repeatedMembership && !unsafe;
}

function isKeyedCollectionRead(
  node: ts.Node,
  context: CollectionReadContext,
): node is ts.Identifier {
  const { aliasName, arraySetAlias, state } = context;
  return (
    ts.isIdentifier(node) &&
    (node.text === state.valueName || node.text === aliasName) &&
    !isDeclarationName(node) &&
    !isNonValueIdentifier(node) &&
    !(arraySetAlias !== null && node === arraySetAlias.stateSource)
  );
}

function classifyKeyedCollectionRead(
  node: ts.Identifier,
  context: CollectionReadContext,
): CollectionReadOutcome {
  const { arraySetAlias, state } = context;
  const property =
    ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
      ? node.parent
      : null;
  if (arraySetAlias && node.text === state.valueName) {
    return classifyAliasedArrayRead(node, property, state.owner);
  }
  if (property && KEYED_COLLECTION_PROPERTIES.has(property.name.text)) {
    return classifyCollectionPropertyRead(property, state);
  }
  return classifyPlainCollectionRead(node, state.owner);
}

function classifyAliasedArrayRead(
  node: ts.Identifier,
  property: ts.PropertyAccessExpression | null,
  owner: RuntimeFunctionLike,
): CollectionReadOutcome {
  if (property?.name.text === "length") {
    return collectionSummaryControlsRepeatedRendering(property, owner) ? "unsafe" : "ignored";
  }
  return isDeferredCollectionRead(node, owner) ||
    isHookDependencyReference(node, MEMO_CALLBACK_HOOKS) ||
    isListExtraDataReference(node, owner)
    ? "ignored"
    : "unsafe";
}

function classifyCollectionPropertyRead(
  property: ts.PropertyAccessExpression,
  state: StateCandidate,
): CollectionReadOutcome {
  if (property.name.text === "size") {
    return collectionSummaryControlsRepeatedRendering(property, state.owner) ? "unsafe" : "ignored";
  }
  if (["entries", "keys", "values"].includes(property.name.text)) {
    return "ignored";
  }
  if (
    property.name.text !== "has" ||
    !ts.isCallExpression(property.parent) ||
    property.parent.expression !== property
  ) {
    return "unsafe";
  }
  return classifyMembershipCall(property.parent, state);
}

function classifyMembershipCall(
  membershipCall: ts.CallExpression,
  state: StateCandidate,
): CollectionReadOutcome {
  const summaryCall = collectionMembershipSummaryCall(membershipCall, state.owner);
  if (summaryCall) {
    return collectionSummaryControlsRepeatedRendering(summaryCall, state.owner)
      ? "unsafe"
      : "ignored";
  }
  if (isBoundedFilteredSelectionSummary(membershipCall, state)) {
    return "ignored";
  }
  if (
    !isRepeatedMembershipRender(membershipCall, state.owner) ||
    membershipControlsRepeatedMount(membershipCall, state.owner)
  ) {
    return "unsafe";
  }
  return "membership";
}

function classifyPlainCollectionRead(
  node: ts.Identifier,
  owner: RuntimeFunctionLike,
): CollectionReadOutcome {
  return ts.isSpreadElement(node.parent) ||
    (isCollectionCopyArgument(node) && isDeferredCollectionRead(node, owner)) ||
    isHookDependencyReference(node, MEMO_CALLBACK_HOOKS) ||
    isListExtraDataReference(node, owner)
    ? "ignored"
    : "unsafe";
}

function isBoundedFilteredSelectionSummary(
  membership: ts.CallExpression,
  state: StateCandidate,
): boolean {
  const alias = filteredSelectionAlias(membership, state);
  if (!alias) {
    return false;
  }
  const references = bindingReferencesIn(state.owner, alias, alias.text);
  const gate = boundedRenderGate(references, state.owner);
  return (
    gate !== null &&
    references.length > 0 &&
    references.every((reference) => isBoundedSummaryUse(reference, gate, state.owner))
  );
}

function filteredSelectionAlias(
  membership: ts.CallExpression,
  state: StateCandidate,
): ts.Identifier | null {
  const callback = nearestNestedFunction(membership, state.owner);
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    ts.isBlock(callback.body) ||
    unwrapTransparentExpression(callback.body) !== membership ||
    !membershipUsesCallbackKey(membership, callback)
  ) {
    return null;
  }
  const filter = callback.parent;
  if (
    !ts.isCallExpression(filter) ||
    !filter.arguments.includes(callback) ||
    !ts.isPropertyAccessExpression(filter.expression) ||
    filter.expression.name.text !== "filter" ||
    !ts.isIdentifier(unwrapTransparentExpression(filter.expression.expression))
  ) {
    return null;
  }
  const declaration = filter.parent;
  return ts.isVariableDeclaration(declaration) &&
    declaration.initializer === filter &&
    ts.isIdentifier(declaration.name) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
    bindingDeclarationCount(state.owner, declaration.name.text) === 1
    ? declaration.name
    : null;
}

function boundedRenderGate(
  references: readonly ts.Identifier[],
  owner: RuntimeFunctionLike,
): JsxSubtreeNode | null {
  const gates = new Set(
    references.flatMap((reference) => {
      const gate = commonRenderGateSubtree([reference], owner);
      return gate ? [gate] : [];
    }),
  );
  const gate = gates.size === 1 ? [...gates][0]! : null;
  return gate && jsxElementCountIn(gate) / jsxElementCount(owner) <= MAX_CONSUMER_JSX_SHARE
    ? gate
    : null;
}

function isBoundedSummaryUse(
  reference: ts.Identifier,
  gate: JsxSubtreeNode,
  owner: RuntimeFunctionLike,
): boolean {
  const property =
    ts.isPropertyAccessExpression(reference.parent) && reference.parent.expression === reference
      ? reference.parent
      : null;
  if (property?.name.text === "length") {
    return commonRenderGateSubtree([reference], owner) === gate;
  }
  if (
    property?.name.text !== "map" ||
    !ts.isCallExpression(property.parent) ||
    property.parent.expression !== property ||
    !nodeWithin(reference, gate)
  ) {
    return false;
  }
  const [row] = property.parent.arguments;
  return (
    row !== undefined &&
    (ts.isArrowFunction(row) || ts.isFunctionExpression(row)) &&
    repeatedRenderHasStableItemKey(row)
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
  if (!owner.body || nearestRepeatedRenderCall(summary, owner)) {
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
  const references = summaryAliasReferences(owner, declaration.name);
  return references.some((reference) => referenceControlsRepeatedRendering(reference, owner));
}

function summaryAliasReferences(
  owner: RuntimeFunctionLike,
  declarationName: ts.Identifier,
): ts.Identifier[] {
  const references: ts.Identifier[] = [];
  const name = declarationName.getText();
  visit(owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === name &&
      node !== declarationName &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return references;
}

function referenceControlsRepeatedRendering(node: ts.Node, owner: RuntimeFunctionLike): boolean {
  const repeated = nearestRepeatedRenderCall(node, owner);
  if (repeated) {
    const [callback] = repeated.arguments;
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
  const projectionName = declaration.name.text;
  const references: ts.Identifier[] = [];
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
  const repeated = nearestRepeatedRenderCall(call, owner);
  const callback = repeated?.arguments[0] ?? renderedListCallback(call, owner);
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
  const [argument] = call.arguments;
  const parameter = callback.parameters[0]?.name;
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
  const initializer = callback.parent;
  const declaration =
    ts.isCallExpression(initializer) &&
    ts.isIdentifier(initializer.expression) &&
    initializer.expression.text === "useCallback"
      ? initializer.parent
      : callback.parent;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) {
    return null;
  }
  // SAFETY: Reaching this branch requires a variable declaration initialized
  // It is initialized directly by this callback or by a useCallback call containing it.
  return bindingIsRenderItemAttribute(owner, declaration.name.text)
    ? (callback as ts.ArrowFunction | ts.FunctionExpression)
    : null;
}

function bindingIsRenderItemAttribute(owner: RuntimeFunctionLike, bindingName: string): boolean {
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
  return rendered;
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
  const repeated = nearestRepeatedRenderCall(call, owner);
  const callback = repeated?.arguments[0] ?? renderedListCallback(call, owner);
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return true;
  }
  const declaration = findAncestorUntil(call, ts.isVariableDeclaration, callback);
  return declaration &&
    ts.isIdentifier(declaration.name) &&
    declaration.initializer &&
    nodeWithin(call, declaration.initializer)
    ? aliasedMembershipGatesMount(declaration.name, callback)
    : isMembershipMountGate(call, callback);
}

function aliasedMembershipGatesMount(
  declarationName: ts.Identifier,
  callback: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  const aliasName = declarationName.text;
  const references: ts.Identifier[] = [];
  visitSkippingNestedFunctions(callback.body, callback, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === aliasName &&
      node !== declarationName &&
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

function hookCallRootIdentifier(call: ts.CallExpression): ts.Identifier | null {
  if (ts.isIdentifier(call.expression)) {
    return call.expression;
  }
  return ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression)
    ? call.expression.expression
    : null;
}

function memoizedCallbackName(declaration: ts.Node): string | null {
  if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
    return declaration.name.text;
  }
  return ts.isCallExpression(declaration) &&
    ts.isVariableDeclaration(declaration.parent) &&
    ts.isIdentifier(declaration.parent.name)
    ? declaration.parent.name.text
    : null;
}

function jsxOpeningOf(node: ts.Node): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  if (ts.isJsxElement(node)) {
    return node.openingElement;
  }
  return ts.isJsxSelfClosingElement(node) ? node : null;
}

function oppositeComparisonOperand(
  left: ts.Expression,
  right: ts.Expression,
  reference: ts.Node,
): ts.Expression | null {
  if (left === reference) {
    return right;
  }
  return right === reference ? left : null;
}

function oppositeContainingOperand(
  comparison: ts.BinaryExpression,
  node: ts.Node,
): ts.Expression | null {
  if (nodeWithin(node, comparison.left)) {
    return comparison.right;
  }
  return nodeWithin(node, comparison.right) ? comparison.left : null;
}
