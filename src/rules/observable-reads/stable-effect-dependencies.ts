import { bindingContainsName, uniqueVariableDeclaration } from "../state-proofs/binding-lookup.js";
import {
  bindingDeclarationCount,
  isAssignmentOperator,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import {
  isReactEffectCall,
  resolveLifecycleCallback,
} from "../react-commit-sensitivity/effect-lifecycle.js";
import type { ObservableReadScan } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { primitiveType } from "./primitive-paths.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

/** An independent literal/primitive prop dependency does not change on a subscription-only render. */
export function hasStableEffectDependencies(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): boolean {
  if (!isReactEffectCall(call, scan.imports) || !call.arguments[0]) {
    return false;
  }
  const callback = resolveLifecycleCallback(call.arguments[0], {
    owner,
    imports: scan.imports,
    seen: new Set(),
  });
  const [, dependencies] = call.arguments;
  return (
    callback !== null &&
    dependencies !== undefined &&
    ts.isArrayLiteralExpression(dependencies) &&
    dependencies.elements.every((dependency) => stablePrimitiveDependency(dependency, owner))
  );
}

export function stablePrimitiveDependency(
  expression: ts.Expression,
  owner: RuntimeFunctionLike,
): boolean {
  if (
    ts.isStringLiteralLike(expression) ||
    ts.isNumericLiteral(expression) ||
    [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(
      expression.kind,
    )
  ) {
    return true;
  }
  if (!ts.isIdentifier(expression) || bindingDeclarationCount(owner, expression.text) !== 1) {
    return false;
  }
  const name = expression.text;
  const parameter = owner.parameters.find((candidate) => bindingContainsName(candidate.name, name));
  if (parameter) {
    return parameterPrimitive(parameter, name) && !bindingWritten(owner, name);
  }
  const declaration = uniqueVariableDeclaration(owner, name);
  return (
    declaration !== null &&
    declaration.initializer !== undefined &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
    (ts.isStringLiteralLike(declaration.initializer) ||
      ts.isNumericLiteral(declaration.initializer))
  );
}

function parameterPrimitive(parameter: ts.ParameterDeclaration, name: string): boolean {
  if (!parameter.type || parameter.initializer || parameter.dotDotDotToken) {
    return false;
  }
  if (ts.isIdentifier(parameter.name)) {
    return primitiveType(parameter.type);
  }
  if (!ts.isObjectBindingPattern(parameter.name) || !ts.isTypeLiteralNode(parameter.type)) {
    return false;
  }
  const binding = parameter.name.elements.find(
    (element) => ts.isIdentifier(element.name) && element.name.text === name,
  );
  if (!binding || binding.initializer || binding.dotDotDotToken) {
    return false;
  }

  return parameter.type.members.some(
    (member) =>
      ts.isPropertySignature(member) &&
      member.name.getText() === (binding.propertyName?.getText() ?? name) &&
      member.type !== undefined &&
      primitiveType(member.type),
  );
}

function bindingWritten(owner: RuntimeFunctionLike, name: string): boolean {
  let written = false;
  visit(owner.body, (node) => {
    const target = assignmentTarget(node);
    if (target && targetWritesBinding(target, name)) {
      written = true;
    }
  });
  return written;
}

function assignmentTarget(node: ts.Node): ts.Expression | null {
  if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
    return node.left;
  }
  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    return ts.isVariableDeclarationList(node.initializer) ? null : node.initializer;
  }
  return ts.isPostfixUnaryExpression(node) ||
    (ts.isPrefixUnaryExpression(node) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator))
    ? node.operand
    : null;
}

/** Follow assignment targets only: property receivers, keys, and defaults are reads. */
function targetWritesBinding(expression: ts.Expression, name: string): boolean {
  const target = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(target)) {
    return target.text === name;
  }
  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.some((element) => targetWritesBinding(element, name));
  }
  if (ts.isObjectLiteralExpression(target)) {
    return target.properties.some((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return property.name.text === name;
      }
      if (ts.isPropertyAssignment(property)) {
        return targetWritesBinding(property.initializer, name);
      }
      return ts.isSpreadAssignment(property) && targetWritesBinding(property.expression, name);
    });
  }
  if (ts.isSpreadElement(target)) {
    return targetWritesBinding(target.expression, name);
  }
  return (
    ts.isBinaryExpression(target) &&
    target.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    targetWritesBinding(target.left, name)
  );
}
