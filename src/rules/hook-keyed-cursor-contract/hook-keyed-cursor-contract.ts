import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import {
  bindingReferences,
  cursorEquality,
  declaresRuntimeBinding,
  isRuntimeOwner,
  jsxAttributeContaining,
} from "./binding-references.js";
import { findAncestor, nodeWithin, visit } from "../../core/ast.js";
import type { MemoizedRowRenderer } from "./memoized-row-renderer.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { keyedListElementIsStable } from "./keyed-list-element.js";
import { memoizedRowRenderer } from "./memoized-row-renderer.js";
import ts from "typescript";

export type HookConsumerResult = "none" | "safe" | "unsafe";

/** Proves one imported hook result is broadcast only to stable keyed row presentation. */
export interface KeyedCursorConsumerQuery {
  readonly cursorProperty: string;
  readonly hookBinding: string;
  readonly setterProperty: string;
  readonly sourceFile: ts.SourceFile;
}

export function keyedCursorConsumerResult({
  cursorProperty,
  hookBinding,
  setterProperty,
  sourceFile,
}: KeyedCursorConsumerQuery): HookConsumerResult {
  if (declaresRuntimeBinding(sourceFile, hookBinding)) {
    return "unsafe";
  }
  const calls: ts.CallExpression[] = [];
  let unsafeReference = false;
  visit(sourceFile, (node) => {
    if (
      !ts.isIdentifier(node) ||
      node.text !== hookBinding ||
      findAncestor(node, ts.isImportDeclaration) !== null ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
      calls.push(node.parent);
    } else {
      unsafeReference = true;
    }
  });
  if (calls.length === 0 && !unsafeReference) {
    return "none";
  }
  if (unsafeReference || calls.length !== 1) {
    return "unsafe";
  }
  return callHasStableKeyedCursorConsumer(calls[0]!, cursorProperty, setterProperty)
    ? "safe"
    : "unsafe";
}

function callHasStableKeyedCursorConsumer(
  call: ts.CallExpression,
  cursorProperty: string,
  setterProperty: string,
): boolean {
  const declaration = findAncestor(call, ts.isVariableDeclaration);
  const owner = findAncestor(call, isRuntimeOwner);
  if (
    !declaration ||
    !owner ||
    !declaration.initializer ||
    unwrapTransparentExpression(declaration.initializer) !== call ||
    !ts.isObjectBindingPattern(declaration.name)
  ) {
    return false;
  }
  const element = declaration.name.elements.find(
    (candidate) => bindingSourceName(candidate) === cursorProperty,
  );
  const setterEscapes = declaration.name.elements.some(
    (candidate) => bindingSourceName(candidate) === setterProperty,
  );
  if (
    !element ||
    setterEscapes ||
    element.dotDotDotToken ||
    element.initializer ||
    !ts.isIdentifier(element.name) ||
    bindingDeclarationCount(owner, element.name.text) !== 1
  ) {
    return false;
  }
  return cursorReferencesFormOneStableList(owner, element.name);
}

function bindingSourceName(candidate: ts.BindingElement): string | null {
  if (candidate.propertyName) {
    return ts.isIdentifier(candidate.propertyName) ? candidate.propertyName.text : null;
  }
  return ts.isIdentifier(candidate.name) ? candidate.name.text : null;
}

function cursorReferencesFormOneStableList(
  owner: RuntimeFunctionLike,
  cursor: ts.Identifier,
): boolean {
  const references = bindingReferences(owner, cursor);
  const equalityReference = soleReference(
    references,
    (reference) => cursorEquality(reference) !== null,
  );
  const renderer = equalityReference && memoizedRowRenderer(equalityReference, owner);
  if (!equalityReference || !renderer) {
    return false;
  }
  return cursorFeedsStableList({ equalityReference, owner, references, renderer });
}

interface StableListCheck {
  equalityReference: ts.Identifier;
  owner: RuntimeFunctionLike;
  references: readonly ts.Identifier[];
  renderer: MemoizedRowRenderer;
}

function cursorFeedsStableList(check: StableListCheck): boolean {
  const { equalityReference, owner, references, renderer } = check;
  const dependencyReference = soleDependencyReference(references, renderer.dependency);
  const extraDataReference = soleReference(
    references,
    (reference) => jsxAttributeContaining(reference, "extraData") !== null,
  );
  if (!dependencyReference || !extraDataReference) {
    return false;
  }
  const cursorEscapes = references.some(
    (reference) =>
      reference !== equalityReference &&
      reference !== dependencyReference &&
      reference !== extraDataReference,
  );
  return !cursorEscapes && keyedListElementIsStable(owner, renderer.renderName, extraDataReference);
}

function soleReference(
  references: readonly ts.Identifier[],
  matches: (reference: ts.Identifier) => boolean,
): ts.Identifier | null {
  const matched = references.filter((reference) => matches(reference));
  return matched.length === 1 ? matched[0]! : null;
}

function soleDependencyReference(
  references: readonly ts.Identifier[],
  dependency: ts.ArrayLiteralExpression,
): ts.Identifier | null {
  const reference = soleReference(references, (candidate) => nodeWithin(candidate, dependency));
  if (!reference) {
    return null;
  }
  return dependency.elements.some((element) => unwrapTransparentExpression(element) === reference)
    ? reference
    : null;
}
