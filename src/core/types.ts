import type { SubscriptionAnalysis, SubscriptionCut } from "./subscriptions.js";
import type { StateTransitionEvidence } from "./state-transitions.js";

type Confidence = "certain" | "probable";

// oxlint-disable-next-line eslint/no-magic-numbers -- Public JSON protocol version.
const SCHEMA_VERSION = 4 as const;

const ABSTENTION_REASONS = [
  "async-command-origin-unresolved",
  "atomic-transition-unproven",
  "binding-shape-unsupported",
  "callback-timing-unresolved",
  "child-contract-unresolved",
  "effect-callback-unresolved",
  "effect-causal-owner-unresolved",
  "effect-write-ownership-unresolved",
  "lifecycle-equivalence-unproven",
  "mount-identity-unproven",
  "no-proven-optimization",
  "ownership-flow-unresolved",
  "paired-draft-effect-preserved",
  "react-commit-sensitive",
  "render-cut-unproven",
  "state-type-unresolved",
] as const;

type AbstentionReason = (typeof ABSTENTION_REASONS)[number];

type AssumptionAnswer = "no" | "yes";

type AssumptionStatus = "confirmed" | "open" | "rejected" | "stale";

/** One research instruction and the source sites where it applies. */
interface ResearchStep {
  check: string;
  file: string;
  line: number;
  /** All source lines for this instruction, including the first. */
  lines?: number[];
  /** Total source sites, including several occurrences on the same line. */
  total?: number;
}

/** An open review question ordered by the renders an answer is expected to save. */
interface RankedQuestion {
  /** Present for a group: members converted by this answer. */
  convertingCount?: number;
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
  /** The confirmed action, or the first converting member's action for a group. */
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

const STATE_ACTIONS = [
  "keep-state",
  "delete-unused-state",
  "move-state-down",
  "use-observable",
  "use-value",
  "delete-derived-state",
  "use-ref",
  "review-state",
] as const;

type StateAction = (typeof STATE_ACTIONS)[number];

const EFFECT_ACTIONS = [
  "delete-effect",
  "move-to-event",
  "use-mount",
  "use-unmount",
  "use-observe-effect",
  "persist-observable",
  "keep-effect",
  "review-effect",
] as const;

type EffectAction = (typeof EFFECT_ACTIONS)[number];

type HookAction = StateAction | EffectAction;

const LEGEND_PRACTICE_ACTIONS = [
  "select-primitive-projection",
  "review-helper-tracking",
  "assign-observable-fields",
  "batch-observable-writes",
  "derive-computed-observable",
  "move-use-value-into-child",
  "move-use-value-down",
  "narrow-observable-write",
  "narrow-use-value-subscription",
  "pass-observable-to-reactive-input",
  "pass-observable-to-use-value",
  "peek-unrendered-use-value",
  "replace-legacy-use-value",
  "reuse-observable-reference",
  "snapshot-computed-initializer",
  "snapshot-mutated-use-value",
  "split-use-value-leaves",
  "split-use-value-result",
  "stabilize-memo-prop",
  "toggle-observable",
  "use-computed-for-parent-reads",
  "use-peek-for-snapshot",
  "use-value-for-render-read",
] as const;

type LegendPracticeAction = (typeof LEGEND_PRACTICE_ACTIONS)[number];

/** Practice actions whose findings can carry `edits`. */
const EDITABLE_PRACTICE_ACTIONS = [
  "narrow-use-value-subscription",
  "pass-observable-to-use-value",
  "replace-legacy-use-value",
  "select-primitive-projection",
  "use-computed-for-parent-reads",
  "use-peek-for-snapshot",
  "use-value-for-render-read",
] as const satisfies readonly LegendPracticeAction[];

const HOOK_DISPOSITIONS = ["candidate", "change", "keep"] as const;

const PRACTICE_DISPOSITIONS = ["change", "style", "candidate"] as const;

const REVIEW_KINDS = [
  "confirm",
  "recheck",
  "declined",
  "dependency",
  "unsupported",
  "no-proven-benefit",
  "investigate",
] as const;

/** Why `capabilities.disabledRules` switched a rule off for the installed toolchain. */
const CAPABILITY_GATE_REASONS = [
  "legend-v2-tracking",
  "react-compiler",
  "sync-export-missing",
  "use-value-export-missing",
] as const;

type CapabilityGateReason = (typeof CAPABILITY_GATE_REASONS)[number];

interface SourceLocation {
  column: number;
  file: string;
  line: number;
}

/** A 1-based line and UTF-16 column in the scanned source, the convention `location` uses. */
interface SourcePosition {
  column: number;
  line: number;
}

/**
 * Replaces the half-open range [`start`, `end`) of `file` with `newText`; equal positions insert.
 * Positions refer to the scanned source, so apply one file's edits together, from its end.
 */
interface TextEdit {
  end: SourcePosition;
  file: string;
  newText: string;
  start: SourcePosition;
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
  /** Direct write locations and pairwise execution evidence for grouped states. */
  transitions?: StateTransitionEvidence;
  /** Triage guidance for review findings; never an authorization to apply a conversion. */
  review?: ReviewGuidance;
  /** Present on review findings with a confirmable blocker, and on findings a confirmation converted. */
  assumption?: StateAssumption;
  /** Present on findings a confirmation converted: the runtime check that validates the answer. */
  verification?: Verification;
  /** Open question ids whose answers settle this review effect; answer those, not the effect. */
  waitsOn?: string[];
  confidence: Confidence;
  disposition: (typeof HOOK_DISPOSITIONS)[number];
  evidence: readonly string[];
  hook: "useEffect" | "useState";
  group?: {
    id: string;
    kind: "state-cluster";
    members: readonly string[];
    primary: boolean;
  };
  location: SourceLocation;
  /** Present when compact mode changes the action or makes a new conversion confirmable. */
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

interface ReviewGuidance {
  /** Known blockers from this verdict and its question; not an exhaustive proof inventory. */
  blockers: AbstentionReason[];
  kind: (typeof REVIEW_KINDS)[number];
  /** The next concrete investigation or answer to supply. */
  next: string;
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
  subscription?: SubscriptionCut;
  action: LegendPracticeAction;
  confidence: Confidence;
  disposition: (typeof PRACTICE_DISPOSITIONS)[number];
  /**
   * The message's edit, present only when syntax fully determines it. Edits never overlap; findings
   * that share an import rewrite carry identical copies of it, which apply once.
   */
  edits?: readonly TextEdit[];
  evidence: readonly string[];
  location: SourceLocation;
  message: string;
  practice: "assign" | "batch" | "memoization" | "ownership" | "reactivity";
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
  subscriptionAnalysis?: SubscriptionAnalysis;
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

/** Where the version came from: the installed package, or the nearest lockfile when none is installed. */
const LEGEND_STATE_SOURCES = ["installed", "lockfile"] as const;

type LegendStateSource = (typeof LEGEND_STATE_SOURCES)[number];

interface InstalledLegendState {
  source: LegendStateSource;
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
  reason: CapabilityGateReason;
  rule: string;
}

interface ReportCapabilities {
  /** Every React renderer in the analysis root's workspace creates only concurrent roots. */
  concurrentRoot: boolean;
  disabledRules: DisabledRule[];
  /** The analysis root's Legend State; each file's rules read the install its own package resolves. */
  legendState: InstalledLegendState | null;
  /** The analysis root's package or bundler config enables the React Compiler. */
  reactCompiler: boolean;
}

interface ReportScope {
  /** Files loaded for cross-file proofs, including the ones the filter excluded from analysis. */
  contextFiles: number;
}

export {
  ABSTENTION_REASONS,
  CAPABILITY_GATE_REASONS,
  EDITABLE_PRACTICE_ACTIONS,
  EFFECT_ACTIONS,
  HOOK_DISPOSITIONS,
  LEGEND_PRACTICE_ACTIONS,
  LEGEND_STATE_SOURCES,
  PRACTICE_DISPOSITIONS,
  REVIEW_KINDS,
  SCHEMA_VERSION,
  STATE_ACTIONS,
};
export type {
  AbstentionReason,
  AssumptionAnswer,
  AssumptionGroupMember,
  AssumptionStatus,
  AnalysisReport,
  CapabilityGateReason,
  Confidence,
  DisabledRule,
  EffectAction,
  HookAction,
  HookFinding,
  InstalledLegendState,
  LegendStateSource,
  RankedQuestion,
  LegendPracticeAction,
  LegendPracticeFinding,
  ReportCapabilities,
  ReportConfirmations,
  ReportScope,
  ResearchStep,
  ReviewGuidance,
  SourceLocation,
  SourcePosition,
  StateAction,
  StateAssumption,
  SyncExport,
  TextEdit,
  UseValueExport,
  Verification,
};
