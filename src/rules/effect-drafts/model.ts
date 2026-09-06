import type { EffectCandidate, StateCandidate, StateUsage } from "../../analysis/model.js";
import type { RenderCutWitnessQuery } from "../state-proofs/render-cut-witness.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type ts from "typescript";

export interface EffectDraftScope {
  bySetter: ReadonlyMap<string, StateCandidate>;
}

export interface EffectDraftCluster {
  action: "use-observable";
  id: string;
  members: readonly StateCandidate[];
  message: string;
  primary: StateCandidate;
}

export interface EffectDraftAnalysis {
  clusters: ReadonlyMap<StateCandidate, EffectDraftCluster>;
  effects: ReadonlySet<EffectCandidate>;
  singletons: ReadonlySet<StateCandidate>;
}

export type JsxSubtreeNode = ts.JsxElement | ts.JsxFragment | ts.JsxSelfClosingElement;

export interface DirectReturnCallSite {
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement;
  returned: ts.Expression;
}

/**
 * Shared structural proofs owned by the analyzer rather than this rule family.
 * Keeping them explicit prevents effect-draft logic from depending on application
 * names or path-specific exceptions while avoiding duplicate AST algorithms.
 */
export interface EffectDraftProofs {
  directUniqueReturnCallSite: (
    usage: StateUsage,
    owner: RuntimeFunctionLike,
  ) => DirectReturnCallSite | null;
  hasIndependentRenderCutWitness: (query: RenderCutWitnessQuery) => boolean;
  isCustomHookOwner: (owner: RuntimeFunctionLike) => boolean;
  nearestMutationFunction: (node: ts.Node, owner: RuntimeFunctionLike) => RuntimeFunctionLike;
  setterMutationsCanCooccur: (
    left: ts.CallExpression,
    right: ts.CallExpression,
    region: RuntimeFunctionLike,
  ) => boolean;
  uniqueReturnedExpression: (owner: RuntimeFunctionLike) => ts.Expression | null;
}

/** Inputs shared by every effect the draft search visits. */
export interface DraftContext {
  effects: readonly EffectCandidate[];
  localComponents: ReadonlySet<string>;
  proofs: EffectDraftProofs;
  siblingRenderCuts: ReadonlyMap<StateCandidate, unknown>;
  sourceComponents: ReadonlySet<string>;
  states: readonly StateCandidate[];
  usageByState: ReadonlyMap<StateCandidate, StateUsage>;
}

export interface DraftEffect {
  callback: ts.ArrowFunction | ts.FunctionExpression;
  context: DraftContext;
  effect: EffectCandidate;
  owner: RuntimeFunctionLike;
}

export interface DraftMatch {
  draft: DraftEffect;
  members: readonly StateCandidate[];
}

export interface DraftSynchronization {
  clusters: Map<StateCandidate, EffectDraftCluster>;
  effects: Set<EffectCandidate>;
  singletons: Set<StateCandidate>;
}

export interface SetterMutation {
  call: ts.CallExpression;
  region: RuntimeFunctionLike;
  state: StateCandidate;
}
