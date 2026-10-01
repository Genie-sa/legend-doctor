import type { AbstentionReason, EffectAction, StateAction } from "../core/types.js";
import type { JsxSubtreeNode } from "../rules/deferred-reveal/jsx-subtrees.js";
import type { RuntimeFunctionLike } from "../core/ast.js";
import type { StateFlowIndex } from "../project/state-flow/state-flow.js";
import type ts from "typescript";

export interface StateCandidate {
  call: ts.CallExpression;
  owner: RuntimeFunctionLike;
  setterName: string | null;
  valueName: string;
}

export interface EffectCandidate {
  call: ts.CallExpression;
  callback: ts.ArrowFunction | ts.FunctionExpression | null;
  dependencies: ts.ArrayLiteralExpression | null;
  owner: RuntimeFunctionLike | null;
}

export interface StateUsage {
  directRenderNodes: ts.Node[];
  deferredReads: number;
  /** Value reads inside timers, promises, subscriptions, and event callbacks. */
  deferredReadNodes: ts.Node[];
  effectReads: number;
  effectReadNodes: ts.Node[];
  effectWrites: number;
  effectWriteNodes: ts.Node[];
  escaped: boolean;
  /** References handed to code the analysis cannot follow. */
  escapeNodes: ts.Node[];
  eventReads: number;
  jsxTargets: Set<string>;
  localRenderReads: number;
  legendReactionWrites: number;
  /** Reads inside proven browser-storage persistence effects, which Legend persistence replaces. */
  persistenceReads: number;
  repeatedTransport: boolean;
  repeatedValueTransport: boolean;
  setterTargets: Set<string>;
  setterCalls: number;
  setterCallNodes: ts.CallExpression[];
  setterReferences: number;
  setterTransportSites: Set<number>;
  setterUsesPreviousValue: boolean;
  shadowed: boolean;
  transportedOccurrences: number;
  /** JSX attributes that carry the value or setter to each transport target. */
  transportNodes: Map<string, ts.Node[]>;
  unstableTransport: boolean;
  valueTransportSites: Set<number>;
  valueTargets: Set<string>;
  valueProps: Map<string, Set<string>>;
}

interface Classification {
  confidence: "certain" | "probable";
  message: string;
}

export type ClassifiedState =
  | (Classification & {
      abstentionReason: AbstentionReason;
      action: "review-state";
    })
  | (Classification & {
      abstentionReason?: never;
      action: Exclude<StateAction, "review-state">;
    });

export interface ControlledFilterLeafCut {
  line: number;
  producer: string;
  target: string;
}

/** A browser-storage persistence effect whose Legend replacement waits on the verdicts of the states it writes. */
export interface BrowserStoragePersistence {
  /** Persist plugin class names matching the storages the effect writes. */
  readonly plugins: readonly string[];
  readonly states: readonly StateCandidate[];
}

interface EffectClassification extends Classification {
  derivedState: StateCandidate | null;
  persistence?: BrowserStoragePersistence;
}

export type ClassifiedEffect =
  | (EffectClassification & {
      abstentionReason: AbstentionReason;
      action: "review-effect";
      stateDependencies?: readonly StateCandidate[];
    })
  | (EffectClassification & {
      abstentionReason?: never;
      action: Exclude<EffectAction, "review-effect">;
    });

export interface EffectStateScope {
  bySetter: Map<string, StateCandidate>;
  byValue: Map<string, StateCandidate>;
  usageBySetter: Map<string, StateUsage>;
}

export interface StateCluster {
  action: Exclude<StateAction, "review-state">;
  id: string;
  memberMessages?: ReadonlyMap<StateCandidate, string>;
  members: readonly StateCandidate[];
  message: string;
  primary: StateCandidate;
}

export interface SiblingRenderCut {
  consumerLabel: string;
  consumerLine: number;
}

export interface ControlledProjectionCut {
  consumerLabel: string;
  consumerLine: number;
}

export interface DialogPayloadCut {
  conditional: boolean;
  consumerLabel: string;
  consumerLine: number;
}

export interface BranchUnmountMove {
  target: string;
}

export interface SetterMutation {
  call: ts.CallExpression;
  region: RuntimeFunctionLike;
  state: StateCandidate;
}

export interface CoexecutionScope {
  readonly region: RuntimeFunctionLike;
  readonly stateFlow: StateFlowIndex;
}

export interface ComponentScope {
  readonly localComponents: ReadonlySet<string>;
  readonly sourceComponents: ReadonlySet<string>;
}

export interface DirectReturnCallSite {
  readonly opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement;
  readonly returned: ts.Expression;
}

export interface StateSubtree {
  kind:
    | "direct"
    | "effect-command-projection"
    | "effect-projection"
    | "effect-split-projection"
    | "gate"
    | "projection";
  leafCount?: number;
  label: string;
  line: number;
  movedDeclarations: readonly string[];
  node: JsxSubtreeNode;
  repeated: boolean;
  uniqueRepeatedBranch: boolean;
  unstable: boolean;
}
