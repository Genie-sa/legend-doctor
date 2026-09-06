import type { StateCandidate, StateUsage } from "./model.js";
import {
  isDeclarationName,
  isEvaluationInert,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../core/analysis-ast.js";
import { nodeWithin, visit } from "../core/ast.js";
import { nearestMutationFunction } from "./mutations.js";
import ts from "typescript";

export function setterCallsDiscardConfidence(
  calls: readonly ts.CallExpression[],
): "certain" | "probable" | null {
  let confidence: "certain" | "probable" = "certain";
  for (const call of calls) {
    const callConfidence = setterCallDiscardConfidence(call);
    if (!callConfidence) {
      return null;
    }
    if (callConfidence === "probable") {
      confidence = "probable";
    }
  }
  return confidence;
}

function setterCallDiscardConfidence(call: ts.CallExpression): "certain" | "probable" | null {
  const [argument] = call.arguments;
  if (call.arguments.length !== 1 || !argument) {
    return null;
  }
  return discardableExpressionConfidence(argument);
}

export function stateReadsOnlyCalculateOwnSetter(
  state: StateCandidate,
  usage: StateUsage,
): boolean {
  if (
    usage.effectWrites > 0 ||
    usage.setterCallNodes.length === 0 ||
    usage.setterCallNodes.some(
      (call) =>
        nearestMutationFunction(call, state.owner) === state.owner ||
        call.arguments.length !== 1 ||
        !call.arguments[0] ||
        !isEvaluationInert(call.arguments[0]),
    )
  ) {
    return false;
  }

  let reads = 0;
  let safe = true;
  visit(state.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== state.valueName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    reads += 1;
    safe = usage.setterCallNodes.some(
      (call) => call.arguments[0] !== undefined && nodeWithin(node, call.arguments[0]),
    );
  });
  return safe && reads > 0;
}

export function stateOnlyReceivesItsInitialPrimitive(
  state: StateCandidate,
  usage: StateUsage,
): boolean {
  const [initializer] = state.call.arguments;
  if (
    !initializer ||
    usage.setterCallNodes.length === 0 ||
    usage.setterReferences !== usage.setterCalls ||
    usage.shadowed ||
    usage.escaped
  ) {
    return false;
  }
  return usage.setterCallNodes.every(
    (call) =>
      call.arguments.length === 1 &&
      call.arguments[0] !== undefined &&
      samePrimitiveLiteral(initializer, call.arguments[0]),
  );
}

function samePrimitiveLiteral(left: ts.Expression, right: ts.Expression): boolean {
  const leftValue = unwrapTransparentExpression(left);
  const rightValue = unwrapTransparentExpression(right);
  if (leftValue.kind !== rightValue.kind) {
    return false;
  }
  if (
    leftValue.kind === ts.SyntaxKind.NullKeyword ||
    leftValue.kind === ts.SyntaxKind.TrueKeyword ||
    leftValue.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return true;
  }
  return (ts.isStringLiteralLike(leftValue) && ts.isStringLiteralLike(rightValue)) ||
    (ts.isNumericLiteral(leftValue) && ts.isNumericLiteral(rightValue)) ||
    (ts.isBigIntLiteral(leftValue) && ts.isBigIntLiteral(rightValue))
    ? leftValue.text === rightValue.text
    : false;
}

function discardableExpressionConfidence(node: ts.Expression): "certain" | "probable" | null {
  if (isEvaluationInert(node)) {
    return "certain";
  }
  const value = unwrapTransparentExpression(node);
  if (ts.isPropertyAccessExpression(value)) {
    return discardableExpressionConfidence(value.expression) ? "probable" : null;
  }
  if (ts.isArrayLiteralExpression(value)) {
    return combineDiscardConfidence(
      value.elements.map((element) =>
        ts.isSpreadElement(element) ? null : discardableExpressionConfidence(element),
      ),
    );
  }
  if (ts.isObjectLiteralExpression(value)) {
    return combineDiscardConfidence(
      value.properties.map((property) => {
        if (ts.isShorthandPropertyAssignment(property)) {
          return "certain";
        }
        return ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name)
          ? discardableExpressionConfidence(property.initializer)
          : null;
      }),
    );
  }
  return null;
}

function combineDiscardConfidence(
  confidences: readonly ("certain" | "probable" | null)[],
): "certain" | "probable" | null {
  if (confidences.some((confidence) => confidence === null)) {
    return null;
  }
  return confidences.some((confidence) => confidence === "probable") ? "probable" : "certain";
}
