import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
} from "../../core/analysis-ast.js";
import { collectHookImports, isImportedHookCall } from "../../core/imports.js";
import { findAncestor, findAncestorUntil, visit } from "../../core/ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import ts from "typescript";

export function cursorEquality(reference: ts.Identifier): ts.BinaryExpression | null {
  const { parent } = reference;
  return ts.isBinaryExpression(parent) &&
    (parent.left === reference || parent.right === reference) &&
    [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(
      parent.operatorToken.kind,
    )
    ? parent
    : null;
}

export function bindingReferences(
  owner: RuntimeFunctionLike,
  binding: ts.Identifier,
): ts.Identifier[] {
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

export function uniqueDirectJsxAttributeReference(
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

export function jsxAttributeContaining(node: ts.Node, name: string): ts.JsxAttribute | null {
  const attribute = findAncestor(node, ts.isJsxAttribute);
  return attribute?.name.getText() === name ? attribute : null;
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

export function isImportedUseCallback(call: ts.CallExpression): boolean {
  const imports = collectHookImports(call.getSourceFile());
  const root = callRootIdentifier(call);
  return (
    root !== null &&
    !bindingIsShadowed(call, root.text) &&
    isImportedHookCall({
      call,
      localNames: imports.useCallback,
      namespaceNames: imports.reactNamespaces,
      canonicalName: "useCallback",
    })
  );
}

function bindingIsShadowed(call: ts.CallExpression, name: string): boolean {
  const owner = findAncestor(call, isRuntimeOwner);
  return owner !== null && bindingDeclarationCount(owner, name) > 0;
}

export function declaresRuntimeBinding(sourceFile: ts.SourceFile, name: string): boolean {
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

export function isRuntimeOwner(node: ts.Node): node is RuntimeFunctionLike {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node)
  );
}
