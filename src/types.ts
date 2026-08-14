export type Confidence = "certain" | "probable";

export type StateAction =
  | "keep-state"
  | "delete-unused-state"
  | "move-state-down"
  | "use-observable"
  | "use-value"
  | "delete-derived-state"
  | "use-ref"
  | "review-state";

export type EffectAction =
  | "delete-effect"
  | "move-to-event"
  | "use-mount"
  | "use-unmount"
  | "use-observe-effect"
  | "keep-effect"
  | "review-effect";

export type HookAction = StateAction | EffectAction;

export type LegendPracticeAction =
  | "assign-observable-fields"
  | "batch-observable-writes"
  | "narrow-use-value-subscription"
  | "pass-observable-to-use-value";

export interface SourceLocation {
  column: number;
  file: string;
  line: number;
}

export interface HookFinding {
  action: HookAction;
  confidence: Confidence;
  disposition: "candidate" | "change" | "keep";
  evidence: readonly string[];
  hook: "useEffect" | "useState";
  group?: {
    id: string;
    kind: "state-cluster";
    members: readonly string[];
    primary: boolean;
  };
  location: SourceLocation;
  message: string;
  name: string | null;
  stateModel?: {
    ownership: "delete" | "existing-observable" | "local-observable" | "react" | "ref" | "review";
    subscription: "leaf-react" | "leaf-use-value" | "none" | "owner-react" | "owner-use-value" | "review";
  };
}

export interface LegendPracticeFinding {
  action: LegendPracticeAction;
  confidence: Confidence;
  disposition: "change";
  evidence: readonly string[];
  location: SourceLocation;
  message: string;
  practice: "assign" | "batch" | "reactivity";
}

export interface AnalysisReport {
  files: number;
  findings: HookFinding[];
  hooks: {
    effects: number;
    states: number;
    total: number;
  };
  practices: LegendPracticeFinding[];
}
