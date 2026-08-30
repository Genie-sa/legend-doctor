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
  nodeWithin,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../ast.js";
import type { StateCandidate, StateUsage } from "../analyze-source.js";
import type { ChildContractResolver } from "./child-contract.js";
import { isRenderGateReference } from "./deferred-reveal.js";
import {
  hasIndependentRenderCutWitness,
  hasOnlyEventCommandReads,
  isSafeJsxProjectionReference,
  jsxElementCount,
  jsxElementCountIn,
  stateMayHoldCallable,
} from "./state-proofs.js";
import type { RuntimeFunctionLike } from "../ast.js";

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

/** Proves a typed string draft whose controlled fields can subscribe independently. */
export function isPropertyLocalObjectDraftState(
  state: StateCandidate,
  usage: StateUsage,
  proofs: ObjectDraftProofs,
): boolean {
  if (
    !state.setterName ||
    !state.owner.body ||
    jsxElementCount(state.owner) < 12 ||
    usage.localRenderReads === 0 ||
    usage.localRenderReads !== usage.directRenderNodes.length ||
    usage.deferredReads === 0 ||
    usage.effectReads !== 0 ||
    usage.effectWrites !== 0 ||
    usage.transportedOccurrences !== 0 ||
    usage.setterCalls < 2 ||
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

  const properties = typedStringDraftProperties(state);
  if (!properties || usage.setterCalls !== properties.size) {
    return false;
  }

  const writes = usage.setterCallNodes.map((call) =>
    exactPropertyWrite(call, state, proofs.childContracts),
  );
  if (
    writes.some((write) => write === null) ||
    new Set(writes.map((write) => write?.property)).size !== properties.size ||
    writes.some((write) => !write || !properties.has(write.property))
  ) {
    return false;
  }

  const references = stateReferences(state);
  if (
    references.length === 0 ||
    references.some((reference) => {
      const access = directPropertyAccess(reference);
      return !access || !properties.has(access.name.text);
    }) ||
    !hasOnlyEventCommandReads(state, new Set(usage.directRenderNodes), proofs.eventCallbacks)
  ) {
    return false;
  }

  const sinks: ts.Node[] = [];
  for (const node of usage.directRenderNodes) {
    if (!ts.isIdentifier(node)) {
      return false;
    }
    const resolved = projectionSinks(state, node, properties);
    if (!resolved) {
      return false;
    }
    for (const reference of resolved) {
      const subtree = nearestJsxElement(reference, state.owner),
        maximumLeafSize = Math.max(4, Math.floor(jsxElementCount(state.owner) * 0.4));
      if (!subtree || jsxElementCountIn(subtree) > maximumLeafSize) {
        return false;
      }
      if (!sinks.includes(subtree)) {
        sinks.push(subtree);
      }
    }
  }

  const returned = uniqueReturnedExpression(state.owner);
  return (
    returned !== null &&
    sinks.length >= 2 &&
    hasIndependentRenderCutWitness(returned, sinks, proofs.localComponents, proofs.sourceComponents)
  );
}

function typedStringDraftProperties(state: StateCandidate): ReadonlySet<string> | null {
  const initial = state.call.arguments[0] && unwrapTransparentExpression(state.call.arguments[0]!);
  if (!initial || !ts.isIdentifier(initial)) {
    return null;
  }

  const declarations: ts.VariableDeclaration[] = [];
  for (const statement of state.call.getSourceFile().statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === initial.text) {
        declarations.push(declaration);
      }
    }
  }
  const declaration = declarations.length === 1 ? declarations[0] : null,
    object = declaration?.initializer && unwrapTransparentExpression(declaration.initializer);
  if (
    !declaration?.type ||
    !ts.isTypeReferenceNode(declaration.type) ||
    !ts.isIdentifier(declaration.type.typeName) ||
    !object ||
    !ts.isObjectLiteralExpression(object) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    object.properties.length < 2 ||
    object.properties.length > 8 ||
    !moduleConstantOnlySeedsState(state, declaration, initial.text)
  ) {
    return null;
  }

  const typeName = declaration.type.typeName.text,
    types = state.call
      .getSourceFile()
      .statements.filter(
        (statement): statement is ts.InterfaceDeclaration =>
          ts.isInterfaceDeclaration(statement) && statement.name.text === typeName,
      ),
    type = types.length === 1 ? types[0] : null;
  if (
    !type ||
    type.members.length !== object.properties.length ||
    type.members.some(
      (member) =>
        !ts.isPropertySignature(member) ||
        member.questionToken !== undefined ||
        member.type?.kind !== ts.SyntaxKind.StringKeyword ||
        !member.name ||
        (!ts.isIdentifier(member.name) && !ts.isStringLiteralLike(member.name)),
    )
  ) {
    return null;
  }

  const names = new Set(
    type.members.map((member) =>
      // SAFETY: The preceding every-member check proves each member is a
      // PropertySignature with a statically named property.
      (member as ts.PropertySignature).name.getText().replaceAll(/^['"]|['"]$/gu, ""),
    ),
  );
  if (names.size !== type.members.length) {
    return null;
  }
  for (const property of object.properties) {
    if (
      !ts.isPropertyAssignment(property) ||
      (!ts.isIdentifier(property.name) && !ts.isStringLiteralLike(property.name)) ||
      !names.has(property.name.text) ||
      !ts.isStringLiteralLike(unwrapTransparentExpression(property.initializer))
    ) {
      return null;
    }
  }
  return names;
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
  const previous = updater.parameters[0]!.name.text,
    object = unwrapTransparentExpression(updater.body);
  if (!ts.isObjectLiteralExpression(object) || object.properties.length !== 2) {
    return null;
  }
  const [spread, assignment] = object.properties,
    spreadValue =
      spread && ts.isSpreadAssignment(spread)
        ? unwrapTransparentExpression(spread.expression)
        : null;
  if (
    !spreadValue ||
    !ts.isIdentifier(spreadValue) ||
    spreadValue.text !== previous ||
    !assignment ||
    !ts.isPropertyAssignment(assignment) ||
    (!ts.isIdentifier(assignment.name) && !ts.isStringLiteralLike(assignment.name)) ||
    !isPureExpression(assignment.initializer) ||
    bindingIsReferenced(assignment.initializer, previous)
  ) {
    return null;
  }

  const opening = deferredSetterOnlyOpening(call, state.owner, childContracts);
  return opening && openingReadsProperty(opening, state.valueName, assignment.name.text)
    ? { property: assignment.name.text }
    : null;
}

function deferredSetterOnlyOpening(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
  childContracts: ChildContractResolver | null,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const attribute = findAncestorUntil(call, ts.isJsxAttribute, owner),
    expression =
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
          : null,
      access = expression && unwrapTransparentExpression(expression);
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
  for (let hop = 0; hop < 4; hop += 1) {
    if (references.every((reference) => nearestJsxElement(reference, state.owner))) {
      return references.every(
        (reference) =>
          !isRenderGateReference(reference, state.owner) &&
          isSafeJsxProjectionReference(reference, state.owner),
      )
        ? references
        : null;
    }

    const declarations = new Set(
        references.map((reference) =>
          findAncestorUntil(reference, ts.isVariableDeclaration, state.owner),
        ),
      ),
      declaration = declarations.size === 1 ? [...declarations][0] : null;
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
    references = bindingReferences(state.owner, declaration.name);
    if (references.length === 0) {
      return null;
    }
  }
  return null;
}

function safeStringTrim(
  call: ts.CallExpression,
  stateName: string,
  stringProperties: ReadonlySet<string>,
): boolean {
  const callee = call.expression,
    receiver = ts.isPropertyAccessExpression(callee)
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
