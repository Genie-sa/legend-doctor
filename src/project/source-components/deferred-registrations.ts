import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
} from "../../core/analysis-ast.js";
import { nearestNestedFunction, nodeWithin, visit } from "../../core/ast.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "./declaration-shapes.js";

const MINIMUM_STORED_CALLBACK_REFERENCES = 2;

export function deferredRegistrationMethodsByClass(
  sourceFile: ts.SourceFile,
): ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<number>>> {
  const byClass = new Map<string, ReadonlyMap<string, ReadonlySet<number>>>();
  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name) {
      continue;
    }
    const methods = deferredRegistrationMethods(statement);
    if (methods.size > 0) {
      byClass.set(statement.name.text, methods);
    }
  }
  return byClass;
}

function deferredRegistrationMethods(
  declaration: ts.ClassDeclaration,
): ReadonlyMap<string, ReadonlySet<number>> {
  const methods = new Map<string, ReadonlySet<number>>();
  for (const member of declaration.members) {
    if (!ts.isMethodDeclaration(member) || !member.body || !ts.isIdentifier(member.name)) {
      continue;
    }
    const deferred = deferredMethodParameterIndices(declaration, member);
    if (deferred.size > 0) {
      methods.set(member.name.text, deferred);
    }
  }
  return methods;
}

function deferredMethodParameterIndices(
  declaration: ts.ClassDeclaration,
  method: ts.MethodDeclaration,
): ReadonlySet<number> {
  const deferred = new Set<number>();
  for (const [index, parameter] of method.parameters.entries()) {
    if (
      ts.isIdentifier(parameter.name) &&
      bindingDeclarationCount(method, parameter.name.text) === 1 &&
      methodStoresCallbackUntilCleanup(declaration, method, parameter.name)
    ) {
      deferred.add(index);
    }
  }
  return deferred;
}

function methodStoresCallbackUntilCleanup(
  declaration: ts.ClassDeclaration,
  method: ts.MethodDeclaration,
  parameter: ts.Identifier,
): boolean {
  const { body } = method;
  if (!body) {
    return false;
  }
  const { references, returns } = collectCallbackUsage(body, method, parameter);
  const cleanup = soleCleanupFunction(returns, references.length);
  if (!cleanup) {
    return false;
  }
  return callbackIsStoredThenRemoved(declaration, { cleanup, references, returns });
}

interface CallbackUsage {
  references: readonly ts.Identifier[];
  returns: readonly ts.ReturnStatement[];
}

function collectCallbackUsage(
  body: ts.Block,
  method: ts.MethodDeclaration,
  parameter: ts.Identifier,
): CallbackUsage {
  const returns: ts.ReturnStatement[] = [];
  const references: ts.Identifier[] = [];
  visit(body, (node) => {
    if (ts.isReturnStatement(node) && nearestNestedFunction(node, method) === null) {
      returns.push(node);
    }
    if (
      ts.isIdentifier(node) &&
      node.text === parameter.text &&
      node !== parameter &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return { references, returns };
}

function soleCleanupFunction(
  returns: readonly ts.ReturnStatement[],
  referenceCount: number,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const returned = returns.length === 1 ? returns[0]?.expression : undefined;
  if (!returned || referenceCount < MINIMUM_STORED_CALLBACK_REFERENCES) {
    return null;
  }
  const cleanup = unwrapTransparentExpression(returned);
  return ts.isArrowFunction(cleanup) || ts.isFunctionExpression(cleanup) ? cleanup : null;
}

function callbackIsStoredThenRemoved(
  declaration: ts.ClassDeclaration,
  usage: {
    cleanup: ts.ArrowFunction | ts.FunctionExpression;
    references: readonly ts.Identifier[];
    returns: readonly ts.ReturnStatement[];
  },
): boolean {
  const { cleanup, references, returns } = usage;
  const stored = references.flatMap((reference) => {
    const property = storedCallbackProperty(reference, declaration);
    return property ? [{ property, reference }] : [];
  });
  const first = stored.length === 1 ? stored[0] : null;
  if (!first || first.reference.getStart() >= returns[0]!.getStart()) {
    return false;
  }
  return references.every(
    (reference) =>
      reference === first.reference ||
      (nodeWithin(reference, cleanup) &&
        callbackReferenceIsRemoved(reference, cleanup, first.property)),
  );
}

function callbackReferenceIsRemoved(
  reference: ts.Identifier,
  cleanup: ts.ArrowFunction | ts.FunctionExpression,
  property: string,
): boolean {
  if (!isRemovalComparison(reference)) {
    return false;
  }
  const filter = enclosingFilterCall(reference, cleanup, property);
  return filter !== null && filterResultIsAssignedBack(filter, cleanup, property);
}

function isRemovalComparison(reference: ts.Identifier): boolean {
  const comparison = reference.parent;
  return (
    ts.isBinaryExpression(comparison) &&
    (comparison.left === reference || comparison.right === reference) &&
    [ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(
      comparison.operatorToken.kind,
    )
  );
}

function enclosingFilterCall(
  reference: ts.Identifier,
  cleanup: ts.ArrowFunction | ts.FunctionExpression,
  property: string,
): ts.CallExpression | null {
  for (
    let current: ts.Node | undefined = reference.parent.parent;
    current && current !== cleanup;
    current = current.parent
  ) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === "filter" &&
      isThisProperty(current.expression.expression, property) &&
      current.arguments.some((argument) => nodeWithin(reference, argument))
    ) {
      return current;
    }
  }
  return null;
}

function filterResultIsAssignedBack(
  filter: ts.CallExpression,
  cleanup: ts.ArrowFunction | ts.FunctionExpression,
  property: string,
): boolean {
  for (
    let current: ts.Node | undefined = filter.parent;
    current && current !== cleanup;
    current = current.parent
  ) {
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isThisProperty(current.left, property) &&
      unwrapTransparentExpression(current.right) === filter
    ) {
      return true;
    }
  }
  return false;
}

function storedCallbackProperty(
  reference: ts.Identifier,
  declaration: ts.ClassDeclaration,
): string | null {
  const call = reference.parent;
  if (
    !ts.isCallExpression(call) ||
    !call.arguments.includes(reference) ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== "push" ||
    !ts.isPropertyAccessExpression(call.expression.expression) ||
    call.expression.expression.expression.kind !== ts.SyntaxKind.ThisKeyword
  ) {
    return null;
  }
  const property = call.expression.expression.name.text;
  const field = declaration.members.find(
    (member) =>
      ts.isPropertyDeclaration(member) &&
      ts.isIdentifier(member.name) &&
      member.name.text === property,
  );
  if (!field || !ts.isPropertyDeclaration(field)) {
    return null;
  }
  const initializer = field.initializer && unwrapTransparentExpression(field.initializer);
  const fieldType = field.type;
  return (initializer && ts.isArrayLiteralExpression(initializer)) ||
    (fieldType !== undefined &&
      (ts.isArrayTypeNode(fieldType) ||
        (ts.isTypeReferenceNode(fieldType) &&
          ts.isIdentifier(fieldType.typeName) &&
          fieldType.typeName.text === "Array")))
    ? property
    : null;
}

function isThisProperty(expression: ts.Expression, property: string): boolean {
  const value = unwrapTransparentExpression(expression);
  return (
    ts.isPropertyAccessExpression(value) &&
    value.expression.kind === ts.SyntaxKind.ThisKeyword &&
    value.name.text === property
  );
}
