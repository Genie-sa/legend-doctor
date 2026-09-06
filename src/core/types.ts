type Confidence = "certain" | "probable";

// oxlint-disable-next-line eslint/no-magic-numbers -- Public JSON protocol version.
const SCHEMA_VERSION = 3 as const;

type AbstentionReason =
  | "atomic-transition-unproven"
  | "binding-shape-unsupported"
  | "callback-timing-unresolved"
  | "child-contract-unresolved"
  | "effect-callback-unresolved"
  | "effect-causal-owner-unresolved"
  | "effect-write-ownership-unresolved"
  | "lifecycle-equivalence-unproven"
  | "mount-identity-unproven"
  | "no-proven-optimization"
  | "ownership-flow-unresolved"
  | "paired-draft-effect-preserved"
  | "react-commit-sensitive"
  | "render-cut-unproven"
  | "state-type-unresolved";

type AssumptionAnswer = "no" | "yes";

type AssumptionStatus = "confirmed" | "open" | "rejected" | "stale";

/** One place an agent must read to answer a review question, and what to verify there. */
interface ResearchStep {
  check: string;
  file: string;
  line: number;
}

/** An open review question ordered by the renders an answer is expected to save. */
interface RankedQuestion {
  file: string;
  id: string;
  ifConfirmed: StateAssumption["ifConfirmed"];
  line: number;
  name: string | null;
  /** Render cost weighted by update sites; the sort key. */
  priority: number;
  rank: number;
}

/**
 * What a confirmed answer turns a finding into. Deletions need a full proof and keeps need none;
 * a group member another blocker still holds reports `review-state` with a `nextBlocker`.
 */
type AssumptionOutcome =
  | Exclude<StateAction, "delete-derived-state" | "delete-unused-state" | "keep-state">
  | "use-mount";

/** One member of a co-written group and what confirming the group does to it. */
interface AssumptionGroupMember {
  name: string;
  /** The blocker that still stands for this member once the group is confirmed. */
  nextBlocker?: AbstentionReason;
  outcome: AssumptionOutcome;
}

/** A yes/no fact that would turn a review finding into a conversion. */
interface StateAssumption {
  /** The blockers a "yes" assumes away, in the order they were removed; usually one, at most two. */
  facts: AbstentionReason[];
  /** Digest of the owner's source; an answer recorded for a different digest is stale. */
  fingerprint: string;
  /** Stable across line shifts: report file, owner name, state name, and blocker reasons. */
  id: string;
  /** The action this finding takes once the assumption is confirmed. */
  ifConfirmed: AssumptionOutcome;
  /** Present on co-written group questions: every member and its outcome once the group is confirmed. */
  members?: AssumptionGroupMember[];
  /** The concrete fact to confirm, phrased so "yes" justifies the conversion. */
  question: string;
  /** JSX elements the owner renders per update of this state; rank open questions by it. */
  renderCost: number;
  /** Exact places to read, in order, before answering. */
  research: ResearchStep[];
  status: AssumptionStatus;
  /** Setter call sites, an update-frequency proxy for ranking. */
  updateSites: number;
}

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
  | "persist-observable"
  | "keep-effect"
  | "review-effect";

type HookAction = StateAction | EffectAction;

type LegendPracticeAction =
  | "assign-observable-fields"
  | "batch-observable-writes"
  | "derive-computed-observable"
  | "move-use-value-into-child"
  | "move-use-value-down"
  | "narrow-observable-write"
  | "narrow-use-value-subscription"
  | "pass-observable-to-reactive-input"
  | "pass-observable-to-use-value"
  | "replace-legacy-use-value"
  | "reuse-observable-reference"
  | "snapshot-computed-initializer"
  | "split-use-value-leaves"
  | "split-use-value-result"
  | "toggle-observable"
  | "use-peek-for-snapshot"
  | "use-value-for-render-read";

interface SourceLocation {
  column: number;
  file: string;
  line: number;
}

/** How to check a conversion that rests on a confirmed answer rather than a proof. */
interface Verification {
  /** The observable outcome that must hold for the answer to stand. */
  expect: string;
  /** The package export that provides the jsdom mount and render-count helpers. */
  harness: string;
  steps: string[];
}

interface HookFindingBase {
  /** Present on review findings with a confirmable blocker, and on findings a confirmation converted. */
  assumption?: StateAssumption;
  /** Present on findings a confirmation converted: the runtime check that validates the answer. */
  verification?: Verification;
  /** Open question ids whose answers settle this review effect; answer those, not the effect. */
  waitsOn?: string[];
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
  /** Present when the compact tier admitted an owner below the default broad-owner size. */
  materiality?: "compact";
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

type HookFinding = HookFindingBase &
  (
    | {
        abstentionReason: AbstentionReason;
        action: "review-effect" | "review-state";
      }
    | {
        abstentionReason?: never;
        action: Exclude<HookAction, "review-effect" | "review-state">;
      }
  );

interface LegendPracticeFinding {
  action: LegendPracticeAction;
  confidence: Confidence;
  disposition: "change" | "style";
  evidence: readonly string[];
  location: SourceLocation;
  message: string;
  practice: "assign" | "batch" | "ownership" | "reactivity";
}

/** How the confirmations file matched the scan's assumptions. */
interface ReportConfirmations {
  /** Confirmed assumptions that turned a review finding into a conversion. */
  applied: number;
  rejected: number;
  /** The confirmations file that was read, or null when answers came from the API. */
  source: string | null;
  /** Answers whose owner fingerprint no longer matches; asked again, not applied. */
  stale: number;
  /** Confirmation ids no finding in this scan produced. */
  unmatched: string[];
}

interface AnalysisReport {
  /** Present when a confirmations file was supplied. */
  confirmations?: ReportConfirmations;
  files: number;
  /** Open review questions, highest expected render saving first; present when any exist. */
  questions?: RankedQuestion[];
  findings: HookFinding[];
  hooks: {
    effects: number;
    states: number;
    total: number;
  };
  practices: LegendPracticeFinding[];
  capabilities: ReportCapabilities;
  schemaVersion: typeof SCHEMA_VERSION;
  /** Present when a file filter narrowed the analyzed files below the loaded context. */
  scope?: ReportScope;
}

type UseValueExport = "alias" | "distinct" | "missing" | "unknown";

type SyncExport = "available" | "missing" | "unknown";

interface InstalledLegendState {
  /** Whether the installed package exposes the sync entry point that carries `synced` and `syncObservable`. */
  syncExport: SyncExport;
  /** How the installed react entry point exports useValue relative to useSelector. */
  useValueExport: UseValueExport;
  version: string;
}

interface DisabledRule {
  detail: string;
  /** Analyzed files in which the rule was skipped. */
  files: number;
  reason: string;
  rule: string;
}

interface ReportCapabilities {
  disabledRules: DisabledRule[];
  legendState: InstalledLegendState | null;
  /** The analysis root's package or bundler config enables the React Compiler. */
  reactCompiler: boolean;
}

interface ReportScope {
  /** Files loaded for cross-file proofs, including the ones the filter excluded from analysis. */
  contextFiles: number;
}

export { SCHEMA_VERSION };
export type {
  AbstentionReason,
  AssumptionAnswer,
  AssumptionGroupMember,
  AssumptionStatus,
  AnalysisReport,
  Confidence,
  DisabledRule,
  EffectAction,
  HookAction,
  HookFinding,
  InstalledLegendState,
  RankedQuestion,
  LegendPracticeAction,
  LegendPracticeFinding,
  ReportCapabilities,
  ReportConfirmations,
  ReportScope,
  ResearchStep,
  SourceLocation,
  StateAction,
  StateAssumption,
  SyncExport,
  UseValueExport,
  Verification,
};
