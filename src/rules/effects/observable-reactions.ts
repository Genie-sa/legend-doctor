import type { ClassifiedEffect, EffectCandidate } from "../../analysis/model.js";
import { calledCode, incidentalObservableReads } from "./incidental-observable-reads.js";
import { identifiersNamed, nearestNestedFunction, nodeWithin, visit } from "../../core/ast.js";
import {
  isDeclarationName,
  isNonValueIdentifier,
  rootIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import {
  keepParentRenderedReactionEffect,
  keepRenderedReactionEffect,
  observeEffect,
  reviewParentRenderedReactionEffect,
  reviewUntrackableCallEffect,
  reviewUntrackableReadsEffect,
} from "./effect-verdicts.js";
import type { EffectStateDependencies } from "./state-independent-effects.js";
import type { InlineEffectContext } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { localReachResolver } from "../../project/source-components/reach-resolvers.js";
import ts from "typescript";

/** Legend writes, including the array and set mutations an observable proxies. */
const OBSERVABLE_WRITE_PATTERN =
  /^(?:add|assign|clear|delete|pop|push|reverse|set|shift|sort|splice|toggle|unshift)$/u;

/** A dependency effect whose every dependency is a `useValue` snapshot or a stable `useObservable` handle. */
export function observableReactionClassification(
  effect: EffectCandidate,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  inline: InlineEffectContext,
): ClassifiedEffect {
  const { owner } = effect;
  return owner && useValueDependenciesAreEffectOnly(effect, inline)
    ? unrenderedReactionClassification({ callback, inline, owner, effect })
    : keepRenderedReactionEffect(inline.subscriptionHook);
}

/** A reaction whose `useValue` dependencies render nothing in the owner. */
function unrenderedReactionClassification({
  callback,
  effect,
  inline,
  owner,
}: {
  callback: ts.ArrowFunction | ts.FunctionExpression;
  effect: EffectCandidate;
  inline: InlineEffectContext;
  owner: RuntimeFunctionLike;
}): ClassifiedEffect {
  const sources = useValueDependencySources(effect, owner, inline);
  const parentRerender = inline.childContracts?.componentParentRerender(owner, sources) ?? "absent";
  if (parentRerender === "proven") {
    return keepParentRenderedReactionEffect(inline.subscriptionHook);
  }
  if (parentRerender === "possible") {
    return reviewParentRenderedReactionEffect(inline.subscriptionHook);
  }
  const reads = incidentalObservableReads({ callback, inline, owner, sources });
  if (reads.kind === "peek") {
    return observeEffect(reads.reads, inline.subscriptionHook);
  }
  return reads.kind === "untrackable-call"
    ? reviewUntrackableCallEffect(reads.callee)
    : reviewUntrackableReadsEffect();
}

/** The observable argument of each `useValue` call whose result the effect lists as a dependency. */
function useValueDependencySources(
  effect: EffectCandidate,
  owner: RuntimeFunctionLike,
  inline: InlineEffectContext,
): ts.Expression[] {
  return (effect.dependencies?.elements ?? []).flatMap((element) => {
    if (!ts.isIdentifier(element) || !inline.useValueBindings.has(element.text)) {
      return [];
    }
    const declaration = identifiersNamed(owner.body, element.text).find((reference) =>
      isDeclarationName(reference),
    )?.parent;
    const call =
      declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : null;
    const source = call && ts.isCallExpression(call) ? call.arguments[0] : undefined;
    return source ? [source] : [];
  });
}

function useValueDependenciesAreEffectOnly(
  effect: EffectCandidate,
  inline: InlineEffectContext,
): boolean {
  const { call, dependencies, owner } = effect;
  if (!owner || !dependencies) {
    return false;
  }
  return dependencies.elements.every(
    (element) =>
      !ts.isIdentifier(element) ||
      !inline.useValueBindings.has(element.text) ||
      identifiersNamed(owner.body, element.text).every(
        (reference) =>
          isDeclarationName(reference) ||
          isNonValueIdentifier(reference) ||
          nodeWithin(reference, call),
      ),
  );
}

/**
 * An effect that writes no React state or observable causes no render, and when the owner renders
 * every value that schedules it, an observable reaction keeps those subscriptions and removes none.
 */
export function isRenderlessReaction(
  effect: EffectCandidate,
  { body, scheduled }: EffectStateDependencies,
  inline: InlineEffectContext,
): boolean {
  return (
    body?.kind !== "unresolved" &&
    scheduled.every(
      ({ kind, name }) =>
        (kind === "legend" && inline.useObservableBindings.has(name)) ||
        ((kind === "legend" || kind === "value") && rendersOutsideEffect(name, effect)),
    ) &&
    !callsUnseenWriter(effect, inline)
  );
}

function rendersOutsideEffect(name: string, { call, owner }: EffectCandidate): boolean {
  return identifiersNamed(owner?.body, name).some(
    (reference) =>
      owner !== null &&
      nearestNestedFunction(reference, owner) === null &&
      !isDeclarationName(reference) &&
      !isNonValueIdentifier(reference) &&
      !nodeWithin(reference, call),
  );
}

/** An observable write, or a call into, or handing over, application code that may write one. */
function callsUnseenWriter(
  { callback }: EffectCandidate,
  { childContracts, stateByValue, useValueBindings }: InlineEffectContext,
): boolean {
  const resolver = childContracts?.reachResolver?.() ?? localReachResolver;
  const snapshot = (expression: ts.Expression): boolean => {
    const name = rootIdentifier(expression)?.text ?? "";
    return stateByValue.has(name) || useValueBindings.has(name);
  };
  const runsCode = (expression: ts.Expression): boolean => {
    const root = rootIdentifier(expression);
    return root !== null && calledCode(root, expression, resolver).kind !== "external";
  };
  let writes = false;
  visit(callback?.body, (node) => {
    if (ts.isCallExpression(node)) {
      const callee = unwrapTransparentExpression(node.expression);
      writes ||=
        (ts.isPropertyAccessExpression(callee) &&
          OBSERVABLE_WRITE_PATTERN.test(callee.name.text)) ||
        runsCode(callee) ||
        snapshot(callee) ||
        node.arguments.some((argument) => runsCode(argument) && !snapshot(argument));
    }
  });
  return writes;
}
