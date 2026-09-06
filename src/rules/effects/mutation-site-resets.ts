import type { EffectCandidate, StateCandidate } from "../../analysis/model.js";
import type { EffectClassificationContext } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { allSetterReferencesAreEventBoundaries } from "./setter-event-boundaries.js";
import { soleDirectSetterCall } from "./callback-shape.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

interface MutationSiteReset {
  sources: readonly StateCandidate[];
  target: StateCandidate;
}

export function findMutationSiteReset(
  effect: EffectCandidate,
  context: EffectClassificationContext,
): MutationSiteReset | null {
  const sources = dependencySourceStates(effect, context.stateByValue);
  if (!effect.callback || !effect.owner || !sources) {
    return null;
  }
  const target = resetTargetState(effect.callback, effect.owner, context);
  if (!target || sources.includes(target)) {
    return null;
  }
  return sources.every((source) => setterOnlyMutatesAtEventBoundaries(source, context))
    ? { sources, target }
    : null;
}

function dependencySourceStates(
  effect: EffectCandidate,
  stateByValue: ReadonlyMap<string, StateCandidate>,
): readonly StateCandidate[] | null {
  const { dependencies, owner } = effect;
  if (!owner || !dependencies || dependencies.elements.length === 0) {
    return null;
  }
  const sourceNames = dependencies.elements.flatMap((element) =>
    ts.isIdentifier(element) ? [element.text] : [],
  );
  if (sourceNames.length !== dependencies.elements.length) {
    return null;
  }
  const sources = sourceNames.flatMap((name) => {
    const state = stateByValue.get(name);
    return state && state.owner === owner ? [state] : [];
  });
  return sources.length === sourceNames.length && new Set(sources).size === sources.length
    ? sources
    : null;
}

function resetTargetState(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
  context: EffectClassificationContext,
): StateCandidate | null {
  const setterCall = soleDirectSetterCall(callback, context.stateBySetter);
  const target = setterCall ? context.stateBySetter.get(setterCall.expression.text) : undefined;
  if (!setterCall || !target || target.owner !== owner) {
    return null;
  }
  const [initializer] = target.call.arguments;
  const [reset] = setterCall.arguments;
  if (
    !initializer ||
    !reset ||
    !nodesHaveSameText(initializer, reset) ||
    !isStablePrimitiveReset(initializer)
  ) {
    return null;
  }
  const targetUsage = target.setterName ? context.usageBySetter.get(target.setterName) : undefined;
  return targetUsage && targetUsage.setterCalls > targetUsage.effectWrites ? target : null;
}

function setterOnlyMutatesAtEventBoundaries(
  source: StateCandidate,
  context: EffectClassificationContext,
): boolean {
  if (!source.setterName) {
    return false;
  }
  const usage = context.usageBySetter.get(source.setterName);
  return (
    usage !== undefined &&
    !usage.shadowed &&
    !usage.escaped &&
    usage.effectWrites === 0 &&
    usage.setterReferences !== 0 &&
    allSetterReferencesAreEventBoundaries(source, context.childContracts)
  );
}

function isStablePrimitiveReset(expression: ts.Expression): boolean {
  const value = unwrapTransparentExpression(expression);
  return (
    value.kind === ts.SyntaxKind.NullKeyword ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    ts.isBigIntLiteral(value) ||
    ts.isNoSubstitutionTemplateLiteral(value) ||
    (ts.isPrefixUnaryExpression(value) &&
      (value.operator === ts.SyntaxKind.PlusToken || value.operator === ts.SyntaxKind.MinusToken) &&
      (ts.isNumericLiteral(value.operand) || ts.isBigIntLiteral(value.operand)))
  );
}

function nodesHaveSameText(left: ts.Node, right: ts.Node): boolean {
  return left.getText(left.getSourceFile()) === right.getText(right.getSourceFile());
}
