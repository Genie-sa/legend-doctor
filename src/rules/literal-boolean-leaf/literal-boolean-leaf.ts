import {
  MAX_CONDITIONAL_SURFACES,
  MAX_SURFACE_ELEMENT_SHARE,
  MIN_CONDITIONAL_SURFACES,
  conditionalPresentationSurfaces,
  isProportionateSurfaceSet,
  multiSurfaceTally,
  surfacesAreAdjacentSiblings,
} from "./presentation-surfaces.js";
import type { StateCandidate, StateUsage } from "../../analysis/model.js";
import {
  isEventBooleanSetter,
  isLiteralBooleanSetter,
  isPureBooleanSetter,
} from "./boolean-setters.js";
import type { MaterialityPolicy } from "../../analysis/constants.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { hasStateInitializer } from "../deferred-reveal/deferred-reveal.js";
import { isInsideJsxEventCallback } from "../state-proofs/event-roots.js";
import { jsxElementCount } from "../state-proofs/jsx-subtrees.js";
import ts from "typescript";
import { visitSkippingNestedRuntimeFunctions } from "../../core/ast.js";

const MIN_MULTI_SURFACE_RENDER_READS = 2;

interface LiteralBooleanLeafOptions {
  branchCallSiteExists: boolean;
  materiality: MaterialityPolicy;
  hasCompanionWrites: boolean;
  hasMemoizedOptionCommand: boolean;
  hasReactiveMutationPath: boolean;
  isCustomHookOwner: boolean;
  localComponents: ReadonlySet<string>;
  sourceComponents: ReadonlySet<string>;
}

export interface MultiSurfaceBooleanOptions {
  hasCompanionWrites: boolean;
  materiality: MaterialityPolicy;
  hasReactiveMutationPath: boolean;
  hasSafeCommands: boolean;
  isCustomHookOwner: boolean;
  pureProjectionImports: ReadonlySet<string>;
}

interface AdjacentEffectBooleanOptions extends MultiSurfaceBooleanOptions {
  effectWritesAreDirect: boolean;
}

export function isLiteralBooleanLeafState(
  state: StateCandidate,
  usage: StateUsage,
  options: LiteralBooleanLeafOptions,
): boolean {
  const target = [...usage.valueTargets][0] ?? "";
  return (
    !options.isCustomHookOwner &&
    hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) &&
    jsxElementCount(state.owner) >= options.materiality.broadOwnerJsx &&
    isSingleTargetTransportUsage(usage) &&
    (options.localComponents.has(target) || options.sourceComponents.has(target)) &&
    options.branchCallSiteExists &&
    !options.hasCompanionWrites &&
    !options.hasReactiveMutationPath &&
    usage.setterCallNodes.every(
      (call) =>
        isLiteralBooleanSetter(call) &&
        (isInsideJsxEventCallback(call, state.owner) || options.hasMemoizedOptionCommand),
    )
  );
}

export function isAdjacentEventBooleanLeafState(
  state: StateCandidate,
  usage: StateUsage,
  options: MultiSurfaceBooleanOptions,
): boolean {
  return (
    usage.effectWrites === 0 &&
    usage.setterCallNodes.every((call) => isEventBooleanSetter(call, state)) &&
    isAdjacentBooleanLeafState(state, usage, options)
  );
}

export function isAdjacentEffectBooleanLeafState(
  state: StateCandidate,
  usage: StateUsage,
  options: AdjacentEffectBooleanOptions,
): boolean {
  return (
    options.effectWritesAreDirect &&
    usage.effectWrites > 0 &&
    usage.effectWrites === usage.setterCalls &&
    usage.setterCallNodes.every(isPureBooleanSetter) &&
    isAdjacentBooleanLeafState(state, usage, options)
  );
}

export function isMultiSurfaceLiteralBooleanState(
  state: StateCandidate,
  usage: StateUsage,
  options: MultiSurfaceBooleanOptions,
): boolean {
  const ownerElements = jsxElementCount(state.owner);
  if (
    options.isCustomHookOwner ||
    !hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) ||
    ownerElements < options.materiality.broadOwnerJsx ||
    directOwnerReturnCount(state.owner) !== 1 ||
    usage.localRenderReads < MIN_MULTI_SURFACE_RENDER_READS ||
    usage.effectWrites !== 0 ||
    !isLocalRenderOnlyBooleanUsage(usage, options) ||
    !usage.setterCallNodes.every(isLiteralBooleanSetter)
  ) {
    return false;
  }
  const tally = multiSurfaceTally(state, usage, options);
  return (
    tally !== null &&
    tally.surfaces >= MIN_CONDITIONAL_SURFACES &&
    tally.surfaces <= MAX_CONDITIONAL_SURFACES &&
    tally.conditionalSurfaces > 0 &&
    tally.surfaceElements / ownerElements <= MAX_SURFACE_ELEMENT_SHARE
  );
}

function isAdjacentBooleanLeafState(
  state: StateCandidate,
  usage: StateUsage,
  options: MultiSurfaceBooleanOptions,
): boolean {
  const ownerElements = jsxElementCount(state.owner);
  if (
    options.isCustomHookOwner ||
    !state.setterName ||
    !hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) ||
    ownerElements < options.materiality.broadOwnerJsx ||
    directOwnerReturnCount(state.owner) !== 1 ||
    usage.localRenderReads === 0 ||
    !isLocalRenderOnlyBooleanUsage(usage, options)
  ) {
    return false;
  }
  const surfaces = conditionalPresentationSurfaces(state, usage, options.pureProjectionImports);
  if (!isProportionateSurfaceSet(surfaces, ownerElements)) {
    return false;
  }
  return surfacesAreAdjacentSiblings([...surfaces.values()].map((surface) => surface.expression));
}

function isSingleTargetTransportUsage(usage: StateUsage): boolean {
  return (
    usage.localRenderReads === 0 &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.deferredReads === 0 &&
    usage.transportedOccurrences > 0 &&
    usage.valueTransportSites.size === 1 &&
    usage.valueTargets.size === 1 &&
    !usage.repeatedValueTransport &&
    usage.setterCallNodes.length > 0 &&
    usage.setterReferences === usage.setterCalls &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped
  );
}

function isLocalRenderOnlyBooleanUsage(
  usage: StateUsage,
  options: MultiSurfaceBooleanOptions,
): boolean {
  return (
    usage.localRenderReads === usage.directRenderNodes.length &&
    usage.effectReads === 0 &&
    usage.deferredReads === 0 &&
    usage.transportedOccurrences === 0 &&
    !options.hasCompanionWrites &&
    !options.hasReactiveMutationPath &&
    options.hasSafeCommands &&
    usage.setterCallNodes.length > 0 &&
    usage.setterReferences === usage.setterCalls &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped
  );
}

function directOwnerReturnCount(owner: RuntimeFunctionLike): number {
  if (!owner.body) {
    return 0;
  }
  let returns = 0;
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (ts.isReturnStatement(node) && node.expression) {
      returns += 1;
    }
  });
  return returns;
}
