import {
  COMPACT_OWNER_JSX_ELEMENTS,
  EMPTY_BINDINGS,
  MAX_LEAF_SUBTREE_RATIO,
  MIN_LEAF_SUBTREE_ELEMENTS,
} from "../constants.js";
import type { StateCandidate, StateSubtree, StateUsage } from "../model.js";
import {
  boundedRenderProjectionReferences,
  oneHopRenderProjectionReferences,
} from "../../rules/state-proofs/projection-hops.js";
import {
  hasOnlyEventCommandReads,
  stateMayHoldCallable,
} from "../../rules/state-proofs/state-proofs.js";
import {
  isKeyedRepeatedProjection,
  isMaterialStateSubtree,
  isSafeEffectPresentationReference,
  isSafeMixedProjectionTransport,
  multipleOneHopRenderProjectionReferences,
  stateSubtreeResult,
} from "./materiality.js";
import {
  isSafeJsxProjectionReference,
  jsxElementCount,
  jsxElementCountIn,
  lowestCommonJsxSubtree,
} from "../../rules/state-proofs/jsx-subtrees.js";
import {
  projectionSubtreeKind,
  projectionWritesAreDeferred,
  sharesJsxChildRenderCallback,
} from "./projection-writes.js";
import type { ChildContractResolver } from "../../rules/child-contract/model.js";
import type { JsxSubtreeNode } from "../../rules/deferred-reveal/jsx-subtrees.js";
import type { MaterialityPolicy } from "../constants.js";
import { closureConfinedReferences } from "./closure-confinement.js";
import { commonRenderGateSubtree } from "../../rules/deferred-reveal/render-gates.js";
import { effectSplitProjectionSubtree } from "./effect-split.js";
import { hasAncestorInSet } from "../ast-helpers.js";
import { isUniquelySelectedRepeatedProjection } from "../../rules/state-proofs/unique-repeated-selection.js";
import { nearestNestedFunction } from "../../core/ast.js";
import { ownerDeclaresBinding } from "../owner-scan.js";
import type ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

interface StateSubtreeOptions {
  readonly childContracts: ChildContractResolver | null;
  readonly directEffectCalls: ReadonlySet<ts.CallExpression>;
  readonly effectOwnedMemoizedCommand: boolean;
  readonly materiality: MaterialityPolicy;
  readonly projectionAllowed: boolean;
  readonly pureProjectionImports: ReadonlySet<string>;
}

function isEffectWrittenPresentation(
  usage: StateUsage,
  directEffectCalls: ReadonlySet<ts.CallExpression>,
): boolean {
  return (
    usage.effectWrites > 0 &&
    usage.effectWrites === usage.setterCalls &&
    usage.setterReferences === usage.setterCalls &&
    usage.setterCallNodes.every((call) => hasAncestorInSet(call, directEffectCalls)) &&
    usage.deferredReads === 0 &&
    !usage.setterUsesPreviousValue
  );
}

interface SubtreeEligibility {
  readonly effectWrittenPresentation: boolean;
  readonly ownerJsx: number;
  readonly splitEffectProjection: StateSubtree | null;
}

function stateRendersFromBoundedSubtree(
  state: StateCandidate,
  usage: StateUsage,
  { effectWrittenPresentation, ownerJsx, splitEffectProjection }: SubtreeEligibility,
): boolean {
  return (
    (ownerJsx >= COMPACT_OWNER_JSX_ELEMENTS || effectWrittenPresentation) &&
    !stateMayHoldCallable(state) &&
    usage.directRenderNodes.length > 0 &&
    usage.localRenderReads === usage.directRenderNodes.length &&
    usage.setterCallNodes.length > 0 &&
    usage.setterReferences === usage.setterCalls &&
    usage.effectReads === 0 &&
    (usage.effectWrites === 0 || effectWrittenPresentation) &&
    (usage.deferredReads === 0 || hasOnlyEventCommandReads(state)) &&
    !usage.shadowed &&
    (!usage.escaped || splitEffectProjection !== null)
  );
}

function renderProjectionNodes(
  state: StateCandidate,
  usage: StateUsage,
  effectWrittenPresentation: boolean,
): readonly ts.Node[] {
  if (effectWrittenPresentation) {
    return (
      multipleOneHopRenderProjectionReferences(state.owner, usage.directRenderNodes) ??
      usage.directRenderNodes
    );
  }
  return (
    boundedRenderProjectionReferences(state.owner, usage.directRenderNodes) ??
    oneHopRenderProjectionReferences(state.owner, usage.directRenderNodes) ??
    usage.directRenderNodes
  );
}

export function analyzeStateSubtree(
  state: StateCandidate,
  usage: StateUsage,
  options: StateSubtreeOptions,
): StateSubtree | null {
  const { directEffectCalls, materiality, pureProjectionImports } = options;
  const ownerJsx = jsxElementCount(state.owner);
  const effectWrittenPresentation = isEffectWrittenPresentation(usage, directEffectCalls);
  const splitEffectProjection = effectWrittenPresentation
    ? effectSplitProjectionSubtree(state, usage, { materiality, ownerJsx, pureProjectionImports })
    : null;
  if (
    !stateRendersFromBoundedSubtree(state, usage, {
      effectWrittenPresentation,
      ownerJsx,
      splitEffectProjection,
    })
  ) {
    return closureConfinedSubtree(state, usage, options);
  }
  return (
    splitEffectProjection ??
    renderSubtreeFor(state, usage, { ...options, effectWrittenPresentation, ownerJsx }) ??
    closureConfinedSubtree(state, usage, options)
  );
}

interface RenderSubtreeScope extends StateSubtreeOptions {
  readonly effectWrittenPresentation: boolean;
  readonly ownerJsx: number;
}

function renderSubtreeFor(
  state: StateCandidate,
  usage: StateUsage,
  scope: RenderSubtreeScope,
): StateSubtree | null {
  const { effectWrittenPresentation, projectionAllowed } = scope;
  const projectionNodes = renderProjectionNodes(state, usage, effectWrittenPresentation);
  const renderReadsInNestedCallbacks = projectionNodes.some(
    (node) => nearestNestedFunction(node, state.owner) !== null,
  );
  const allowsDirectSubtree =
    !effectWrittenPresentation &&
    usage.transportedOccurrences === 0 &&
    projectionAllowed &&
    !renderReadsInNestedCallbacks;
  return (
    (allowsDirectSubtree ? directRenderSubtree(state, usage, scope) : null) ??
    projectionSubtreeFor(state, usage, {
      ...scope,
      allowedProjectionCalls: projectionCallAllowlist(state, scope, effectWrittenPresentation),
      projectionNodes,
      renderReadsInNestedCallbacks,
      uniqueRepeatedProjection: isUniquelySelectedRepeatedProjection(projectionNodes, state.owner),
    })
  );
}

function projectionCallAllowlist(
  state: StateCandidate,
  { pureProjectionImports }: StateSubtreeOptions,
  effectWrittenPresentation: boolean,
): ReadonlySet<string> {
  if (!effectWrittenPresentation) {
    return EMPTY_BINDINGS;
  }
  return new Set(
    [...pureProjectionImports].filter((name) => !ownerDeclaresBinding(state.owner, name)),
  );
}

function directRenderSubtree(
  state: StateCandidate,
  usage: StateUsage,
  { materiality, ownerJsx }: RenderSubtreeScope,
): StateSubtree | null {
  return boundedDirectSubtree(state, [...usage.directRenderNodes, ...usage.setterCallNodes], {
    materiality,
    movedDeclarations: [],
    ownerJsx,
  });
}

/**
 * A state whose render proof fails only because its reads and writes sit inside owner-level
 * handlers or derived constants still moves down when every such declaration is used only inside
 * one bounded subtree: the declarations move with the state, so the owner never renders for it.
 */
function closureConfinedSubtree(
  state: StateCandidate,
  usage: StateUsage,
  { materiality, projectionAllowed }: StateSubtreeOptions,
): StateSubtree | null {
  if (
    !projectionAllowed ||
    stateMayHoldCallable(state) ||
    usage.effectReads > 0 ||
    usage.effectWrites > 0 ||
    usage.setterReferences === 0 ||
    usage.setterUsesPreviousValue
  ) {
    return null;
  }
  const confined = closureConfinedReferences(state);
  if (!confined || confined.movedDeclarations.length === 0) {
    return null;
  }
  const subtree = boundedDirectSubtree(state, confined.nodes, {
    materiality,
    movedDeclarations: confined.movedDeclarations,
    ownerJsx: jsxElementCount(state.owner),
  });
  return subtree && !subtree.repeated && !subtreeIsReturnRoot(subtree, confined.returned)
    ? subtree
    : null;
}

/** Extracting the whole returned tree leaves nothing above the cut, so it proves no render saving. */
function subtreeIsReturnRoot(subtree: StateSubtree, returned: ts.Expression): boolean {
  return unwrapTransparentExpression(returned) === subtree.node;
}

interface DirectSubtreeScope {
  readonly materiality: MaterialityPolicy;
  readonly movedDeclarations: readonly string[];
  readonly ownerJsx: number;
}

function boundedDirectSubtree(
  state: StateCandidate,
  nodes: readonly ts.Node[],
  { materiality, movedDeclarations, ownerJsx }: DirectSubtreeScope,
): StateSubtree | null {
  const direct = lowestCommonJsxSubtree(nodes, state.owner);
  if (!direct) {
    return null;
  }
  const subtreeJsx = jsxElementCountIn(direct);
  if (
    ownerJsx < materiality.broadOwnerJsx ||
    subtreeJsx < MIN_LEAF_SUBTREE_ELEMENTS ||
    subtreeJsx / ownerJsx > MAX_LEAF_SUBTREE_RATIO
  ) {
    return null;
  }
  return stateSubtreeResult("direct", direct, { movedDeclarations, renderNodes: nodes, state });
}

interface ProjectionSubtreeScope extends StateSubtreeOptions {
  readonly allowedProjectionCalls: ReadonlySet<string>;
  readonly effectWrittenPresentation: boolean;
  readonly ownerJsx: number;
  readonly projectionNodes: readonly ts.Node[];
  readonly renderReadsInNestedCallbacks: boolean;
  readonly uniqueRepeatedProjection: boolean;
}

function isSafeJsxChildProjection(
  state: StateCandidate,
  usage: StateUsage,
  { childContracts, directEffectCalls, projectionNodes }: ProjectionSubtreeScope,
): boolean {
  return (
    sharesJsxChildRenderCallback(projectionNodes, state.owner) &&
    projectionWritesAreDeferred(usage, state.owner, { childContracts, directEffectCalls })
  );
}

function projectionSubtreeFor(
  state: StateCandidate,
  usage: StateUsage,
  scope: ProjectionSubtreeScope,
): StateSubtree | null {
  const {
    effectOwnedMemoizedCommand,
    effectWrittenPresentation,
    ownerJsx,
    projectionAllowed,
    projectionNodes,
    renderReadsInNestedCallbacks,
    uniqueRepeatedProjection,
  } = scope;
  const gateProjection = renderReadsInNestedCallbacks
    ? null
    : commonRenderGateSubtree(projectionNodes, state.owner);
  if (!projectionAllowed || !projectionAcceptsNodes(state, usage, { ...scope, gateProjection })) {
    return null;
  }
  const projection = gateProjection ?? lowestCommonJsxSubtree(projectionNodes, state.owner);
  if (
    !projection ||
    !isMaterialStateSubtree(projection, ownerJsx, {
      effectWrittenPresentation,
      materiality: scope.materiality,
      uniqueRepeatedProjection,
    }) ||
    (usage.transportedOccurrences > 0 &&
      !isSafeMixedProjectionTransport(state, usage, {
        allowNestedSite: effectWrittenPresentation,
        common: projection,
      }))
  ) {
    return null;
  }
  return stateSubtreeResult(
    projectionSubtreeKind(
      effectOwnedMemoizedCommand,
      effectWrittenPresentation,
      Boolean(gateProjection),
    ),
    projection,
    { renderNodes: projectionNodes, state, uniqueRepeatedBranch: uniqueRepeatedProjection },
  );
}

function projectionAcceptsNodes(
  state: StateCandidate,
  usage: StateUsage,
  scope: ProjectionSubtreeScope & { readonly gateProjection: JsxSubtreeNode | null },
): boolean {
  const { gateProjection } = scope;
  const {
    allowedProjectionCalls,
    effectWrittenPresentation,
    projectionNodes,
    renderReadsInNestedCallbacks,
    uniqueRepeatedProjection,
  } = scope;
  const safeProjectionReferences = projectionNodes.every(
    (node) =>
      isSafeJsxProjectionReference(node, state.owner, allowedProjectionCalls) ||
      (effectWrittenPresentation && isSafeEffectPresentationReference(node, state.owner)),
  );
  if (!safeProjectionReferences && !gateProjection) {
    return false;
  }
  return (
    !renderReadsInNestedCallbacks ||
    isKeyedRepeatedProjection(projectionNodes, state.owner) ||
    uniqueRepeatedProjection ||
    isSafeJsxChildProjection(state, usage, scope)
  );
}
