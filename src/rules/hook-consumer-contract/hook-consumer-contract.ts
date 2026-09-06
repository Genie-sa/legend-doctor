import { EMPTY_NODES, SMALL_OWNER_JSX_ELEMENTS } from "../../analysis/constants.js";
import type {
  HookPresentationConsumer,
  HookReturnMember,
  HookReturnMembers,
} from "../child-contract/model.js";
import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import {
  findAncestor,
  findAncestorUntil,
  identifiersNamed,
  nearestNestedFunction,
  nodeWithin,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../../core/ast.js";
import { isCustomHookOwner, runtimeFunctionName } from "../../analysis/ast-helpers.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateCandidate } from "../../analysis/model.js";
import { collectHookImports } from "../../core/imports.js";
import { collectReactCommitContext } from "../react-commit-sensitivity/react-commit-sensitivity.js";
import { collectStateUsage } from "../../analysis/state-usage.js";
import { consumerBindingName } from "./consumer-binding.js";
import { isInsideJsxEventCallback } from "../state-proofs/event-roots.js";
import { isRuntimeOwner } from "../hook-keyed-cursor-contract/binding-references.js";
import { jsxElementCount } from "../state-proofs/jsx-subtrees.js";
import { presentationConsumerFor } from "./presentation-consumer.js";
import ts from "typescript";

export type HookConsumerResult = "leaf" | "none" | "unsafe";
export type HookPresentationConsumerResult = HookPresentationConsumer | "none" | "unsafe";

/**
 * Resolves how a custom hook returns one of its states: as a named property of one returned object
 * literal, as an element of one returned array literal, or as the whole return value. Hooks with
 * several return statements or other return shapes abstain.
 */
export function hookReturnMembers(state: StateCandidate): HookReturnMembers | null {
  const returned = soleReturnedExpression(state.owner);
  if (!returned) {
    return null;
  }
  const value = returnMemberFor(returned, state.valueName);
  if (!value) {
    return null;
  }
  const setter = state.setterName ? returnMemberFor(returned, state.setterName) : null;
  return { setter, value };
}

/** A published state value must occur exactly once outside its declaration: in the hook return. */
export function hookStateValueIsOnlyReturned(state: StateCandidate): boolean {
  return (
    hookReturnMembers(state) !== null &&
    identifiersNamed(state.owner.body, state.valueName).filter(
      (identifier) =>
        !isDeclarationName(identifier) &&
        !isNonValueIdentifier(identifier) &&
        !nodeWithin(identifier, state.call.parent),
    ).length === 1
  );
}

function soleReturnedExpression(owner: RuntimeFunctionLike): ts.Expression | null {
  if (!owner.body) {
    return null;
  }
  if (!ts.isBlock(owner.body)) {
    return unwrapTransparentExpression(owner.body);
  }
  const returns: ts.Expression[] = [];
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (ts.isReturnStatement(node) && node.expression) {
      returns.push(unwrapTransparentExpression(node.expression));
    }
  });
  const [only] = returns;
  return returns.length === 1 && only ? only : null;
}

function returnMemberFor(returned: ts.Expression, name: string): HookReturnMember | null {
  if (ts.isIdentifier(returned)) {
    return returned.text === name ? { kind: "self" } : null;
  }
  if (ts.isArrayLiteralExpression(returned)) {
    return arrayReturnMember(returned, name);
  }
  if (!ts.isObjectLiteralExpression(returned)) {
    return null;
  }
  const propertyName = returned.properties
    .map((property) => returnedPropertyName(property, name))
    .find((candidate) => candidate !== null);
  return propertyName === undefined ? null : { kind: "property", name: propertyName };
}

function arrayReturnMember(
  returned: ts.ArrayLiteralExpression,
  name: string,
): HookReturnMember | null {
  if (returned.elements.some((element) => ts.isSpreadElement(element))) {
    return null;
  }
  const index = returned.elements.findIndex((element) => isIdentifierNamed(element, name));
  return index === -1 ? null : { index, kind: "index" };
}

function returnedPropertyName(property: ts.ObjectLiteralElementLike, name: string): string | null {
  if (ts.isShorthandPropertyAssignment(property)) {
    return property.name.text === name ? name : null;
  }
  if (
    ts.isPropertyAssignment(property) &&
    ts.isIdentifier(property.name) &&
    isIdentifierNamed(property.initializer, name)
  ) {
    return property.name.text;
  }
  return null;
}

function isIdentifierNamed(expression: ts.Expression, name: string): boolean {
  const value = unwrapTransparentExpression(expression);
  return ts.isIdentifier(value) && value.text === name;
}

export interface HookConsumerQuery {
  readonly hookBinding: string;
  readonly members: HookReturnMembers;
  readonly sourceFile: ts.SourceFile;
}

export interface HookPresentationConsumerQuery extends HookConsumerQuery {
  readonly broadOwnerJsx: number;
  readonly pureProjectionImports: ReadonlySet<string>;
}

/**
 * Classifies every use of one hook binding in a file. "leaf" means the binding is called exactly
 * once, from a small named component that keeps the returned state and setter inside its own render.
 */
export function hookConsumerResult({
  hookBinding,
  members,
  sourceFile,
}: HookConsumerQuery): HookConsumerResult {
  const references = hookBindingReferences(sourceFile, hookBinding);
  if (references === "unsafe") {
    return "unsafe";
  }
  if (references.length === 0) {
    return "none";
  }
  const [call] = references;
  return references.length === 1 && call && callFeedsLeafConsumer(call, members, sourceFile)
    ? "leaf"
    : "unsafe";
}

/**
 * Resolves one hook call whose returned value is used only by stable render sites in one broad,
 * commit-insensitive component. The component may pass a plain snapshot through a stable child
 * call site because the recommended wrapper owns the observable subscription above that child.
 */
export function hookPresentationConsumerResult({
  broadOwnerJsx,
  hookBinding,
  members,
  pureProjectionImports,
  sourceFile,
}: HookPresentationConsumerQuery): HookPresentationConsumerResult {
  const references = hookBindingReferences(sourceFile, hookBinding);
  if (references === "unsafe") {
    return "unsafe";
  }
  if (references.length === 0) {
    return "none";
  }
  const [call] = references;
  return references.length === 1 && call
    ? presentationConsumerFor({
        call,
        members,
        scope: { broadOwnerJsx, pureProjectionImports },
        sourceFile,
      })
    : "unsafe";
}

function hookBindingReferences(
  sourceFile: ts.SourceFile,
  hookBinding: string,
): readonly ts.CallExpression[] | "unsafe" {
  const calls: ts.CallExpression[] = [];
  let unsafe = false;
  visit(sourceFile, (node) => {
    if (!ts.isIdentifier(node) || node.text !== hookBinding || isModuleBoundaryReference(node)) {
      return;
    }
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
      calls.push(node.parent);
    } else {
      unsafe = true;
    }
  });
  return unsafe ? "unsafe" : calls;
}

function isModuleBoundaryReference(node: ts.Identifier): boolean {
  const exportAssignment = findAncestor(node, ts.isExportAssignment);
  return (
    isDeclarationName(node) ||
    isNonValueIdentifier(node) ||
    findAncestor(node, ts.isImportDeclaration) !== null ||
    findAncestor(node, ts.isExportDeclaration) !== null ||
    (exportAssignment !== null && unwrapTransparentExpression(exportAssignment.expression) === node)
  );
}

function callFeedsLeafConsumer(
  call: ts.CallExpression,
  members: HookReturnMembers,
  sourceFile: ts.SourceFile,
): boolean {
  const owner = findAncestor(call, isRuntimeOwner);
  const declaration = call.parent;
  if (
    !owner ||
    !isLeafComponentOwner(owner) ||
    !ts.isVariableDeclaration(declaration) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return false;
  }
  const valueName = consumerBindingName(declaration.name, members.value);
  const setterName = members.setter ? consumerBindingName(declaration.name, members.setter) : null;
  if (valueName === null || valueName === "unsupported" || setterName === "unsupported") {
    return false;
  }
  return consumerKeepsStateLocal({ call, owner, setterName, valueName }, sourceFile);
}

function isLeafComponentOwner(owner: RuntimeFunctionLike): boolean {
  const elements = jsxElementCount(owner);
  if (elements >= SMALL_OWNER_JSX_ELEMENTS || isCustomHookOwner(owner)) {
    return false;
  }
  return runtimeFunctionName(owner) !== null && elements > 0 && !rendersBeyondItself(owner);
}

/**
 * A consumer that publishes through a context provider or hands owner-computed bindings to child
 * components renders more than itself, however few JSX elements it declares.
 */
function rendersBeyondItself(owner: RuntimeFunctionLike): boolean {
  let beyond = false;
  visit(owner.body, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) {
      return;
    }
    if (isContextProviderTag(node.tagName) || forwardsOwnerBinding(node, owner)) {
      beyond = true;
    }
  });
  return beyond;
}

function isContextProviderTag(tagName: ts.JsxTagNameExpression): boolean {
  return ts.isPropertyAccessExpression(tagName) && tagName.name.text === "Provider";
}

function forwardsOwnerBinding(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  owner: RuntimeFunctionLike,
): boolean {
  if (!ts.isIdentifier(opening.tagName) || /^[a-z]/u.test(opening.tagName.text)) {
    return false;
  }
  return opening.attributes.properties.some((attribute) => {
    if (ts.isJsxSpreadAttribute(attribute)) {
      return true;
    }
    const expression =
      attribute.initializer && ts.isJsxExpression(attribute.initializer)
        ? attribute.initializer.expression
        : undefined;
    const value = expression ? unwrapTransparentExpression(expression) : null;
    return (
      value !== null && ts.isIdentifier(value) && bindingDeclarationCount(owner, value.text) > 0
    );
  });
}

function consumerKeepsStateLocal(consumer: StateCandidate, sourceFile: ts.SourceFile): boolean {
  const imports = collectHookImports(sourceFile);
  const { lifecycleRegions } = collectReactCommitContext(sourceFile, imports);
  const usage = collectStateUsage(consumer, {
    effectNodes: lifecycleRegions,
    imports,
    persistenceSinks: EMPTY_NODES,
  });
  return (
    !usage.escaped &&
    !usage.shadowed &&
    usage.transportedOccurrences === 0 &&
    usage.jsxTargets.size === 0 &&
    usage.setterTargets.size === 0 &&
    !usage.unstableTransport &&
    consumerReferences(consumer).every((reference) => staysInOwnerRender(reference, consumer.owner))
  );
}

function consumerReferences(consumer: StateCandidate): readonly ts.Identifier[] {
  const names = [consumer.valueName, ...(consumer.setterName ? [consumer.setterName] : [])];
  return names
    .flatMap((name) => identifiersNamed(consumer.owner.body, name))
    .filter((identifier) => !isDeclarationName(identifier) && !isNonValueIdentifier(identifier));
}

/**
 * A reference stays inside the consumer's own render when it is evaluated directly by the render or
 * inside an inline JSX event handler, and any enclosing JSX attribute belongs to a host element.
 * Render callbacks such as `renderItem` and component attributes hand the value to other renders.
 */
function staysInOwnerRender(reference: ts.Identifier, owner: RuntimeFunctionLike): boolean {
  if (nearestNestedFunction(reference, owner) && !isInsideJsxEventCallback(reference, owner)) {
    return false;
  }
  const attribute = findAncestorUntil(reference, ts.isJsxAttribute, owner);
  if (!attribute) {
    return true;
  }
  const opening = attribute.parent.parent;
  return (
    (ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening)) &&
    ts.isIdentifier(opening.tagName) &&
    /^[a-z]/u.test(opening.tagName.text)
  );
}
