import type { SourceLocation } from "./types.js";

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
  status: "planned" | "other-action" | "unresolved";
  reasons: string[];
  reads: {
    location: SourceLocation;
    name: string;
    kind: "render" | "derivation" | "event-or-callback" | "effect" | "unknown";
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
