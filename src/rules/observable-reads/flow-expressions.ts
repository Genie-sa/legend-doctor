import { isNonValueIdentifier, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import { sourceHasRuntimeBinding } from "../state-proofs/binding-lookup.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

const MEMO_ARGUMENT_COUNT = 2;

export interface ExpressionScope {
  readonly names: ReadonlySet<string>;
  readonly primitives: ReadonlySet<string>;
  readonly sourceFile: ts.SourceFile;
}

export function primitiveExpression(expression: ts.Expression, scope: ExpressionScope): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(value)) {
    return scope.primitives.has(value.text);
  }
  if (
    ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(
      value.kind,
    )
  ) {
    return true;
  }
  if (ts.isBinaryExpression(value)) {
    return primitiveExpression(value.left, scope) && primitiveExpression(value.right, scope);
  }
  if (ts.isConditionalExpression(value)) {
    return (
      primitiveExpression(value.whenTrue, scope) && primitiveExpression(value.whenFalse, scope)
    );
  }
  return ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken;
}

export function pureFlowExpression(expression: ts.Expression, scope: ExpressionScope): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(value)) {
    return (
      scope.names.has(value.text) ||
      (value.text === "undefined" && !sourceHasRuntimeBinding(scope.sourceFile, "undefined"))
    );
  }
  if (
    ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(
      value.kind,
    )
  ) {
    return true;
  }

  if (ts.isPrefixUnaryExpression(value)) {
    return (
      value.operator === ts.SyntaxKind.ExclamationToken && pureFlowExpression(value.operand, scope)
    );
  }
  return compoundFlowExpression(value, scope);
}

function compoundFlowExpression(value: ts.Expression, scope: ExpressionScope): boolean {
  if (ts.isBinaryExpression(value)) {
    return (
      safeBinary(value) &&
      pureFlowExpression(value.left, scope) &&
      pureFlowExpression(value.right, scope)
    );
  }
  if (ts.isConditionalExpression(value)) {
    return (
      pureFlowExpression(value.condition, scope) &&
      pureFlowExpression(value.whenTrue, scope) &&
      pureFlowExpression(value.whenFalse, scope)
    );
  }
  return ts.isPropertyAccessExpression(value)
    ? pureFlowExpression(value.expression, scope)
    : pureStringCall(value, scope);
}

function pureStringCall(value: ts.Expression, scope: ExpressionScope): boolean {
  return (
    ts.isCallExpression(value) &&
    ts.isIdentifier(value.expression) &&
    value.expression.text === "String" &&
    !sourceHasRuntimeBinding(scope.sourceFile, "String") &&
    value.arguments.length === 1 &&
    primitiveExpression(value.arguments[0]!, scope) &&
    pureFlowExpression(value.arguments[0]!, scope)
  );
}

function safeBinary(expression: ts.BinaryExpression): boolean {
  return [
    ts.SyntaxKind.QuestionQuestionToken,
    ts.SyntaxKind.BarBarToken,
    ts.SyntaxKind.AmpersandAmpersandToken,
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ].includes(expression.operatorToken.kind);
}

/** Closed memo projections may build a private string array, but cannot mutate or call external code. */
export function pureMemoProjection(call: ts.CallExpression, scope: ExpressionScope): boolean {
  const [callback, dependencies] = call.arguments;
  if (
    call.arguments.length !== MEMO_ARGUMENT_COUNT ||
    !callback ||
    !ts.isArrowFunction(callback) ||
    callback.parameters.length > 0 ||
    !dependencies ||
    !ts.isArrayLiteralExpression(dependencies) ||
    !dependencies.elements.every(ts.isIdentifier)
  ) {
    return false;
  }
  const deps = new Set(dependencies.elements.filter(ts.isIdentifier).map((node) => node.text));
  if ([...deps].some((name) => !scope.names.has(name))) {
    return false;
  }
  if (!memoDependenciesClosed(callback, deps, scope)) {
    return false;
  }
  const arrays = new Set<string>();
  return ts.isBlock(callback.body)
    ? callback.body.statements.every((statement) => pureMemoStatement(statement, scope, arrays))
    : pureFlowExpression(callback.body, scope);
}

function memoDependenciesClosed(
  callback: ts.ArrowFunction,
  deps: ReadonlySet<string>,
  scope: ExpressionScope,
): boolean {
  let closed = true;
  visit(callback.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      !isNonValueIdentifier(node) &&
      scope.names.has(node.text) &&
      !deps.has(node.text)
    ) {
      closed = false;
    }
  });
  return closed;
}

function pureMemoStatement(
  statement: ts.Statement,
  scope: ExpressionScope,
  arrays: Set<string>,
): boolean {
  if (ts.isBlock(statement)) {
    const localArrays = new Set(arrays);
    return statement.statements.every((node) => pureMemoStatement(node, scope, localArrays));
  }
  if (ts.isIfStatement(statement)) {
    return (
      pureFlowExpression(statement.expression, scope) &&
      pureMemoStatement(statement.thenStatement, scope, new Set(arrays)) &&
      (!statement.elseStatement ||
        pureMemoStatement(statement.elseStatement, scope, new Set(arrays)))
    );
  }
  if (ts.isReturnStatement(statement)) {
    return (
      statement.expression !== undefined &&
      (pureFlowExpression(statement.expression, scope) ||
        privateArrayCall(statement.expression, "join", { ...scope, arrays }))
    );
  }
  if (ts.isExpressionStatement(statement)) {
    return privateArrayCall(statement.expression, "push", { ...scope, arrays });
  }
  return privateArrayDeclaration(statement, scope, arrays);
}

function privateArrayDeclaration(
  statement: ts.Statement,
  scope: ExpressionScope,
  arrays: Set<string>,
): boolean {
  if (
    !ts.isVariableStatement(statement) ||
    !(statement.declarationList.flags & ts.NodeFlags.Const)
  ) {
    return false;
  }
  return statement.declarationList.declarations.every((declaration) => {
    if (
      !ts.isIdentifier(declaration.name) ||
      scope.names.has(declaration.name.text) ||
      arrays.has(declaration.name.text) ||
      !declaration.initializer ||
      !ts.isArrayLiteralExpression(declaration.initializer) ||
      declaration.initializer.elements.length > 0 ||
      !declaration.type ||
      !ts.isArrayTypeNode(declaration.type) ||
      declaration.type.elementType.kind !== ts.SyntaxKind.StringKeyword
    ) {
      return false;
    }
    arrays.add(declaration.name.text);
    return true;
  });
}

function privateArrayCall(
  expression: ts.Expression,
  method: "join" | "push",
  scope: ExpressionScope & { arrays: ReadonlySet<string> },
): boolean {
  return (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    scope.arrays.has(expression.expression.expression.text) &&
    expression.expression.name.text === method &&
    expression.arguments.every((argument) => pureFlowExpression(argument, scope))
  );
}
