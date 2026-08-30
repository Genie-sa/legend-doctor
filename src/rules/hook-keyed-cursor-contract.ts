import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
  isPureExpression,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import { collectHookImports, isImportedHookCall } from "../imports.js";
import {
  findAncestor,
  findAncestorUntil,
  nearestNestedFunction,
  nodeWithin,
  visit,
} from "../ast.js";

import type { RuntimeFunctionLike } from "../ast.js";
import ts from "typescript";
import { uniqueVariableDeclaration } from "./state-proofs.js";

export type HookConsumerResult = "none" | "safe" | "unsafe";

/** Proves one imported hook result is broadcast only to stable keyed row presentation. */
export function keyedCursorConsumerResult(
  sourceFile: ts.SourceFile,
  hookBinding: string,
  cursorProperty: string,
  setterProperty: string,
): HookConsumerResult {
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

interface MemoizedRowRenderer {
  dependency: ts.ArrayLiteralExpression;
  renderName: ts.Identifier;
}

function memoizedRowRenderer(
  equalityReference: ts.Identifier,
  owner: RuntimeFunctionLike,
): MemoizedRowRenderer | null {
  const memo = rowEqualityMemo(equalityReference, owner);
  if (!memo) {
    return null;
  }
  const renderName = memoRenderBindingName(memo);
  const [, dependency] = memo.arguments;
  return renderName && dependency && ts.isArrayLiteralExpression(dependency)
    ? { dependency, renderName }
    : null;
}

function rowEqualityMemo(
  equalityReference: ts.Identifier,
  owner: RuntimeFunctionLike,
): ts.CallExpression | null {
  const equality = cursorEquality(equalityReference);
  const callback = nearestNestedFunction(equalityReference, owner);
  if (
    !equality ||
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    !rowEqualityUsesIndex(equality, callback, equalityReference) ||
    !equalityOnlyFeedsRowAttributes(equality, callback)
  ) {
    return null;
  }
  const memo = callback.parent;
  return ts.isCallExpression(memo) && memo.arguments[0] === callback && isImportedUseCallback(memo)
    ? memo
    : null;
}

function memoRenderBindingName(memo: ts.CallExpression): ts.Identifier | null {
  const declaration = findAncestor(memo, ts.isVariableDeclaration);
  if (!declaration?.initializer || unwrapTransparentExpression(declaration.initializer) !== memo) {
    return null;
  }
  return ts.isIdentifier(declaration.name) ? declaration.name : null;
}

function keyedListElementIsStable(
  owner: RuntimeFunctionLike,
  renderName: ts.Identifier,
  extraDataReference: ts.Identifier,
): boolean {
  const renderAttribute = uniqueDirectJsxAttributeReference(owner, renderName, "renderItem");
  const extraAttribute = jsxAttributeContaining(extraDataReference, "extraData");
  if (!renderAttribute || !extraAttribute || renderAttribute.parent !== extraAttribute.parent) {
    return false;
  }
  const opening = renderAttribute.parent.parent;
  if (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) {
    return false;
  }
  const keyAttribute = opening.attributes.properties.find(
    (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText() === "keyExtractor",
  );
  return (
    keyAttribute !== undefined &&
    ts.isJsxAttribute(keyAttribute) &&
    keyExtractorIsStable(keyAttribute, owner)
  );
}

function rowEqualityUsesIndex(
  equality: ts.BinaryExpression,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  cursor: ts.Identifier,
): boolean {
  const other = equality.left === cursor ? equality.right : equality.left;
  if (!ts.isIdentifier(other)) {
    return false;
  }
  const parameter = callback.parameters[0]?.name;
  if (!parameter || !ts.isObjectBindingPattern(parameter)) {
    return false;
  }
  return parameter.elements.some(
    (element) =>
      !element.dotDotDotToken &&
      !element.initializer &&
      ts.isIdentifier(element.name) &&
      element.name.text === other.text &&
      (!element.propertyName ||
        (ts.isIdentifier(element.propertyName) && element.propertyName.text === "index")),
  );
}

function equalityOnlyFeedsRowAttributes(
  equality: ts.BinaryExpression,
  callback: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  const declaration = equality.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer !== equality ||
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(callback, declaration.name.text) !== 1
  ) {
    return findAncestorUntil(equality, ts.isJsxAttribute, callback) !== null;
  }
  const references = bindingReferences(callback, declaration.name);
  return (
    references.length > 0 &&
    references.every((reference) => {
      const attribute = findAncestorUntil(reference, ts.isJsxAttribute, callback);
      return attribute !== null && attribute.name.getText() !== "key";
    })
  );
}

function keyExtractorIsStable(attribute: ts.JsxAttribute, owner: RuntimeFunctionLike): boolean {
  const callback = keyExtractorCallback(attribute, owner);
  const item = callback?.parameters[0]?.name;
  if (!callback || !item || !ts.isIdentifier(item)) {
    return false;
  }
  return returnsItemPropertyWithoutIndex(callback, item);
}

function keyExtractorCallback(
  attribute: ts.JsxAttribute,
  owner: RuntimeFunctionLike,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const expression =
    attribute.initializer && ts.isJsxExpression(attribute.initializer)
      ? attribute.initializer.expression
      : null;
  return expression ? callbackFromExpression(expression, owner) : null;
}

function returnsItemPropertyWithoutIndex(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  item: ts.Identifier,
): boolean {
  const index = callback.parameters[1]?.name;
  const returned = callbackReturnExpression(callback);
  if (!returned || !isPureExpression(returned)) {
    return false;
  }
  let itemProperty = false;
  let usesIndex = false;
  visit(returned, (node) => {
    if (ts.isPropertyAccessExpression(node) && propertyAccessRoot(node)?.text === item.text) {
      itemProperty = true;
    }
    if (index && ts.isIdentifier(index) && ts.isIdentifier(node) && node.text === index.text) {
      usesIndex = true;
    }
  });
  return itemProperty && !usesIndex;
}

function inlineCallback(value: ts.Expression): ts.ArrowFunction | ts.FunctionExpression | null {
  return ts.isArrowFunction(value) || ts.isFunctionExpression(value) ? value : null;
}

function callbackFromExpression(
  expression: ts.Expression,
  owner: RuntimeFunctionLike,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const value = unwrapTransparentExpression(expression);
  const inline = inlineCallback(value);
  if (inline || !ts.isIdentifier(value)) {
    return inline;
  }
  const declaration = uniqueVariableDeclaration(owner, value.text);
  return declaration?.initializer ? callbackFromInitializer(declaration.initializer) : null;
}

function callbackFromInitializer(
  source: ts.Expression,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const initializer = unwrapTransparentExpression(source);
  const inline = inlineCallback(initializer);
  if (inline) {
    return inline;
  }
  if (!ts.isCallExpression(initializer) || !isImportedUseCallback(initializer)) {
    return null;
  }
  const [callback] = initializer.arguments;
  return callback ? inlineCallback(callback) : null;
}

function callbackReturnExpression(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): ts.Expression | null {
  if (!ts.isBlock(callback.body)) {
    return callback.body;
  }
  const { statements } = callback.body;
  return statements.length === 1 && ts.isReturnStatement(statements[0]!)
    ? (statements[0]!.expression ?? null)
    : null;
}

function cursorEquality(reference: ts.Identifier): ts.BinaryExpression | null {
  const { parent } = reference;
  return ts.isBinaryExpression(parent) &&
    (parent.left === reference || parent.right === reference) &&
    [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(
      parent.operatorToken.kind,
    )
    ? parent
    : null;
}

function bindingReferences(owner: RuntimeFunctionLike, binding: ts.Identifier): ts.Identifier[] {
  const references: ts.Identifier[] = [];
  visit(owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === binding.text &&
      node !== binding &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return references;
}

function uniqueDirectJsxAttributeReference(
  owner: RuntimeFunctionLike,
  binding: ts.Identifier,
  prop: string,
): ts.JsxAttribute | null {
  const references = bindingReferences(owner, binding);
  if (references.length !== 1) {
    return null;
  }
  const attribute = findAncestorUntil(references[0]!, ts.isJsxAttribute, owner);
  return attribute?.name.getText() === prop ? attribute : null;
}

function jsxAttributeContaining(node: ts.Node, name: string): ts.JsxAttribute | null {
  const attribute = findAncestor(node, ts.isJsxAttribute);
  return attribute?.name.getText() === name ? attribute : null;
}

function propertyAccessRoot(expression: ts.PropertyAccessExpression): ts.Identifier | null {
  let current: ts.Expression = expression.expression;
  while (ts.isPropertyAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current : null;
}

function callRootIdentifier(call: ts.CallExpression): ts.Identifier | null {
  if (ts.isIdentifier(call.expression)) {
    return call.expression;
  }
  return ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression)
    ? call.expression.expression
    : null;
}

function isImportedUseCallback(call: ts.CallExpression): boolean {
  const imports = collectHookImports(call.getSourceFile());
  const root = callRootIdentifier(call);
  return (
    root !== null &&
    !bindingIsShadowed(call, root.text) &&
    isImportedHookCall(call, imports.useCallback, imports.reactNamespaces, "useCallback")
  );
}

function bindingIsShadowed(call: ts.CallExpression, name: string): boolean {
  const owner = findAncestor(call, isRuntimeOwner);
  return owner !== null && bindingDeclarationCount(owner, name) > 0;
}

function declaresRuntimeBinding(sourceFile: ts.SourceFile, name: string): boolean {
  let declared = false;
  visit(sourceFile, (node) => {
    if (
      ts.isIdentifier(node) &&
      isDeclarationName(node) &&
      node.text === name &&
      !findAncestor(node, ts.isImportDeclaration)
    ) {
      declared = true;
    }
  });
  return declared;
}

function isRuntimeOwner(node: ts.Node): node is RuntimeFunctionLike {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node)
  );
}
