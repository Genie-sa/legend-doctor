import {
  collectBindingNames,
  isAssignmentOperator,
  isDeclarationName,
  isNonValueIdentifier,
} from "./analysis-ast.js";
import type { RuntimeFunctionLike } from "./ast.js";
import ts from "typescript";
import { visit } from "./ast.js";

export function propertyAccessIsWritten(
  access: ts.ElementAccessExpression | ts.PropertyAccessExpression,
): boolean {
  const { parent } = access;
  return (
    (ts.isBinaryExpression(parent) &&
      parent.left === access &&
      isAssignmentOperator(parent.operatorToken.kind)) ||
    (ts.isPrefixUnaryExpression(parent) &&
      parent.operand === access &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken)) ||
    (ts.isPostfixUnaryExpression(parent) && parent.operand === access) ||
    (ts.isDeleteExpression(parent) && parent.expression === access)
  );
}

export function isConstDeclaration(declaration: ts.VariableDeclaration): boolean {
  return (
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

export function bindingContainsName(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) {
    return binding.text === name;
  }
  return binding.elements.some(
    (element) => ts.isBindingElement(element) && bindingContainsName(element.name, name),
  );
}

export function parameterBindingNames(owner: RuntimeFunctionLike): ReadonlySet<string> {
  const names = new Set<string>();
  for (const parameter of owner.parameters) {
    collectBindingNames(parameter.name, names);
  }
  return names;
}

export function bindingIsReferenced(node: ts.Node, name: string): boolean {
  let found = false;
  visit(node, (current) => {
    if (
      ts.isIdentifier(current) &&
      current.text === name &&
      !isDeclarationName(current) &&
      !isNonValueIdentifier(current)
    ) {
      found = true;
    }
  });
  return found;
}

/** Every value reference to the binding inside the owner, excluding its own declaration name. */
export function bindingReferences(
  owner: RuntimeFunctionLike,
  name: ts.Identifier,
): ts.Identifier[] {
  const references: ts.Identifier[] = [];
  visit(owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === name.text &&
      node !== name &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return references;
}

export function expressionReferencesName(expression: ts.Expression, name: string): boolean {
  let found = false;
  visit(expression, (node) => {
    if (ts.isIdentifier(node) && node.text === name) {
      found = true;
    }
  });
  return found;
}
