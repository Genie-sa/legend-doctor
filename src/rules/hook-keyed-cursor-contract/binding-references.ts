import { bindingDeclarationCount, isDeclarationName } from "../../core/analysis-ast.js";
import { calleeRootIdentifier, findAncestor, findAncestorUntil, visit } from "../../core/ast.js";
import { collectHookImports, isImportedHookCall } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { bindingReferences } from "../../core/binding-references.js";
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

export function isImportedUseCallback(call: ts.CallExpression): boolean {
  const imports = collectHookImports(call.getSourceFile());
  const root = calleeRootIdentifier(call.expression);
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
