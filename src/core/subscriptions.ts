import type { SourceLocation } from "./types.js";

export const SUBSCRIPTION_INVENTORY_STATUSES = ["planned", "other-action", "unresolved"] as const;

export const SUBSCRIPTION_READ_KINDS = [
  "render",
  "derivation",
  "memo",
  "render-callback",
  "event-or-callback",
  "effect",
  "unknown",
] as const;

export const SELECTOR_RESULTS = ["boolean", "primitive", "unknown"] as const;

/** Every reason an inventory entry can carry; `unresolved` entries name at least one. */
export const SUBSCRIPTION_INVENTORY_REASONS = [
  "destructured-result",
  "effect-consumer",
  "event-or-callback-consumer",
  "excluded-by-report-filter",
  "memo-consumer",
  "no-render-consumer",
  "observable-binding-not-proven",
  "overlapping-parent-subscription",
  "owner-commit-or-snapshot-work",
  "owner-not-proven",
  "render-callback-consumer",
  "returned-result",
  "selector-calls-unproven-function",
  "selector-function-not-proven",
  "selector-observable-binding-not-proven",
  "selector-read-not-proven",
  "selector-syntax-not-proven",
  "selector-tracks-no-observable",
  "shadowed-or-reassigned-binding",
  "stable-material-render-cut-not-proven",
  "unsupported-value-flow",
  "use-value-options",
  "wrapped-result",
] as const;

export type SubscriptionInventoryReason = (typeof SUBSCRIPTION_INVENTORY_REASONS)[number];

export interface SubscriptionBoundary {
  location: SourceLocation;
  start: number;
  end: number;
  label: string;
  kind: "new-child" | "conditional-child" | "existing-child";
  jsxElements: number;
}

export interface SubscriptionCut {
  owner: string;
  ownerLocation: SourceLocation;
  fingerprint: string;
  binding: string;
  observable: string;
  derivations: { name: string; kind: "const" | "useMemo"; location: SourceLocation }[];
  parentInputs: string[];
  ownerJsxElements: number;
  boundaries: SubscriptionBoundary[];
}

export interface SubscriptionInventory {
  location: SourceLocation;
  owner: string;
  binding: string | null;
  observable: string | null;
  /** Present for a `useValue(() => …)` binding whose every tracked read is a proven `path$.get()`. */
  selector?: { tracks: string[]; result: (typeof SELECTOR_RESULTS)[number] };
  status: (typeof SUBSCRIPTION_INVENTORY_STATUSES)[number];
  reasons: SubscriptionInventoryReason[];
  reads: {
    location: SourceLocation;
    name: string;
    kind: (typeof SUBSCRIPTION_READ_KINDS)[number];
  }[];
  derivations: SubscriptionCut["derivations"];
}

export interface SubscriptionCosts {
  ownerRenders: number;
  siblingRenders: number;
  selectorExecutions?: number;
  selectorDurationMs?: number;
  scenarioDurationMs?: number;
}

export interface SubscriptionEnvironment {
  /** Engine/harness and React/Legend versions. */
  runtime: string;
  /** OS and device, or explicitly jsdom. */
  platform: string;
  /** Build mode, StrictMode, instrumentation, and scenario completion boundary. */
  configuration: string;
}

export interface SubscriptionMeasurement {
  planId: string;
  fingerprint: string;
  scenario: string;
  samples: number;
  before: SubscriptionCosts;
  after: SubscriptionCosts;
  environment?: SubscriptionEnvironment;
  behaviorEquivalent: true;
}

export interface SubscriptionPlan {
  id: string;
  fingerprint: string;
  location: SourceLocation;
  owner: string;
  rank: number;
  subscriptions: { binding: string; observable: string }[];
  derivations: SubscriptionCut["derivations"];
  children: (SubscriptionBoundary & { subscriptions: string[] })[];
  parentInputs: string[];
  steps: string[];
  impact: {
    basis: "static-jsx" | "provided-runtime-measurement";
    ownerJsxElements: number;
    affectedJsxElements: number;
    measurement: SubscriptionMeasurement | null;
  };
  verification: string[];
}

export interface SubscriptionAnalysis {
  version: 1;
  inventory: SubscriptionInventory[];
  coverage: { total: number; planned: number; otherAction: number; unresolved: number };
  plans: SubscriptionPlan[];
  rejectedMeasurements: { planId: string; reason: string }[];
}
