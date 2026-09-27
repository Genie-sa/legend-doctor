import { collectBindingNames, isNonValueIdentifier } from "./analysis-ast.js";
import { findAncestor, isRuntimeFunctionLike, visit } from "./ast.js";
import type { RuntimeFunctionLike } from "./ast.js";
import ts from "typescript";

/** References that resolve to the owner-level declaration, skipping every nested shadowing scope. */
export function ownerLevelReferences(
  owner: RuntimeFunctionLike,
  declarationName: ts.Identifier,
): ts.Identifier[] {
  const references: ts.Identifier[] = [];
  visit(owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === declarationName.text &&
      node !== declarationName &&
      !isNonValueIdentifier(node) &&
      !isShadowedBetween(node, owner, declarationName.text)
    ) {
      references.push(node);
    }
  });
  return references;
}

function isShadowedBetween(
  reference: ts.Identifier,
  owner: RuntimeFunctionLike,
  name: string,
): boolean {
  for (
    let scope: ts.Node | undefined = reference.parent;
    scope && scope !== owner.body;
    scope = scope.parent
  ) {
    if (scopeDeclares(scope, name)) {
      return true;
    }
  }
  return false;
}

function scopeDeclares(scope: ts.Node, name: string): boolean {
  const names = new Set<string>();
  if (isRuntimeFunctionLike(scope)) {
    collectFunctionScopeNames(scope, names);
  } else if (ts.isBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)) {
    collectBlockScopedNames(scope.statements, names);
  } else {
    collectHeaderScopeNames(scope, names);
  }
  return names.has(name);
}

function collectFunctionScopeNames(scope: RuntimeFunctionLike, names: Set<string>): void {
  for (const parameter of scope.parameters) {
    collectBindingNames(parameter.name, names);
  }
  if ((ts.isFunctionExpression(scope) || ts.isFunctionDeclaration(scope)) && scope.name) {
    names.add(scope.name.text);
  }
  collectHoistedVarNames(scope.body, scope, names);
}

/** Names a loop header, catch clause, or named class expression introduces for its own body. */
function collectHeaderScopeNames(scope: ts.Node, names: Set<string>): void {
  if (
    (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) &&
    scope.initializer &&
    ts.isVariableDeclarationList(scope.initializer)
  ) {
    for (const declaration of scope.initializer.declarations) {
      collectBindingNames(declaration.name, names);
    }
  } else if (ts.isCatchClause(scope) && scope.variableDeclaration) {
    collectBindingNames(scope.variableDeclaration.name, names);
  } else if (ts.isClassExpression(scope) && scope.name) {
    names.add(scope.name.text);
  }
}

function collectBlockScopedNames(statements: ts.NodeArray<ts.Statement>, names: Set<string>): void {
  for (const statement of statements) {
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.flags & ts.NodeFlags.BlockScoped
    ) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, names);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      names.add(statement.name.text);
    }
  }
}

function collectHoistedVarNames(
  body: ts.Node | undefined,
  scope: RuntimeFunctionLike,
  names: Set<string>,
): void {
  visit(body, (node) => {
    if (
      ts.isVariableDeclarationList(node) &&
      !(node.flags & ts.NodeFlags.BlockScoped) &&
      findAncestor(node, isRuntimeFunctionLike) === scope
    ) {
      for (const declaration of node.declarations) {
        collectBindingNames(declaration.name, names);
      }
    }
  });
}
