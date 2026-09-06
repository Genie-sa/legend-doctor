import { bindingDeclarationCount, isAssignmentOperator } from "../../core/analysis-ast.js";
import type { ComponentFunction } from "./model.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "./declaration-shapes.js";
import { visit } from "../../core/ast.js";

export function isObservableTypeReference(
  type: ts.TypeNode,
  observableTypes: ReadonlySet<string>,
): boolean {
  return (
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    observableTypes.has(type.typeName.text)
  );
}

export function isObservableInitializer(
  expression: ts.Expression,
  factories: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (!ts.isCallExpression(value)) {
    return false;
  }
  if (ts.isIdentifier(value.expression)) {
    return factories.has(value.expression.text);
  }
  return (
    ts.isPropertyAccessExpression(value.expression) &&
    ts.isIdentifier(value.expression.expression) &&
    namespaces.has(value.expression.expression.text) &&
    value.expression.name.text === "observable"
  );
}

export function localObservableMemberFactories(
  sourceFile: ts.SourceFile,
  factories: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const proven = new Map<string, ReadonlySet<string>>();
  if (factories.size === 0 && namespaces.size === 0) {
    return proven;
  }
  for (const [name, declaration] of topLevelFunctionDeclarations(sourceFile)) {
    const members = declaration
      ? provenObservableMembers(sourceFile, declaration, { factories, name, namespaces })
      : null;
    if (members) {
      proven.set(name, members);
    }
  }
  return proven;
}

function topLevelFunctionDeclarations(
  sourceFile: ts.SourceFile,
): ReadonlyMap<string, ComponentFunction | null> {
  const declarations = new Map<string, ComponentFunction | null>();
  for (const statement of sourceFile.statements) {
    for (const [name, declaration] of topLevelFunctionsIn(statement)) {
      declarations.set(name, declarations.has(name) ? null : declaration);
    }
  }
  return declarations;
}

function topLevelFunctionsIn(
  statement: ts.Statement,
): readonly (readonly [string, ComponentFunction])[] {
  if (ts.isFunctionDeclaration(statement) && statement.name) {
    return [[statement.name.text, statement] as const];
  }
  if (
    !ts.isVariableStatement(statement) ||
    (statement.declarationList.flags & ts.NodeFlags.Const) === 0
  ) {
    return [];
  }
  return statement.declarationList.declarations.flatMap((declaration) => {
    const initializer = declaration.initializer
      ? unwrapTransparentExpression(declaration.initializer)
      : null;
    return ts.isIdentifier(declaration.name) &&
      initializer &&
      (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
      ? [[declaration.name.text, initializer] as const]
      : [];
  });
}

function provenObservableMembers(
  sourceFile: ts.SourceFile,
  declaration: ComponentFunction,
  context: { factories: ReadonlySet<string>; name: string; namespaces: ReadonlySet<string> },
): ReadonlySet<string> | null {
  const { factories, name, namespaces } = context;
  const object = exactReturnedObject(declaration);
  if (!object) {
    return null;
  }
  if (
    bindingIsAssigned(sourceFile, name) ||
    [...factories, ...namespaces].some(
      (binding) => bindingDeclarationCount(declaration, binding) > 0,
    )
  ) {
    return null;
  }
  const members = directObservableMembers(object, factories, namespaces);
  return members.size > 0 ? members : null;
}

const assignedBindingsByFile = new WeakMap<ts.SourceFile, ReadonlySet<string>>();

function bindingIsAssigned(sourceFile: ts.SourceFile, name: string): boolean {
  let assigned = assignedBindingsByFile.get(sourceFile);
  if (assigned) {
    return assigned.has(name);
  }

  const collected = new Set<string>();
  visit(sourceFile, (node) => {
    if (!ts.isIdentifier(node)) {
      return;
    }
    const { parent } = node;
    if (
      (ts.isBinaryExpression(parent) &&
        parent.left === node &&
        isAssignmentOperator(parent.operatorToken.kind)) ||
      (ts.isPrefixUnaryExpression(parent) &&
        parent.operand === node &&
        (parent.operator === ts.SyntaxKind.PlusPlusToken ||
          parent.operator === ts.SyntaxKind.MinusMinusToken)) ||
      (ts.isPostfixUnaryExpression(parent) && parent.operand === node)
    ) {
      collected.add(node.text);
    }
  });
  assigned = collected;
  assignedBindingsByFile.set(sourceFile, assigned);
  return assigned.has(name);
}

function exactReturnedObject(declaration: ComponentFunction): ts.ObjectLiteralExpression | null {
  const returned = soleReturnedValue(declaration);
  return returned && ts.isObjectLiteralExpression(returned) ? returned : null;
}

function soleReturnedValue(declaration: ComponentFunction): ts.Expression | null {
  if (ts.isArrowFunction(declaration) && !ts.isBlock(declaration.body)) {
    return unwrapTransparentExpression(declaration.body);
  }
  const { body } = declaration;
  if (!body || !ts.isBlock(body) || body.statements.length !== 1) {
    return null;
  }
  const [statement] = body.statements;
  return statement && ts.isReturnStatement(statement) && statement.expression
    ? unwrapTransparentExpression(statement.expression)
    : null;
}

export function directObservableMembers(
  object: ts.ObjectLiteralExpression,
  factories: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
): ReadonlySet<string> {
  const names = new Set<string>();
  const observableMembers = new Set<string>();
  for (const property of object.properties) {
    const name = staticPropertyName(property);
    if (!name || names.has(name)) {
      return new Set();
    }
    names.add(name);
    if (
      ts.isPropertyAssignment(property) &&
      isObservableInitializer(property.initializer, factories, namespaces)
    ) {
      observableMembers.add(name);
    }
  }
  return observableMembers;
}

function staticPropertyName(property: ts.ObjectLiteralElementLike): string | null {
  return ts.isSpreadAssignment(property) || !property.name
    ? null
    : staticObjectMemberName(property.name);
}

function staticObjectMemberName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : null;
}
