import ts from "typescript";
import { unwrapTransparentExpression } from "./declaration-shapes.js";

export function directLegendValueHookObservable(
  declaration: ts.FunctionDeclaration,
  useValueHooks: ReadonlySet<string>,
): string | null {
  const returned = soleReturnedExpression(declaration);
  if (declaration.parameters.length > 0 || !returned) {
    return null;
  }
  const expression = unwrapNullishFallback(returned);
  if (
    !ts.isCallExpression(expression) ||
    expression.arguments.length !== 1 ||
    !ts.isIdentifier(expression.expression) ||
    !useValueHooks.has(expression.expression.text)
  ) {
    return null;
  }
  const observable = unwrapTransparentExpression(expression.arguments[0]!);
  return ts.isIdentifier(observable) ? observable.text : null;
}

function soleReturnedExpression(declaration: ts.FunctionDeclaration): ts.Expression | null {
  const statements = declaration.body?.statements;
  if (!statements || statements.length !== 1) {
    return null;
  }
  const [statement] = statements;
  return statement && ts.isReturnStatement(statement) && statement.expression
    ? unwrapTransparentExpression(statement.expression)
    : null;
}

function unwrapNullishFallback(expression: ts.Expression): ts.Expression {
  return ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ? unwrapTransparentExpression(expression.left)
    : expression;
}

export function directLegendValueWriterObservable(
  declaration: ts.FunctionDeclaration,
): string | null {
  const [parameter] = declaration.parameters;
  const statement = declaration.body?.statements[0];
  if (
    declaration.parameters.length !== 1 ||
    !parameter ||
    !ts.isIdentifier(parameter.name) ||
    declaration.body?.statements.length !== 1 ||
    !statement ||
    !ts.isExpressionStatement(statement)
  ) {
    return null;
  }
  const expression = unwrapTransparentExpression(statement.expression);
  const argument =
    ts.isCallExpression(expression) && expression.arguments[0]
      ? unwrapTransparentExpression(expression.arguments[0])
      : null;
  if (
    !ts.isCallExpression(expression) ||
    expression.arguments.length !== 1 ||
    !argument ||
    !ts.isIdentifier(argument) ||
    argument.text !== parameter.name.text ||
    !ts.isPropertyAccessExpression(expression.expression) ||
    expression.expression.name.text !== "set"
  ) {
    return null;
  }
  const observable = unwrapTransparentExpression(expression.expression.expression);
  return ts.isIdentifier(observable) ? observable.text : null;
}
