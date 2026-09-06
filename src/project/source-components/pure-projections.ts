import type { ImportBinding } from "./model.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "./declaration-shapes.js";

export function isPureProjectionDeclaration(
  declaration: ts.FunctionDeclaration,
  imports: ReadonlyMap<string, ImportBinding>,
): boolean {
  if (
    !declaration.body ||
    declaration.asteriskToken ||
    declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    declaration.body.statements.length !== 1 ||
    declaration.parameters.length === 0 ||
    declaration.parameters.some(
      (parameter) => !ts.isIdentifier(parameter.name) || parameter.initializer !== undefined,
    )
  ) {
    return false;
  }
  const [statement] = declaration.body.statements;
  if (!statement || !ts.isReturnStatement(statement) || !statement.expression) {
    return false;
  }
  // SAFETY: the guard above returns false unless every parameter name is an identifier.
  const parameters = new Set(
    declaration.parameters.map((parameter) => (parameter.name as ts.Identifier).text),
  );
  const referenced = new Set<string>();
  const pure = isPureProjectionExpression(
    statement.expression,
    { imports, parameters },
    referenced,
  );
  return pure && [...parameters].every((parameter) => referenced.has(parameter));
}

interface ProjectionScope {
  imports: ReadonlyMap<string, ImportBinding>;
  parameters: ReadonlySet<string>;
}

function isPureProjectionExpression(
  expression: ts.Expression,
  scope: ProjectionScope,
  referenced: Set<string>,
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(value)) {
    return recordProjectionParameter(value, scope.parameters, referenced);
  }
  if (isPureProjectionLiteral(value)) {
    return true;
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.every(
      (element) =>
        !ts.isSpreadElement(element) && isPureProjectionExpression(element, scope, referenced),
    );
  }
  return isPureProjectionCall(value, scope, referenced);
}

function recordProjectionParameter(
  value: ts.Identifier,
  parameters: ReadonlySet<string>,
  referenced: Set<string>,
): boolean {
  if (!parameters.has(value.text)) {
    return false;
  }
  referenced.add(value.text);
  return true;
}

function isPureProjectionLiteral(value: ts.Expression): boolean {
  return (
    ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword
  );
}

function isPureProjectionCall(
  value: ts.Expression,
  scope: ProjectionScope,
  referenced: Set<string>,
): boolean {
  if (
    !ts.isCallExpression(value) ||
    !ts.isIdentifier(value.expression) ||
    scope.parameters.has(value.expression.text)
  ) {
    return false;
  }
  const binding = scope.imports.get(value.expression.text);
  if (!binding || !isKnownPureProjectionImport(binding)) {
    return false;
  }
  return value.arguments.every(
    (argument) =>
      !ts.isSpreadElement(argument) && isPureProjectionExpression(argument, scope, referenced),
  );
}

function isKnownPureProjectionImport(binding: ImportBinding): boolean {
  return (
    (binding.moduleSpecifier === "clsx" && binding.importedName === "clsx") ||
    (binding.moduleSpecifier === "tailwind-merge" && binding.importedName === "twMerge")
  );
}
