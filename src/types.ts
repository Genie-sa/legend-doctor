type Confidence = "certain" | "probable";

type StateAction =
  | "keep-state"
  | "delete-unused-state"
  | "move-state-down"
  | "use-observable"
  | "use-value"
  | "delete-derived-state"
  | "use-ref"
  | "review-state";

type EffectAction =
  | "delete-effect"
  | "move-to-event"
  | "use-mount"
  | "use-unmount"
  | "use-observe-effect"
  | "keep-effect"
  | "review-effect";

type HookAction = StateAction | EffectAction;

type LegendPracticeAction =
  | "assign-observable-fields"
  | "batch-observable-writes"
  | "move-use-value-into-child"
  | "move-use-value-down"
  | "narrow-observable-write"
  | "narrow-use-value-subscription"
  | "pass-observable-to-use-value"
  | "replace-legacy-use-value"
  | "split-use-value-leaves"
  | "toggle-observable"
  | "use-peek-for-snapshot";

interface SourceLocation {
  column: number;
  file: string;
  line: number;
}

interface HookFinding {
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
    subscription:
      | "leaf-react"
      | "leaf-use-value"
      | "none"
      | "owner-react"
      | "owner-use-value"
      | "review";
  };
}

interface LegendPracticeFinding {
  action: LegendPracticeAction;
  confidence: Confidence;
  disposition: "change" | "style";
  evidence: readonly string[];
  location: SourceLocation;
  message: string;
  practice: "assign" | "batch" | "reactivity";
}

interface AnalysisReport {
  files: number;
  findings: HookFinding[];
  hooks: {
    effects: number;
    states: number;
    total: number;
  };
  practices: LegendPracticeFinding[];
  schemaVersion: 1;
}

export type {
  AnalysisReport,
  Confidence,
  EffectAction,
  HookAction,
  HookFinding,
  LegendPracticeAction,
  LegendPracticeFinding,
  SourceLocation,
  StateAction,
};
