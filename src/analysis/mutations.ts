import type { CoexecutionScope, SetterMutation, StateCandidate, StateUsage } from "./model.js";
import { findAncestor, findAncestorUntil, isRuntimeFunctionLike } from "../core/ast.js";
import { PURE_MATH_METHODS } from "./constants.js";
import type { RuntimeFunctionLike } from "../core/ast.js";
import type { StateFlowIndex } from "../project/state-flow/state-flow.js";
import { hasDirectPrimitiveInitializer } from "../rules/state-proofs/state-proofs.js";
import { isPureExpression } from "../core/analysis-ast.js";
import { isUnshadowedMathCall } from "../rules/state-proofs/binding-lookup.js";
import ts from "typescript";

export function mutationsWriteTogether(
  left: SetterMutation,
  right: SetterMutation,
  stateFlow: StateFlowIndex,
): boolean {
  return (
    left.region === right.region &&
    (callsAreAdjacentDraftWrites(left.call, right.call) ||
      mutationsAreProvenCoexecuting(left.call, right.call, { region: left.region, stateFlow }))
  );
}

export function callsAreAdjacentDraftWrites(
  left: ts.CallExpression,
  right: ts.CallExpression,
): boolean {
  const leftStatement = left.parent;
  const rightStatement = right.parent;
  if (
    !ts.isExpressionStatement(leftStatement) ||
    leftStatement.expression !== left ||
    !ts.isExpressionStatement(rightStatement) ||
    rightStatement.expression !== right ||
    leftStatement.parent !== rightStatement.parent
  ) {
    return false;
  }
  const { parent } = leftStatement;
  const statements =
    ts.isBlock(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent)
      ? parent.statements
      : null;
  if (statements === null) {
    return false;
  }
  return Math.abs(statements.indexOf(leftStatement) - statements.indexOf(rightStatement)) === 1;
}

export function isControlledBooleanTransition(mutation: SetterMutation): boolean {
  const [argument] = mutation.call.arguments;
  if (!argument || !ts.isIdentifier(argument)) {
    return false;
  }
  const callback = isInlineRuntimeCallback(mutation.region) ? mutation.region : null;
  const parameter = callback?.parameters[0];
  if (!parameter || !ts.isIdentifier(parameter.name) || parameter.name.text !== argument.text) {
    return false;
  }
  const attribute = callback ? findAncestor(callback, ts.isJsxAttribute) : null;
  return (
    attribute !== null &&
    /^(?:onOpen|onVisible|onExpanded)Change(?:Complete)?$/u.test(attribute.name.getText())
  );
}

function isInlineRuntimeCallback(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

export function callSetsLiteral(mutation: SetterMutation, kind: ts.SyntaxKind): boolean {
  return mutation.call.arguments.length === 1 && mutation.call.arguments[0]?.kind === kind;
}

export function primitiveSetterUpdatersArePure(state: StateCandidate, usage: StateUsage): boolean {
  if (!hasDirectPrimitiveInitializer(state)) {
    return true;
  }
  return usage.setterCallNodes.every((call) => {
    const [argument] = call.arguments;
    return (
      !argument ||
      (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument)) ||
      isPureExpression(argument, (mathCall) =>
        isUnshadowedMathCall(state.owner, mathCall, PURE_MATH_METHODS),
      )
    );
  });
}

export function nearestMutationFunction(
  node: ts.Node,
  owner: RuntimeFunctionLike,
): RuntimeFunctionLike {
  return findAncestorUntil(node, isRuntimeFunctionLike, owner) ?? owner;
}

export function mutationsAreProvenCoexecuting(
  left: ts.CallExpression,
  right: ts.CallExpression,
  { region, stateFlow }: CoexecutionScope,
): boolean {
  return stateFlow.proveSynchronousCoexecution(region, left, right) === "proven";
}

export function mutationsMayCoexecute(
  left: ts.CallExpression,
  right: ts.CallExpression,
  { region, stateFlow }: CoexecutionScope,
): boolean {
  return stateFlow.proveSynchronousCoexecution(region, left, right) !== "disproven";
}
