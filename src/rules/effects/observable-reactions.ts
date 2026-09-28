import type { ClassifiedEffect, EffectCandidate } from "../../analysis/model.js";
import { identifiersNamed, nodeWithin } from "../../core/ast.js";
import { isDeclarationName, isNonValueIdentifier } from "../../core/analysis-ast.js";
import {
  keepParentRenderedReactionEffect,
  keepRenderedReactionEffect,
  observeEffect,
  reviewParentRenderedReactionEffect,
  reviewUntrackableReadsEffect,
} from "./effect-verdicts.js";
import type { InlineEffectContext } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { incidentalObservableReads } from "./incidental-observable-reads.js";
import ts from "typescript";

/** A dependency effect whose every dependency is a `useValue` snapshot or a stable `useObservable` handle. */
export function observableReactionClassification(
  effect: EffectCandidate,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  inline: InlineEffectContext,
): ClassifiedEffect {
  const { owner } = effect;
  return owner && useValueDependenciesAreEffectOnly(effect, inline)
    ? unrenderedReactionClassification({ callback, inline, owner, effect })
    : keepRenderedReactionEffect();
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
    return keepParentRenderedReactionEffect();
  }
  if (parentRerender === "possible") {
    return reviewParentRenderedReactionEffect();
  }
  const peekedReads = incidentalObservableReads({ callback, inline, owner, sources });
  return peekedReads ? observeEffect(peekedReads) : reviewUntrackableReadsEffect();
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
