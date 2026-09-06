import { bindingDeclarationCount, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import { bindingReferences, cursorEquality, isImportedUseCallback } from "./binding-references.js";
import { findAncestor, findAncestorUntil, nearestNestedFunction } from "../../core/ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import ts from "typescript";

export interface MemoizedRowRenderer {
  dependency: ts.ArrayLiteralExpression;
  renderName: ts.Identifier;
}

export function memoizedRowRenderer(
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
