import { findAncestor, visit } from "../../core/ast.js";
import { EMPTY_BINDINGS } from "./jsx-subtrees.js";
import { isSafeProjectionExpression } from "../deferred-reveal/safe-projections.js";
import ts from "typescript";
import { uniqueVariableDeclaration } from "./binding-lookup.js";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

export function expressionIsUniquelyFiltered(
  expression: ts.Expression,
  boundary: ts.Node,
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(value)) {
    return constInitializerIsUniquelyFiltered(value, boundary);
  }
  if (
    !ts.isCallExpression(value) ||
    !ts.isPropertyAccessExpression(value.expression) ||
    value.expression.name.text !== "filter"
  ) {
    return false;
  }
  return (
    isExactUniquenessFilter(value, boundary) ||
    (isPureSubsetFilter(value, boundary) &&
      expressionIsUniquelyFiltered(value.expression.expression, boundary))
  );
}

/** The name resolves to a unique `const` whose initializer is itself uniquely filtered. */
function constInitializerIsUniquelyFiltered(name: ts.Identifier, boundary: ts.Node): boolean {
  const declaration = uniqueVariableDeclaration(boundary, name.text);
  return (
    declaration !== null &&
    declaration.initializer !== undefined &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
    expressionIsUniquelyFiltered(declaration.initializer, boundary)
  );
}

function isPureSubsetFilter(call: ts.CallExpression, boundary: ts.Node): boolean {
  const [callback] = call.arguments;
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    ts.isBlock(callback.body)
  ) {
    return false;
  }
  const allowedCalls = new Set<string>();
  let callsAreReadOnly = true;
  visit(callback.body, (node) => {
    if (!ts.isCallExpression(node)) {
      return;
    }
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "includes" &&
      ts.isIdentifier(node.expression.expression) &&
      expressionHasArrayType(node.expression.expression, boundary)
    ) {
      allowedCalls.add(`${node.expression.expression.text}.includes`);
    } else {
      callsAreReadOnly = false;
    }
  });
  return (
    callsAreReadOnly &&
    isSafeProjectionExpression({
      expression: callback.body,
      reference: callback.body,
      allowedIdentifierCalls: EMPTY_BINDINGS,
      allowedPropertyCalls: allowedCalls,
    })
  );
}

function isExactUniquenessFilter(call: ts.CallExpression, boundary: ts.Node): boolean {
  if (
    !ts.isPropertyAccessExpression(call.expression) ||
    !expressionHasArrayType(call.expression.expression, boundary)
  ) {
    return false;
  }
  const [callback] = call.arguments;
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return false;
  }
  const [item, index, array] = callback.parameters.map((parameter) => parameter.name);
  if (
    !item ||
    !index ||
    !array ||
    !ts.isIdentifier(item) ||
    !ts.isIdentifier(index) ||
    !ts.isIdentifier(array)
  ) {
    return false;
  }
  const body = concisePredicateBody(callback);
  return body !== null && isIndexOfIdentityComparison(body, { array, index, item });
}

/** The single returned expression of a predicate, written concisely or as a one-statement block. */
function concisePredicateBody(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): ts.Expression | null {
  const { body } = callback;
  if (!ts.isBlock(body)) {
    return body;
  }
  const [onlyStatement] = body.statements;
  return body.statements.length === 1 && onlyStatement && ts.isReturnStatement(onlyStatement)
    ? (onlyStatement.expression ?? null)
    : null;
}

/** The three parameters of the canonical de-duplication predicate. */
interface UniquenessFilterParameters {
  readonly array: ts.Identifier;
  readonly index: ts.Identifier;
  readonly item: ts.Identifier;
}

/** `array.indexOf(item) === index`, which keeps only the first occurrence of each element. */
function isIndexOfIdentityComparison(
  body: ts.Expression,
  parameters: UniquenessFilterParameters,
): boolean {
  const comparison = unwrapTransparentExpression(body);
  if (
    !ts.isBinaryExpression(comparison) ||
    comparison.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
  ) {
    return false;
  }
  return (
    isIndexOfItem(comparison.left, parameters.array.text, parameters.item.text) &&
    ts.isIdentifier(comparison.right) &&
    comparison.right.text === parameters.index.text
  );
}

function expressionHasArrayType(expression: ts.Expression, boundary: ts.Node): boolean {
  const value = unwrapParentheses(expression);
  if (ts.isArrayLiteralExpression(value)) {
    return true;
  }
  if (ts.isAsExpression(value) || ts.isTypeAssertionExpression(value)) {
    return ts.isArrayTypeNode(value.type);
  }
  if (!ts.isIdentifier(value)) {
    return false;
  }
  const types = declaredTypesOfName(boundary.getSourceFile(), value.text);
  return types.length === 1 && ts.isArrayTypeNode(types[0]!);
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let value = expression;
  while (ts.isParenthesizedExpression(value)) {
    value = value.expression;
  }
  return value;
}

/** Every written type annotation that binds the given name anywhere in the file. */
function declaredTypesOfName(sourceFile: ts.SourceFile, name: string): ts.TypeNode[] {
  const types: ts.TypeNode[] = [];
  visit(sourceFile, (node) => {
    const type = boundNameType(node, name);
    if (type) {
      types.push(type);
    }
  });
  return types;
}

function boundNameType(node: ts.Node, name: string): ts.TypeNode | undefined {
  if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && node.name.text === name) {
    return destructuredBindingType(node);
  }
  if (
    (!ts.isParameter(node) && !ts.isVariableDeclaration(node)) ||
    !ts.isIdentifier(node.name) ||
    node.name.text !== name
  ) {
    return undefined;
  }
  return node.type;
}

function destructuredBindingType(binding: ts.BindingElement): ts.TypeNode | undefined {
  const declaration = findAncestor(
    binding,
    (node): node is ts.ParameterDeclaration | ts.VariableDeclaration =>
      ts.isParameter(node) || ts.isVariableDeclaration(node),
  );
  if (!declaration?.type || !ts.isTypeLiteralNode(declaration.type)) {
    return undefined;
  }
  const sourceName = binding.propertyName?.getText() ?? binding.name.getText();
  const property = declaration.type.members.find(
    (member) => ts.isPropertySignature(member) && member.name?.getText() === sourceName,
  );
  return property && ts.isPropertySignature(property) ? property.type : undefined;
}

function isIndexOfItem(expression: ts.Expression, array: string, item: string): boolean {
  const value = unwrapTransparentExpression(expression);
  const argument = ts.isCallExpression(value) ? value.arguments[0] : undefined;
  return (
    ts.isCallExpression(value) &&
    value.arguments.length === 1 &&
    ts.isPropertyAccessExpression(value.expression) &&
    value.expression.name.text === "indexOf" &&
    ts.isIdentifier(value.expression.expression) &&
    value.expression.expression.text === array &&
    argument !== undefined &&
    ts.isIdentifier(argument) &&
    argument.text === item
  );
}
