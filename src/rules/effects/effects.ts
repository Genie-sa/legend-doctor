import type { ClassifiedEffect, EffectCandidate, StateCandidate } from "../../analysis/model.js";
import type { EffectClassificationContext, InlineEffectContext } from "./model.js";
import {
  browserStorageClassification,
  persistedObservableClassification,
} from "./browser-storage-persistence.js";
import {
  callbackCallsKnownSetter,
  isSubscriptionCall,
  soleReturnStatementBody,
} from "./callback-shape.js";
import { capturesOwnerSnapshot, isSetupOnlyMountCandidate } from "./setup-only-mount.js";
import {
  committedRefEffect,
  harnessEffect,
  keepExternalIntegrationEffect,
  keepLifecycleEffect,
  keepPairedMountEffect,
  keepRenderedReactionEffect,
  keepStateIndependentEffect,
  keepStateSnapshotEffect,
  observeEffect,
  ownershipDirectiveEffect,
  reviewCausalOwnerEffect,
  reviewEmptyDependencySetupEffect,
  reviewStateReactionEffect,
  reviewStateWritingEffect,
  unmountEffect,
  unresolvedCallbackEffect,
  useMountEffect,
} from "./effect-verdicts.js";
import { findAncestorUntil, identifiersNamed, nodeWithin } from "../../core/ast.js";
import {
  isCommittedPropRefSnapshot,
  isExactCommittedPreviousValueGuard,
  isExactLatestValueRefMirror,
} from "./committed-ref-mirrors.js";
import {
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import type { EffectStateDependency } from "./state-independent-effects.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { analyzeEffectStateDependencies } from "./state-independent-effects.js";
import { callbackIsCommittedRefIntegration } from "./committed-ref-integration.js";
import { callbackReadsSynchronously } from "./synchronous-dependency-reads.js";
import { findMutationSiteReset } from "./mutation-site-resets.js";
import { findPureDerivedSetter } from "./derived-setters.js";
import { isDependencyDrivenExternalCommandEffect } from "./external-command-effects.js";
import ts from "typescript";

const REACT_EFFECT_DIRECTIVE_PATTERN =
  /^(?:react-effect-allow\b|legend-doctor\s+keep-react-effect\b)/u;

export interface EffectClassificationRequest extends EffectClassificationContext {
  readonly effect: EffectCandidate;
  readonly nonProductionHarness: boolean;
}

export function classifyEffect(request: EffectClassificationRequest): ClassifiedEffect {
  const {
    childContracts,
    effect,
    imports,
    legendState,
    moduleScopeBindings,
    nonProductionHarness,
    reactNamespaces,
    stateBySetter,
    stateByValue,
    usageBySetter,
    useObservableBindings,
    useRefBindings,
    useValueBindings,
  } = request;
  if (nonProductionHarness) {
    return harnessEffect();
  }
  if (hasReactEffectOwnershipDirective(effect)) {
    return ownershipDirectiveEffect();
  }
  if (!effect.callback) {
    return unresolvedCallbackEffect();
  }
  const context: EffectClassificationContext = {
    childContracts,
    imports,
    legendState,
    moduleScopeBindings,
    reactNamespaces,
    stateBySetter,
    stateByValue,
    usageBySetter,
    useObservableBindings,
    useRefBindings,
    useValueBindings,
  };
  return classifyInlineEffect(effect, effect.callback, context);
}

function classifyInlineEffect(
  effect: EffectCandidate,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  context: EffectClassificationContext,
): ClassifiedEffect {
  const derivedState = findPureDerivedSetter(callback, effect.dependencies, context);
  if (derivedState) {
    return {
      action: "delete-effect",
      confidence: "certain",
      derivedState,
      message: `Delete this effect and calculate the value passed to \`${derivedState.setterName}\` directly during render.`,
    };
  }
  const eventReset = findMutationSiteReset(effect, context);
  if (eventReset) {
    return {
      action: "move-to-event",
      confidence: "probable",
      derivedState: null,
      message: `Move the \`${eventReset.target.valueName}\` reset into every ${eventReset.sources.map((source) => `\`${source.valueName}\``).join(", ")} mutation—inside the same observable action if this state is migrated—then delete this effect.`,
    };
  }
  const inline: InlineEffectContext = {
    ...context,
    hasCleanup: callbackHasCleanup(callback, context.stateBySetter),
  };
  if (effect.dependencies?.elements.length === 0) {
    return emptyDependencyClassification(effect, callback, inline);
  }
  return dependencyEffectClassification(effect, callback, inline);
}

function emptyDependencyClassification(
  effect: EffectCandidate,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  inline: InlineEffectContext,
): ClassifiedEffect {
  if (isCleanupOnly(callback)) {
    return unmountEffect();
  }
  if (!inline.hasCleanup && effect.owner) {
    const mounted = mountClassification(callback, effect.owner, inline);
    if (mounted) {
      return mounted;
    }
  }
  if (!inline.hasCleanup && !callbackCallsKnownSetter(callback, inline.stateBySetter)) {
    return reviewEmptyDependencySetupEffect();
  }
  return keepPairedMountEffect();
}

function mountClassification(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
  inline: InlineEffectContext,
): ClassifiedEffect | null {
  if (
    !capturesOwnerSnapshot(callback, owner, inline) &&
    callbackIsCommittedRefIntegration(callback, owner, inline)
  ) {
    return committedRefEffect();
  }
  return isSetupOnlyMountCandidate(callback, owner, inline) ? useMountEffect() : null;
}

function dependencyEffectClassification(
  effect: EffectCandidate,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  inline: InlineEffectContext,
): ClassifiedEffect {
  if (!inline.hasCleanup && effect.owner && isCommittedRefEffect(effect, callback, inline)) {
    return committedRefEffect();
  }
  if (isObservableSourcedReaction(effect, callback, inline)) {
    return (
      persistedObservableClassification(effect, inline) ??
      (useValueDependenciesAreEffectOnly(effect, inline)
        ? observeEffect()
        : keepRenderedReactionEffect())
    );
  }
  if (inline.hasCleanup) {
    return keepLifecycleEffect();
  }
  const specificKeep = effect.owner ? dependencyEffectKeepProof(effect, callback, inline) : null;
  return specificKeep ?? stateDependencyClassification(effect, callback, inline);
}

function stateDependencyClassification(
  effect: EffectCandidate,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  inline: InlineEffectContext,
): ClassifiedEffect {
  const { body, opaque, schedule, states } = analyzeEffectStateDependencies(
    effect,
    callback,
    inline,
  );
  const stateDependencies = opaque ? [] : states;
  if (schedule) {
    return reviewStateScheduledEffect(schedule, stateDependencies);
  }
  if (body?.kind === "setter") {
    return reviewStateWritingEffect(body.state.valueName, stateDependencies);
  }
  if (body?.kind === "unresolved") {
    return reviewCausalOwnerEffect();
  }
  return body ? keepStateSnapshotEffect(body.name) : keepStateIndependentEffect();
}

function dependencyEffectKeepProof(
  effect: EffectCandidate,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  inline: InlineEffectContext,
): ClassifiedEffect | null {
  const persistence = browserStorageClassification(effect, callback, inline);
  if (persistence) {
    return persistence;
  }
  return isDependencyDrivenExternalCommandEffect(effect, inline)
    ? keepExternalIntegrationEffect()
    : null;
}

function reviewStateScheduledEffect(
  schedule: EffectStateDependency,
  stateDependencies: readonly StateCandidate[],
): ClassifiedEffect {
  if (schedule.kind === "setter") {
    return reviewStateWritingEffect(schedule.state.valueName, stateDependencies);
  }
  if (schedule.kind === "value") {
    return reviewStateReactionEffect(schedule.name, stateDependencies);
  }
  return reviewCausalOwnerEffect();
}

function isCommittedRefEffect(
  effect: EffectCandidate,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  inline: InlineEffectContext,
): boolean {
  return (
    effect.owner !== null &&
    (isExactLatestValueRefMirror(effect, inline) ||
      isExactCommittedPreviousValueGuard(effect, inline) ||
      callbackIsCommittedRefIntegration(callback, effect.owner, inline) ||
      isCommittedPropRefSnapshot(effect, inline.stateBySetter))
  );
}

function isObservableSourcedReaction(
  effect: EffectCandidate,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  inline: InlineEffectContext,
): boolean {
  const { dependencies } = effect;
  if (inline.hasCleanup || !dependencies || dependencies.elements.length === 0) {
    return false;
  }
  const dependencyNames = dependencies.elements.flatMap((element) =>
    ts.isIdentifier(element) ? [element.text] : [],
  );
  const directUseValueDependencies = dependencyNames.filter((name) =>
    inline.useValueBindings.has(name),
  );
  return (
    !callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
    !callback.asteriskToken &&
    dependencyNames.length === dependencies.elements.length &&
    dependencyNames.length > 0 &&
    directUseValueDependencies.length > 0 &&
    dependencyNames.every(
      (name) => inline.useValueBindings.has(name) || inline.useObservableBindings.has(name),
    ) &&
    directUseValueDependencies.every((name) => callbackReadsSynchronously(callback, name))
  );
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

function hasReactEffectOwnershipDirective(effect: EffectCandidate): boolean {
  const statement = findAncestorUntil(
    effect.call,
    ts.isExpressionStatement,
    effect.owner ?? effect.call.getSourceFile(),
  );
  const directive = statement && adjacentLeadingCommentText(statement);
  return directive !== null && REACT_EFFECT_DIRECTIVE_PATTERN.test(directive);
}

function adjacentLeadingCommentText(statement: ts.Statement): string | null {
  const sourceFile = statement.getSourceFile();
  const leadingComments =
    ts.getLeadingCommentRanges(sourceFile.text, statement.getFullStart()) ?? [];
  const comment = leadingComments.at(-1);
  if (!comment) {
    return null;
  }
  const gap = sourceFile.text.slice(comment.end, statement.getStart(sourceFile));
  if (/\r?\n[\t ]*\r?\n/u.test(gap)) {
    return null;
  }
  return sourceFile.text
    .slice(comment.pos, comment.end)
    .replace(/^\s*\/[/*]+\s*/u, "")
    .replace(/\*\/\s*$/u, "");
}

export function callbackHasCleanup(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
): boolean {
  if (!ts.isBlock(callback.body)) {
    if (
      ts.isCallExpression(callback.body) &&
      ts.isIdentifier(callback.body.expression) &&
      stateBySetter.has(callback.body.expression.text)
    ) {
      return false;
    }
    return (
      ts.isArrowFunction(callback.body) ||
      ts.isFunctionExpression(callback.body) ||
      ts.isIdentifier(callback.body) ||
      ts.isPropertyAccessExpression(callback.body) ||
      (ts.isCallExpression(callback.body) && isSubscriptionCall(callback.body))
    );
  }
  return callback.body.statements.some(
    (statement) => ts.isReturnStatement(statement) && statement.expression !== undefined,
  );
}

function isCleanupOnly(callback: ts.ArrowFunction | ts.FunctionExpression): boolean {
  const expression = soleReturnStatementBody(callback);
  if (!expression) {
    return false;
  }
  const cleanup = unwrapTransparentExpression(expression);
  return (
    ts.isArrowFunction(cleanup) || ts.isFunctionExpression(cleanup) || ts.isIdentifier(cleanup)
  );
}
