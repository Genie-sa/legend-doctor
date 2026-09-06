import {
  bindingDeclarationCount,
  isControlledInteractionProp,
  isDeclarationName,
  isDirectJsxAttributeExpression,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import {
  expressionDependsOnBinding,
  uniqueVariableDeclaration,
} from "../state-proofs/binding-lookup.js";
import {
  findAncestorUntil,
  nodeWithin,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../../core/ast.js";
import type { ArraySetAlias } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateCandidate } from "../../analysis/model.js";
import { isArrayState } from "./state-value-shapes.js";
import { nearestRepeatedRenderCall } from "../state-proofs/jsx-subtrees.js";
import ts from "typescript";

export function localSetAliasForArrayState(state: StateCandidate): ArraySetAlias | null {
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

export function bindingReferencesIn(
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
