import { bindingContainsName, uniqueVariableDeclaration } from "../state-proofs/binding-lookup.js";
import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
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
    if (
      !ts.isIdentifier(node) ||
      node.text !== name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const { parent } = node;
    if (
      (ts.isBinaryExpression(parent) &&
        parent.left === node &&
        parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
      ts.isPostfixUnaryExpression(parent) ||
      (ts.isPrefixUnaryExpression(parent) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(parent.operator))
    ) {
      written = true;
    }
  });
  return written;
}
