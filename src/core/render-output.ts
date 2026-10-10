import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
  outermostTransparentParent,
} from "./analysis-ast.js";
import type { RuntimeFunctionLike } from "./ast.js";
import { identifiersNamed } from "./ast.js";
import ts from "typescript";

const FORWARDING_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

/**
 * The render-body value reaches `owner`'s returned output as itself: returned directly, or as a
 * JSX child, attribute, or spread of the returned element tree, through parentheses, conditional
 * branches, and logical operands. The React Compiler memoizes every value that escapes this way,
 * so it caches the call that produced it.
 */
export function reachesRenderOutput(value: ts.Expression, owner: RuntimeFunctionLike): boolean {
  if (flowsIntoReturn(value, owner)) {
    return true;
  }
  const declaration = outermostTransparentParent(value).parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) ||
    bindingDeclarationCount(owner, declaration.name.text) !== 1
  ) {
    return false;
  }
  return identifiersNamed(owner, declaration.name.text).some(
    (reference) =>
      !isDeclarationName(reference) &&
      !isNonValueIdentifier(reference) &&
      flowsIntoReturn(reference, owner),
  );
}

function flowsIntoReturn(value: ts.Expression, owner: RuntimeFunctionLike): boolean {
  let current: ts.Node = outermostTransparentParent(value);
  for (;;) {
    const { parent } = current;
    if (isJsxCarrier(parent) || forwardsOperand(current, parent)) {
      current = ts.isExpression(parent) ? outermostTransparentParent(parent) : parent;
      continue;
    }
    if (ts.isReturnStatement(parent)) {
      return enclosingFunction(parent) === owner;
    }
    return ts.isArrowFunction(parent) && parent === owner && parent.body === current;
  }
}

function isJsxCarrier(node: ts.Node): boolean {
  return (
    ts.isJsxExpression(node) ||
    ts.isJsxAttribute(node) ||
    ts.isJsxAttributes(node) ||
    ts.isJsxSpreadAttribute(node) ||
    ts.isJsxOpeningElement(node) ||
    ts.isJsxSelfClosingElement(node) ||
    ts.isJsxElement(node) ||
    ts.isJsxFragment(node)
  );
}

function forwardsOperand(operand: ts.Node, parent: ts.Node): boolean {
  if (ts.isConditionalExpression(parent)) {
    return parent.condition !== operand;
  }
  return ts.isBinaryExpression(parent) && FORWARDING_OPERATORS.has(parent.operatorToken.kind);
}

function enclosingFunction(node: ts.Node): ts.Node | null {
  for (let current = node.parent; !ts.isSourceFile(current); current = current.parent) {
    if (ts.isFunctionLike(current)) {
      return current;
    }
  }
  return null;
}
