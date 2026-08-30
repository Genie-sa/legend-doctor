import type { StateCandidate, StateUsage } from "../analyze-source.js";
import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
  isPureExpression,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import {
  findAncestorUntil,
  nodeWithin,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../ast.js";
import {
  hasIndependentRenderCutWitness,
  hasOnlyEventCommandReads,
  isSafeJsxProjectionReference,
  jsxElementCount,
  jsxElementCountIn,
  stateMayHoldCallable,
} from "./state-proofs.js";
import type { ChildContractResolver } from "./child-contract.js";
import type { RuntimeFunctionLike } from "../ast.js";
import { isRenderGateReference } from "./deferred-reveal.js";
import ts from "typescript";

export interface ObjectDraftProofs {
  childContracts: ChildContractResolver | null;
  eventCallbacks: ReadonlySet<RuntimeFunctionLike>;
  hasCompanionWrites: boolean;
  hasReactiveMutationPath: boolean;
  hasSafeCommands: boolean;
  localComponents: ReadonlySet<string>;
  sourceComponents: ReadonlySet<string>;
}

interface PropertyWrite {
  property: string;
}

interface DraftSeed {
  readonly object: ts.ObjectLiteralExpression;
  readonly typeName: string;
}

interface SpreadUpdater {
  readonly object: ts.ObjectLiteralExpression;
  readonly previous: string;
}

const MINIMUM_OWNER_JSX_ELEMENTS = 12;
const MINIMUM_DRAFT_SETTER_CALLS = 2;
const MINIMUM_INDEPENDENT_SINKS = 2;
const MINIMUM_LEAF_JSX_ELEMENTS = 4;
const LEAF_JSX_ELEMENT_FRACTION = 0.4;
const MINIMUM_DRAFT_PROPERTIES = 2;
const MAXIMUM_DRAFT_PROPERTIES = 8;
const SPREAD_UPDATE_PROPERTY_COUNT = 2;
const MAXIMUM_PROJECTION_HOPS = 4;

/** Proves a typed string draft whose controlled fields can subscribe independently. */
export function isPropertyLocalObjectDraftState(
  state: StateCandidate,
  usage: StateUsage,
  proofs: ObjectDraftProofs,
): boolean {
  if (!usageAdmitsPropertyLocalDraft(state, usage, proofs)) {
    return false;
  }
  const properties = typedStringDraftProperties(state);
  if (!properties || usage.setterCalls !== properties.size) {
    return false;
  }
  const writes = usage.setterCallNodes.map((call) =>
    exactPropertyWrite(call, state, proofs.childContracts),
  );
  if (
    !writesCoverProperties(writes, properties) ||
    !readsAreDirectPropertyAccesses(state, properties) ||
    !hasOnlyEventCommandReads(state, new Set(usage.directRenderNodes), proofs.eventCallbacks)
  ) {
    return false;
  }
  return hasIndependentSinkWitness(
    proofs,
    independentDraftSinks(state, usage.directRenderNodes, properties),
    state.owner,
  );
}

function usageAdmitsPropertyLocalDraft(
  state: StateCandidate,
  usage: StateUsage,
  proofs: ObjectDraftProofs,
): boolean {
  if (
    !state.setterName ||
    !state.owner.body ||
    jsxElementCount(state.owner) < MINIMUM_OWNER_JSX_ELEMENTS ||
    usage.localRenderReads === 0 ||
    usage.localRenderReads !== usage.directRenderNodes.length ||
    usage.deferredReads === 0 ||
    usage.effectReads !== 0 ||
    usage.effectWrites !== 0 ||
    usage.transportedOccurrences !== 0 ||
    usage.setterCalls < MINIMUM_DRAFT_SETTER_CALLS ||
    usage.setterReferences !== usage.setterCalls ||
    usage.shadowed ||
    usage.escaped ||
    proofs.hasCompanionWrites ||
    proofs.hasReactiveMutationPath ||
    !proofs.hasSafeCommands ||
    stateMayHoldCallable(state)
  ) {
    return false;
  }
  return true;
}

function writesCoverProperties(
  writes: readonly (PropertyWrite | null)[],
  properties: ReadonlySet<string>,
): boolean {
  return !(
    writes.some((write) => write === null) ||
    new Set(writes.map((write) => write?.property)).size !== properties.size ||
    writes.some((write) => !write || !properties.has(write.property))
  );
}

function readsAreDirectPropertyAccesses(
  state: StateCandidate,
  properties: ReadonlySet<string>,
): boolean {
  const references = stateReferences(state);
  return (
    references.length > 0 &&
    !references.some((reference) => {
      const access = directPropertyAccess(reference);
      return !access || !properties.has(access.name.text);
    })
  );
}

function independentDraftSinks(
  state: StateCandidate,
  directRenderNodes: readonly ts.Node[],
  properties: ReadonlySet<string>,
): readonly ts.Node[] | null {
  const sinks: ts.Node[] = [];
  for (const node of directRenderNodes) {
    const resolved = ts.isIdentifier(node) ? projectionSinks(state, node, properties) : null;
    if (!resolved || !collectLeafSinks(state, resolved, sinks)) {
      return null;
    }
  }
  return sinks;
}

function collectLeafSinks(
  state: StateCandidate,
  references: readonly ts.Identifier[],
  sinks: ts.Node[],
): boolean {
  const maximumLeafSize = Math.max(
    MINIMUM_LEAF_JSX_ELEMENTS,
    Math.floor(jsxElementCount(state.owner) * LEAF_JSX_ELEMENT_FRACTION),
  );
  for (const reference of references) {
    const subtree = nearestJsxElement(reference, state.owner);
    if (!subtree || jsxElementCountIn(subtree) > maximumLeafSize) {
      return false;
    }
    if (!sinks.includes(subtree)) {
      sinks.push(subtree);
    }
  }
  return true;
}

function hasIndependentSinkWitness(
  proofs: ObjectDraftProofs,
  sinks: readonly ts.Node[] | null,
  owner: RuntimeFunctionLike,
): boolean {
  const returned = uniqueReturnedExpression(owner);
  return (
    sinks !== null &&
    returned !== null &&
    sinks.length >= MINIMUM_INDEPENDENT_SINKS &&
    hasIndependentRenderCutWitness({
      returned,
      excluded: sinks,
      localComponents: proofs.localComponents,
      sourceComponents: proofs.sourceComponents,
    })
  );
}

function typedStringDraftProperties(state: StateCandidate): ReadonlySet<string> | null {
  const seed = draftSeedDeclaration(state);
  if (!seed) {
    return null;
  }
  const names = draftTypeStringProperties(state, seed.typeName, seed.object.properties.length);
  return names && seededPropertiesMatchNames(seed.object, names) ? names : null;
}

function draftSeedDeclaration(state: StateCandidate): DraftSeed | null {
  const [initialArgument] = state.call.arguments;
  const initial = initialArgument && unwrapTransparentExpression(initialArgument);
  if (!initial || !ts.isIdentifier(initial)) {
    return null;
  }
  const declarations = moduleVariableDeclarations(state.call.getSourceFile(), initial.text);
  const declaration = declarations.length === 1 ? declarations[0] : null;
  const object = declaration?.initializer && unwrapTransparentExpression(declaration.initializer);
  if (
    !declaration?.type ||
    !ts.isTypeReferenceNode(declaration.type) ||
    !ts.isIdentifier(declaration.type.typeName) ||
    !object ||
    !ts.isObjectLiteralExpression(object) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    object.properties.length < MINIMUM_DRAFT_PROPERTIES ||
    object.properties.length > MAXIMUM_DRAFT_PROPERTIES ||
    !moduleConstantOnlySeedsState(state, declaration, initial.text)
  ) {
    return null;
  }
  return { object, typeName: declaration.type.typeName.text };
}

function moduleVariableDeclarations(
  sourceFile: ts.SourceFile,
  name: string,
): readonly ts.VariableDeclaration[] {
  const declarations: ts.VariableDeclaration[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        declarations.push(declaration);
      }
    }
  }
  return declarations;
}

function draftTypeStringProperties(
  state: StateCandidate,
  typeName: string,
  propertyCount: number,
): ReadonlySet<string> | null {
  const types = state.call
    .getSourceFile()
    .statements.filter(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === typeName,
    );
  const type = types.length === 1 ? types[0] : null;
  if (
    !type ||
    type.members.length !== propertyCount ||
    type.members.some((member) => !isRequiredStringPropertySignature(member))
  ) {
    return null;
  }
  const names = new Set(
    type.members.map((member) =>
      // SAFETY: Every member passed isRequiredStringPropertySignature above, so each
      // PropertySignature here has a statically named property.
      (member as ts.PropertySignature).name.getText().replaceAll(/^['"]|['"]$/gu, ""),
    ),
  );
  return names.size === type.members.length ? names : null;
}

function isRequiredStringPropertySignature(member: ts.TypeElement): boolean {
  return (
    ts.isPropertySignature(member) &&
    member.questionToken === undefined &&
    member.type?.kind === ts.SyntaxKind.StringKeyword &&
    member.name !== undefined &&
    (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name))
  );
}

function seededPropertiesMatchNames(
  object: ts.ObjectLiteralExpression,
  names: ReadonlySet<string>,
): boolean {
  return object.properties.every((property) => {
    if (
      !ts.isPropertyAssignment(property) ||
      (!ts.isIdentifier(property.name) && !ts.isStringLiteralLike(property.name))
    ) {
      return false;
    }
    return (
      names.has(property.name.text) &&
      ts.isStringLiteralLike(unwrapTransparentExpression(property.initializer))
    );
  });
}

function moduleConstantOnlySeedsState(
  state: StateCandidate,
  declaration: ts.VariableDeclaration,
  name: string,
): boolean {
  let safe = true;
  visit(state.call.getSourceFile(), (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      node === declaration.name ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (isDeclarationName(node)) {
      safe = false;
      return;
    }
    const call = node.parent;
    safe =
      ts.isCallExpression(call) &&
      call.arguments[0] === node &&
      call.expression.getText() === state.call.expression.getText();
  });
  return safe;
}

function exactPropertyWrite(
  call: ts.CallExpression,
  state: StateCandidate,
  childContracts: ChildContractResolver | null,
): PropertyWrite | null {
  const property = singleSpreadWriteProperty(call);
  if (property === null) {
    return null;
  }
  const opening = deferredSetterOnlyOpening(call, state.owner, childContracts);
  return opening && openingReadsProperty(opening, state.valueName, property) ? { property } : null;
}

function spreadUpdater(call: ts.CallExpression): SpreadUpdater | null {
  if (call.arguments.length !== 1) {
    return null;
  }
  const updater = unwrapTransparentExpression(call.arguments[0]!);
  if (
    (!ts.isArrowFunction(updater) && !ts.isFunctionExpression(updater)) ||
    updater.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    updater.parameters.length !== 1 ||
    !ts.isIdentifier(updater.parameters[0]!.name) ||
    ts.isBlock(updater.body)
  ) {
    return null;
  }
  const object = unwrapTransparentExpression(updater.body);
  return ts.isObjectLiteralExpression(object) &&
    object.properties.length === SPREAD_UPDATE_PROPERTY_COUNT
    ? { object, previous: updater.parameters[0]!.name.text }
    : null;
}

function singleSpreadWriteProperty(call: ts.CallExpression): string | null {
  const updater = spreadUpdater(call);
  if (!updater) {
    return null;
  }
  const [spread, assignment] = updater.object.properties;
  const spreadValue =
    spread && ts.isSpreadAssignment(spread) ? unwrapTransparentExpression(spread.expression) : null;
  if (
    !spreadValue ||
    !ts.isIdentifier(spreadValue) ||
    spreadValue.text !== updater.previous ||
    !assignment ||
    !ts.isPropertyAssignment(assignment) ||
    (!ts.isIdentifier(assignment.name) && !ts.isStringLiteralLike(assignment.name)) ||
    !isPureExpression(assignment.initializer) ||
    bindingIsReferenced(assignment.initializer, updater.previous)
  ) {
    return null;
  }
  return assignment.name.text;
}

function deferredSetterOnlyOpening(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
  childContracts: ChildContractResolver | null,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const attribute = inlineEventHandlerAttribute(call, owner);
  if (!attribute) {
    return null;
  }
  const opening = attribute.parent.parent;
  if (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) {
    return null;
  }
  const component = opening.tagName.getText();
  if (/^[a-z]/u.test(component)) {
    return opening;
  }
  return childContracts &&
    (childContracts.frameworkEventComponent(component) ||
      childContracts.componentCallbackPropIsDeferred(component, attribute.name.getText()))
    ? opening
    : null;
}

function inlineEventHandlerAttribute(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
): ts.JsxAttribute | null {
  const attribute = findAncestorUntil(call, ts.isJsxAttribute, owner);
  const expression =
    attribute?.initializer && ts.isJsxExpression(attribute.initializer)
      ? attribute.initializer.expression
      : null;
  if (
    !attribute ||
    !/^on[A-Z]/u.test(attribute.name.getText()) ||
    !expression ||
    (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) ||
    ts.isBlock(expression.body) ||
    unwrapTransparentExpression(expression.body) !== call
  ) {
    return null;
  }
  return attribute;
}

function openingReadsProperty(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  stateName: string,
  property: string,
): boolean {
  return opening.attributes.properties.some((candidate) => {
    const expression =
      ts.isJsxAttribute(candidate) &&
      candidate.name.getText() === "value" &&
      candidate.initializer &&
      ts.isJsxExpression(candidate.initializer)
        ? candidate.initializer.expression
        : null;
    const access = expression && unwrapTransparentExpression(expression);
    return (
      access !== null &&
      access !== undefined &&
      ts.isPropertyAccessExpression(access) &&
      ts.isIdentifier(unwrapTransparentExpression(access.expression)) &&
      access.expression.getText() === stateName &&
      access.name.text === property
    );
  });
}

function stateReferences(state: StateCandidate): ts.Identifier[] {
  const references: ts.Identifier[] = [];
  visit(state.owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === state.valueName &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node) &&
      node.parent !== state.call.parent
    ) {
      references.push(node);
    }
  });
  return references;
}

function directPropertyAccess(node: ts.Identifier): ts.PropertyAccessExpression | null {
  return ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
    ? node.parent
    : null;
}

function bindingIsReferenced(node: ts.Node, name: string): boolean {
  let referenced = false;
  visit(node, (candidate) => {
    if (
      ts.isIdentifier(candidate) &&
      candidate.text === name &&
      !isDeclarationName(candidate) &&
      !isNonValueIdentifier(candidate)
    ) {
      referenced = true;
    }
  });
  return referenced;
}

function projectionSinks(
  state: StateCandidate,
  initial: ts.Identifier,
  stringProperties: ReadonlySet<string>,
): readonly ts.Identifier[] | null {
  let references: readonly ts.Identifier[] = [initial];
  for (let hop = 0; hop < MAXIMUM_PROJECTION_HOPS; hop += 1) {
    if (references.every((reference) => nearestJsxElement(reference, state.owner))) {
      return references.every(
        (reference) =>
          !isRenderGateReference(reference, state.owner) &&
          isSafeJsxProjectionReference(reference, state.owner),
      )
        ? references
        : null;
    }
    const next = projectionHopReferences(state, references, stringProperties);
    if (!next) {
      return null;
    }
    references = next;
  }
  return null;
}

function projectionHopReferences(
  state: StateCandidate,
  references: readonly ts.Identifier[],
  stringProperties: ReadonlySet<string>,
): readonly ts.Identifier[] | null {
  const declarations = new Set(
    references.map((reference) =>
      findAncestorUntil(reference, ts.isVariableDeclaration, state.owner),
    ),
  );
  const declaration = declarations.size === 1 ? [...declarations][0] : null;
  if (
    !declaration?.initializer ||
    !ts.isIdentifier(declaration.name) ||
    !references.every((reference) => nodeWithin(reference, declaration.initializer!)) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(state.owner, declaration.name.text) !== 1 ||
    !isPureExpression(declaration.initializer, (call) =>
      safeStringTrim(call, state.valueName, stringProperties),
    )
  ) {
    return null;
  }
  const next = bindingReferences(state.owner, declaration.name);
  return next.length === 0 ? null : next;
}

function safeStringTrim(
  call: ts.CallExpression,
  stateName: string,
  stringProperties: ReadonlySet<string>,
): boolean {
  const callee = call.expression;
  const receiver = ts.isPropertyAccessExpression(callee)
    ? unwrapTransparentExpression(callee.expression)
    : null;
  return (
    call.arguments.length === 0 &&
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "trim" &&
    receiver !== null &&
    ts.isPropertyAccessExpression(receiver) &&
    ts.isIdentifier(unwrapTransparentExpression(receiver.expression)) &&
    receiver.expression.getText() === stateName &&
    stringProperties.has(receiver.name.text)
  );
}

function bindingReferences(owner: RuntimeFunctionLike, binding: ts.Identifier): ts.Identifier[] {
  const references: ts.Identifier[] = [];
  visit(owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node !== binding &&
      node.text === binding.text &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return references;
}

function nearestJsxElement(
  node: ts.Node,
  owner: RuntimeFunctionLike,
): ts.JsxElement | ts.JsxSelfClosingElement | null {
  return findAncestorUntil(
    node,
    (candidate): candidate is ts.JsxElement | ts.JsxSelfClosingElement =>
      ts.isJsxElement(candidate) || ts.isJsxSelfClosingElement(candidate),
    owner,
  );
}

function uniqueReturnedExpression(owner: RuntimeFunctionLike): ts.Expression | null {
  if (!owner.body) {
    return null;
  }
  if (!ts.isBlock(owner.body)) {
    return owner.body;
  }
  const returns: ts.Expression[] = [];
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (ts.isReturnStatement(node) && node.expression) {
      returns.push(node.expression);
    }
  });
  return returns.length === 1 ? returns[0]! : null;
}
