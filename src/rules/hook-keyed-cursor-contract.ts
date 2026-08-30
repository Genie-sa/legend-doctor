import ts from "typescript";

import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
  isPureExpression,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import {
  findAncestor,
  findAncestorUntil,
  nearestNestedFunction,
  nodeWithin,
  visit,
} from "../ast.js";
import type { RuntimeFunctionLike } from "../ast.js";
import { collectHookImports, isImportedHookCall } from "../imports.js";
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
  const declaration = findAncestor(call, ts.isVariableDeclaration),
    owner = findAncestor(call, isRuntimeOwner);
  if (
    !declaration ||
    !owner ||
    !declaration.initializer ||
    unwrapTransparentExpression(declaration.initializer) !== call ||
    !ts.isObjectBindingPattern(declaration.name)
  ) {
    return false;
  }
  const element = declaration.name.elements.find((candidate) => {
      const sourceName =
        candidate.propertyName && ts.isIdentifier(candidate.propertyName)
          ? candidate.propertyName.text
          : ts.isIdentifier(candidate.name)
            ? candidate.name.text
            : null;
      return sourceName === cursorProperty;
    }),
    setterEscapes = declaration.name.elements.some((candidate) => {
      const sourceName =
        candidate.propertyName && ts.isIdentifier(candidate.propertyName)
          ? candidate.propertyName.text
          : ts.isIdentifier(candidate.name)
            ? candidate.name.text
            : null;
      return sourceName === setterProperty;
    });
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

function cursorReferencesFormOneStableList(
  owner: RuntimeFunctionLike,
  cursor: ts.Identifier,
): boolean {
  const references = bindingReferences(owner, cursor),
    equalityReferences = references.filter((reference) => cursorEquality(reference) !== null);
  if (equalityReferences.length !== 1) {
    return false;
  }
  const equalityReference = equalityReferences[0]!,
    equality = cursorEquality(equalityReference)!,
    callback = nearestNestedFunction(equalityReference, owner);
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    !rowEqualityUsesIndex(equality, callback, equalityReference) ||
    !equalityOnlyFeedsRowAttributes(equality, callback)
  ) {
    return false;
  }
  const memo = callback.parent;
  if (
    !ts.isCallExpression(memo) ||
    memo.arguments[0] !== callback ||
    !isImportedUseCallback(memo)
  ) {
    return false;
  }
  const renderDeclaration = findAncestor(memo, ts.isVariableDeclaration);
  if (
    !renderDeclaration ||
    !renderDeclaration.initializer ||
    unwrapTransparentExpression(renderDeclaration.initializer) !== memo ||
    !ts.isIdentifier(renderDeclaration.name)
  ) {
    return false;
  }
  const dependency = memo.arguments[1];
  if (!dependency || !ts.isArrayLiteralExpression(dependency)) {
    return false;
  }
  const dependencyReferences = references.filter((reference) => nodeWithin(reference, dependency));
  if (
    dependencyReferences.length !== 1 ||
    !dependency.elements.some(
      (element) => unwrapTransparentExpression(element) === dependencyReferences[0],
    )
  ) {
    return false;
  }

  const extraDataReferences = references.filter(
    (reference) => jsxAttributeContaining(reference, "extraData") !== null,
  );
  if (extraDataReferences.length !== 1) {
    return false;
  }
  if (
    references.some(
      (reference) =>
        reference !== equalityReference &&
        reference !== dependencyReferences[0] &&
        reference !== extraDataReferences[0],
    )
  ) {
    return false;
  }

  const renderAttribute = uniqueDirectJsxAttributeReference(
      owner,
      renderDeclaration.name,
      "renderItem",
    ),
    extraAttribute = jsxAttributeContaining(extraDataReferences[0]!, "extraData");
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
    !!keyAttribute && ts.isJsxAttribute(keyAttribute) && keyExtractorIsStable(keyAttribute, owner)
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
  const expression =
    attribute.initializer && ts.isJsxExpression(attribute.initializer)
      ? attribute.initializer.expression
      : null;
  if (!expression) {
    return false;
  }
  const callback = callbackFromExpression(expression, owner);
  if (
    !callback ||
    callback.parameters.length === 0 ||
    !ts.isIdentifier(callback.parameters[0]!.name)
  ) {
    return false;
  }
  const item = callback.parameters[0]!.name,
    index = callback.parameters[1]?.name,
    returned = callbackReturnExpression(callback);
  if (!returned || !isPureExpression(returned)) {
    return false;
  }
  let itemProperty = false,
    usesIndex = false;
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

function callbackFromExpression(
  expression: ts.Expression,
  owner: RuntimeFunctionLike,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const value = unwrapTransparentExpression(expression);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
    return value;
  }
  if (!ts.isIdentifier(value)) {
    return null;
  }
  const declaration = uniqueVariableDeclaration(owner, value.text);
  if (!declaration?.initializer) {
    return null;
  }
  const initializer = unwrapTransparentExpression(declaration.initializer);
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
    return initializer;
  }
  if (!ts.isCallExpression(initializer) || !isImportedUseCallback(initializer)) {
    return null;
  }
  const callback = initializer.arguments[0];
  return callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
    ? callback
    : null;
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

function isImportedUseCallback(call: ts.CallExpression): boolean {
  const imports = collectHookImports(call.getSourceFile()),
    root = ts.isIdentifier(call.expression)
      ? call.expression
      : ts.isPropertyAccessExpression(call.expression) &&
          ts.isIdentifier(call.expression.expression)
        ? call.expression.expression
        : null;
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
