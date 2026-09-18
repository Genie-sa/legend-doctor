import {
  bindingDeclarationCount,
  isAssignmentOperator,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { isUseValueCall, provenObservablePath } from "./observable-paths.js";
import type { ObservableReadScan } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { hasStableIndependentBindings } from "./independent-subscription-bindings.js";
import { propBindingDoesNotEscape } from "./owner-class-prop-reads.js";
import ts from "typescript";
import { uniqueVariableDeclaration } from "../state-proofs/binding-lookup.js";
import { visit } from "../../core/ast.js";

interface Scope {
  owner: RuntimeFunctionLike;
  scan: ObservableReadScan;
}

/** Primitive output alone says nothing about mutations or getters used to produce it. */
export function stableClassEvaluation(expression: ts.Expression, scope: Scope): boolean {
  return stableEvaluation(expression, scope, new Set());
}

function stableEvaluation(
  expression: ts.Expression,
  scope: Scope,
  seen: ReadonlySet<ts.Node>,
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (literal(value)) {
    return true;
  }
  if (ts.isIdentifier(value)) {
    return stableIdentifier(value, scope, seen);
  }
  if (ts.isPropertyAccessExpression(value)) {
    return provenPropRead(value, scope);
  }
  if (ts.isCallExpression(value)) {
    return directSubscription(value, scope);
  }
  return stableComposite(value, scope, seen);
}

function stableComposite(value: ts.Expression, scope: Scope, seen: ReadonlySet<ts.Node>): boolean {
  if (ts.isPrefixUnaryExpression(value)) {
    return (
      value.operator === ts.SyntaxKind.ExclamationToken &&
      stableEvaluation(value.operand, scope, seen)
    );
  }
  if (ts.isConditionalExpression(value)) {
    return [value.condition, value.whenTrue, value.whenFalse].every((part) =>
      stableEvaluation(part, scope, seen),
    );
  }
  return (
    ts.isBinaryExpression(value) &&
    [
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ].includes(value.operatorToken.kind) &&
    stableEvaluation(value.left, scope, seen) &&
    stableEvaluation(value.right, scope, seen)
  );
}

function literal(value: ts.Expression): boolean {
  return (
    ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(
      value.kind,
    )
  );
}

function stableIdentifier(value: ts.Identifier, scope: Scope, seen: ReadonlySet<ts.Node>): boolean {
  const { owner } = scope;
  if (bindingDeclarationCount(owner, value.text) !== 1 || bindingIsWritten(owner, value.text)) {
    return false;
  }
  if (parameterBinding(owner, value.text)) {
    return true;
  }
  const declaration = uniqueVariableDeclaration(owner, value.text);
  if (
    !declaration?.initializer ||
    !(declaration.parent.flags & ts.NodeFlags.Const) ||
    seen.has(declaration)
  ) {
    return false;
  }
  const initializer = unwrapTransparentExpression(declaration.initializer);
  return stableEvaluation(initializer, scope, new Set([...seen, declaration]));
}

function directSubscription(call: ts.CallExpression, { owner, scan }: Scope): boolean {
  return (
    ts.isIdentifier(call.expression) &&
    bindingDeclarationCount(owner, call.expression.text) === 0 &&
    isUseValueCall(call, scan.imports) &&
    call.arguments.length === 1 &&
    hasStableIndependentBindings({ call, observable: call.arguments[0]! }) &&
    provenObservablePath(call.arguments[0]!, scan.observableBindings) !== null
  );
}

function parameterBinding(owner: RuntimeFunctionLike, name: string): ts.BindingElement | null {
  const [parameter] = owner.parameters;
  if (
    owner.parameters.length !== 1 ||
    !parameter ||
    !ts.isObjectBindingPattern(parameter.name) ||
    parameter.dotDotDotToken ||
    parameter.name.elements.some(
      (element) =>
        element.dotDotDotToken ||
        (element.initializer && !literal(element.initializer)) ||
        (element.propertyName && !ts.isIdentifier(element.propertyName)),
    ) ||
    (parameter.initializer &&
      (!ts.isObjectLiteralExpression(parameter.initializer) ||
        parameter.initializer.properties.length > 0))
  ) {
    return null;
  }
  const binding = parameter.name.elements.find(
    (element) => ts.isIdentifier(element.name) && element.name.text === name,
  );
  return binding &&
    !binding.dotDotDotToken &&
    (!binding.propertyName || ts.isIdentifier(binding.propertyName)) &&
    (!binding.initializer || literal(binding.initializer))
    ? binding
    : null;
}

function provenPropRead(expression: ts.PropertyAccessExpression, { owner, scan }: Scope): boolean {
  if (!expression.questionDotToken || !ts.isIdentifier(expression.expression)) {
    return false;
  }
  const root = expression.expression;
  if (
    !ts.isIdentifier(root) ||
    bindingDeclarationCount(owner, root.text) !== 1 ||
    bindingIsWritten(owner, root.text)
  ) {
    return false;
  }
  const binding = parameterBinding(owner, root.text);
  if (!binding || !propBindingDoesNotEscape(root.text, owner, scan)) {
    return false;
  }
  return (
    scan.childContracts?.componentPropDataPath?.(owner, [
      binding.propertyName?.getText() ?? root.text,
      expression.name.text,
    ]) ?? false
  );
}

function bindingIsWritten(owner: RuntimeFunctionLike, name: string): boolean {
  let written = false;
  visit(owner.body, (node) => {
    const target = writeTarget(node);
    if (target) {
      visit(target, (part) => {
        if (ts.isIdentifier(part) && part.text === name) {
          written = true;
        }
      });
    }
  });
  return written;
}

function writeTarget(node: ts.Node): ts.Expression | null {
  if (ts.isDeleteExpression(node)) {
    return node.expression;
  }
  if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
    return node.left;
  }
  if (
    ts.isPostfixUnaryExpression(node) ||
    (ts.isPrefixUnaryExpression(node) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator))
  ) {
    return node.operand;
  }
  return null;
}
