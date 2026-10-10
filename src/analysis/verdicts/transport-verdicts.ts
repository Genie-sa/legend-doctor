import type { ClassifiedState, ComponentScope, StateUsage } from "../model.js";
import {
  expressionMayBeCallable,
  hasDirectPrimitiveInitializer,
  stateMayHoldCallable,
  stateTypeIsPrimitive,
} from "../../rules/state-proofs/state-proofs.js";
import { isCustomHookOwner, renderCutSuffix } from "../ast-helpers.js";
import {
  jsxElementCount,
  nearestRepeatedRenderCall,
} from "../../rules/state-proofs/jsx-subtrees.js";
import { passThroughScope, valueCallSitesPassThrough } from "./pass-through-leaf.js";
import {
  setterOwnedByValueCallSite,
  setterOwnedByValueTransitionCallSite,
} from "../controlled-leaf-cuts.js";
import { BROAD_OWNER_JSX_ELEMENTS } from "../constants.js";
import type { LeafRenderValues } from "../../rules/child-contract/model.js";
import type { StateClassificationContext } from "./classification-context.js";
import { isLiteralBooleanLeafState } from "../../rules/literal-boolean-leaf/literal-boolean-leaf.js";
import { isLiteralBooleanSetter } from "../../rules/literal-boolean-leaf/boolean-setters.js";
import { nearestNestedFunction } from "../../core/ast.js";
import ts from "typescript";
import { wrappedElementIsPassedThrough } from "../../rules/child-contract/element-identity.js";

function stateIsTransportOnly(usage: StateUsage): boolean {
  return (
    usage.localRenderReads === 0 &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.deferredReads === 0 &&
    usage.transportedOccurrences > 0
  );
}

function stateHasSingleTransportTarget(usage: StateUsage): boolean {
  return (
    usage.valueTransportSites.size === 1 &&
    usage.valueTargets.size === 1 &&
    !usage.repeatedValueTransport
  );
}

export function stateWritesAreUntracked(usage: StateUsage): boolean {
  return !usage.setterUsesPreviousValue && !usage.shadowed && !usage.escaped;
}

export function stateHasNoEffectOrDeferredUse(
  usage: StateUsage,
  allowDetachedEffectWrites = false,
): boolean {
  return (
    usage.effectReads === 0 &&
    (usage.effectWrites === 0 || allowDetachedEffectWrites) &&
    usage.deferredReads === 0
  );
}

function transportTargetIsKnownComponent(
  usage: StateUsage,
  { localComponents, sourceComponents }: ComponentScope,
): boolean {
  const [target] = [...usage.valueTargets];
  return target !== undefined && (localComponents.has(target) || sourceComponents.has(target));
}

export function controlledStateReadsAreEventOnly(usage: StateUsage): boolean {
  return (
    usage.localRenderReads === 0 &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.deferredReads > 0 &&
    usage.transportedOccurrences > 0 &&
    !usage.repeatedTransport
  );
}

export function setterCallsAssignBooleanLiterals(usage: StateUsage): boolean {
  return usage.setterCallNodes.every((call) => isLiteralBooleanSetter(call));
}

/**
 * A boolean literal write needs no further proof. A value write needs a state type that admits no
 * object or function, plus the owner-side gates of `passThroughLeaf`: a material owner and no
 * companion writes. An effect may write it only from a nested callback, such as a listener it
 * registers; a write in the effect body can mirror a reactive input that should be derived instead.
 */
export function setterWritesFitLeafTransport(context: StateClassificationContext): boolean {
  const { hasCompanionWrites, materiality, state, usage } = context;
  return (
    setterCallsAssignBooleanLiterals(usage) ||
    (!hasCompanionWrites &&
      !isCustomHookOwner(state.owner) &&
      jsxElementCount(state.owner) >= materiality.broadOwnerJsx &&
      stateTypeIsPrimitive(state) &&
      usage.setterCallNodes.every(setterCallAssignsOneValue) &&
      effectWritesRunInNestedCallbacks(context))
  );
}

function effectWritesRunInNestedCallbacks({
  effectRegions,
  state,
  usage,
}: StateClassificationContext): boolean {
  return usage.effectWriteNodes.every((write) => {
    const callback = nearestNestedFunction(write, state.owner);
    return callback !== null && !effectRegions.has(callback);
  });
}

function setterCallAssignsOneValue(call: ts.CallExpression): boolean {
  const [value] = call.arguments;
  return (
    call.arguments.length === 1 &&
    value !== undefined &&
    !ts.isSpreadElement(value) &&
    !expressionMayBeCallable(value)
  );
}

/**
 * Legend diffs an object or array write structurally and skips notifying for an equal replacement,
 * so a leaf would keep passing the previous reference where React passed the new one. The prop
 * snapshot stays identical only when the state type admits no object, or when every write is a
 * direct boolean literal call.
 */
export function stateValuesStayPrimitive(context: StateClassificationContext): boolean {
  return hasDirectPrimitiveInitializer(context.state) && stateWritesStayPrimitive(context);
}

/** No write can store an object or array, so Legend never skips one as structurally equal. */
function stateWritesStayPrimitive({ state, usage }: StateClassificationContext): boolean {
  return (
    stateTypeIsPrimitive(state) ||
    (usage.setterReferences === usage.setterCalls && setterCallsAssignBooleanLiterals(usage))
  );
}

/** A leaf receives the mount value either way, so only what later writes store decides identity. */
export function leafRenderValues(context: StateClassificationContext): LeafRenderValues {
  return stateWritesStayPrimitive(context) ? "primitive" : "structural";
}

function ownerRenderCutIsMaterial(context: StateClassificationContext): boolean {
  const { materiality, state, usage } = context;
  const { hasCompactBooleanTransportCut, hasRepeatedOwnerRenderCut } = context.renderCut;
  return (
    jsxElementCount(state.owner) >= materiality.broadOwnerJsx ||
    hasCompactBooleanTransportCut ||
    (hasRepeatedOwnerRenderCut &&
      !usage.repeatedTransport &&
      usage.setterCallNodes.every((call) => nearestRepeatedRenderCall(call, state.owner) === null))
  );
}

function companionWritesAllowTransportCut(context: StateClassificationContext): boolean {
  const {
    hasCompanionWrites,
    hasIndependentDirectEventWrite,
    hasIndependentVisibilitySetterTransport,
    hasNonClosingCompanionWrites,
    hasReactiveMutationPath,
  } = context;
  const { hasVisibilityValueTransport } = context.renderCut;
  const independentWrite =
    hasIndependentDirectEventWrite || hasIndependentVisibilitySetterTransport;
  return (
    (!hasCompanionWrites ||
      (hasVisibilityValueTransport && !hasNonClosingCompanionWrites && independentWrite)) &&
    (!hasReactiveMutationPath || independentWrite)
  );
}

export function compactTransportCutVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const { hasSafeCommands, state, usage } = context;
  const { branchCallSite, hasCompactBooleanTransportCut, hasRepeatedOwnerRenderCut } =
    context.renderCut;
  if (
    !isCustomHookOwner(state.owner) &&
    ownerRenderCutIsMaterial(context) &&
    stateIsTransportOnly(usage) &&
    stateHasSingleTransportTarget(usage) &&
    branchCallSite !== null &&
    wrappedElementIsPassedThrough(branchCallSite.opening, passThroughScope(context)) &&
    companionWritesAllowTransportCut(context) &&
    hasSafeCommands &&
    stateValuesStayPrimitive(context) &&
    !stateMayHoldCallable(state) &&
    !setterOwnedByValueCallSite(usage, state.owner) &&
    usage.setterReferences > 0 &&
    stateWritesAreUntracked(usage)
  ) {
    const target = [...usage.valueTargets][0] ?? "the receiving child";
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace \`${state.valueName}\` with a component-lifetime observable and extract one stable call-site leaf wrapper around \`${target}\` (never define it inline); subscribe there, pass the same prop snapshot, and adapt every command-only setter call or prop to mutate without subscribing.${renderCutSuffix(
        jsxElementCount(state.owner) < BROAD_OWNER_JSX_ELEMENTS && hasCompactBooleanTransportCut,
        jsxElementCount(state.owner) < BROAD_OWNER_JSX_ELEMENTS && hasRepeatedOwnerRenderCut,
      )}`,
    };
  }
  return null;
}

export function descendantControlledCutVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const {
    hasCompanionWrites,
    hasSafeCommands,
    localComponents,
    materiality,
    sourceComponents,
    state,
    usage,
  } = context;
  const { branchCallSite, descendantControlledCut, directCallSite } = context.renderCut;
  if (
    !isCustomHookOwner(state.owner) &&
    jsxElementCount(state.owner) >= materiality.broadOwnerJsx &&
    stateIsTransportOnly(usage) &&
    stateHasSingleTransportTarget(usage) &&
    (descendantControlledCut ||
      transportTargetIsKnownComponent(usage, { localComponents, sourceComponents })) &&
    branchCallSite !== null &&
    (directCallSite === null || usage.unstableTransport) &&
    !hasCompanionWrites &&
    hasSafeCommands &&
    stateValuesStayPrimitive(context) &&
    !stateMayHoldCallable(state) &&
    (descendantControlledCut || setterOwnedByValueTransitionCallSite(state, usage)) &&
    stateWritesAreUntracked(usage)
  ) {
    const target = [...usage.valueTargets][0] ?? "the receiving child";
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace call-site-owned state \`${state.valueName}\` with a component-lifetime observable and wrap the branch-local \`${target}\` call site in a leaf subscriber; keep ownership at this owner so alternate returns and conditional mounts preserve the existing state lifetime.`,
    };
  }
  return null;
}

export function visibilityTransportVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const {
    hasCompanionWrites,
    hasMemoizedOptionCommand,
    hasReactiveMutationPath,
    localComponents,
    materiality,
    sourceComponents,
    state,
    usage,
  } = context;
  const { branchCallSite } = context.renderCut;
  if (
    isLiteralBooleanLeafState(state, usage, {
      branchCallSiteExists: branchCallSite !== null,
      hasCompanionWrites,
      hasMemoizedOptionCommand,
      hasReactiveMutationPath,
      isCustomHookOwner: isCustomHookOwner(state.owner),
      localComponents,
      materiality,
      sourceComponents,
    }) &&
    valueCallSitesPassThrough(context, { editableChildren: false })
  ) {
    const target = [...usage.valueTargets][0] ?? "the receiving child";
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace boolean leaf state \`${state.valueName}\` with a component-lifetime observable and wrap the stable \`${target}\` call site in a leaf subscriber; preserve owner lifetime and change only the literal setter commands so external callbacks no longer invalidate the broad owner.`,
    };
  }
  return null;
}
