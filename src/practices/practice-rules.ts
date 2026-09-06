import type { FileCapabilities } from "../project/capabilities.js";
import type { HookImports } from "../core/imports.js";
import type { LegendPracticeFinding } from "../core/types.js";
import type { LegendPracticesRequest } from "./model.js";
import { collectTransactionFindings } from "./transaction-runs.js";
import { findDerivedUseValuePractices } from "../rules/derived-use-value/derived-use-value.js";
import { findLegacyUseValuePractices } from "../rules/legacy-use-value.js";
import { findObservableCloneWritePractices } from "../rules/observable-clone-writes/observable-clone-writes.js";
import { findObservableOwnershipPractices } from "../rules/observable-ownership/observable-ownership.js";
import { findObservableReadPractices } from "../rules/observable-reads/observable-reads.js";
import { findObservableTogglePractices } from "../rules/observable-toggle.js";
import { findObservableTrackingPractices } from "../rules/observable-tracking/observable-tracking.js";

export type PracticeRuleId =
  | "derived-use-value"
  | "legacy-use-value"
  | "observable-clone-writes"
  | "observable-ownership"
  | "observable-reads"
  | "observable-toggle"
  | "observable-tracking"
  | "observable-transactions";

export type PracticeRuleGateReason =
  | "legend-v2-tracking"
  | "react-compiler"
  | "use-value-export-missing";

export interface PracticeRuleGate {
  readonly detail: string;
  readonly reason: PracticeRuleGateReason;
}

export interface PracticeRuleInput {
  readonly imports: HookImports;
  readonly observableBindings: ReadonlySet<string>;
  readonly observableKeys: ReadonlyMap<string, ReadonlySet<string>>;
  readonly request: LegendPracticesRequest;
}

export interface PracticeRule {
  /** Names the toolchain fact that makes the rule moot, or null when the rule applies. */
  readonly disabledWhen?: (capabilities: FileCapabilities) => PracticeRuleGate | null;
  readonly id: PracticeRuleId;
  /** The rule reads observable bindings and has nothing to report without one. */
  readonly needsObservableBindings: boolean;
  readonly run: (input: PracticeRuleInput) => readonly LegendPracticeFinding[];
}

export interface DisabledPracticeRule extends PracticeRuleGate {
  readonly rule: PracticeRuleId;
}

const REACT_COMPILER_GATE: PracticeRuleGate = {
  detail:
    "the React Compiler memoizes by reference, so in-place observable writes would leave memoized consumers stale",
  reason: "react-compiler",
};

const USE_VALUE_MISSING_GATE: PracticeRuleGate = {
  detail: "the installed @legendapp/state/react entry point does not export useValue",
  reason: "use-value-export-missing",
};

const LEGEND_V2_TRACKING_GATE: PracticeRuleGate = {
  detail:
    "@legendapp/state 2.x can track render-time get() calls through enableReactTracking({ auto: true }), an app-wide setting the analyzer cannot see",
  reason: "legend-v2-tracking",
};

const FIRST_VERSION_WITHOUT_AUTO_TRACKING = 3;

function isLegendBeforeV3(capabilities: FileCapabilities): boolean {
  const version = capabilities.legendState?.version;
  const major = version === undefined ? Number.NaN : Number(version.split(".")[0]);
  return Number.isInteger(major) && major < FIRST_VERSION_WITHOUT_AUTO_TRACKING;
}

export const PRACTICE_RULES: readonly PracticeRule[] = [
  {
    disabledWhen: (capabilities) =>
      capabilities.legendState?.useValueExport === "missing" ? USE_VALUE_MISSING_GATE : null,
    id: "legacy-use-value",
    needsObservableBindings: false,
    run: ({ imports, observableBindings, request }) =>
      findLegacyUseValuePractices({
        fileName: request.fileName,
        imports,
        installedLegendState: request.capabilities.legendState,
        observableBindings,
        sourceFile: request.sourceFile,
      }),
  },
  {
    id: "observable-transactions",
    needsObservableBindings: true,
    run: ({ imports, observableBindings, request }) =>
      collectTransactionFindings({
        fileName: request.fileName,
        imports,
        observableBindings,
        sourceFile: request.sourceFile,
      }),
  },
  {
    id: "observable-reads",
    needsObservableBindings: true,
    run: ({ imports, observableBindings, observableKeys, request }) =>
      findObservableReadPractices({
        childContracts: request.childContracts,
        fileName: request.fileName,
        imports,
        observableBindings,
        observableKeys,
        sourceFile: request.sourceFile,
      }),
  },
  {
    disabledWhen: (capabilities) => (capabilities.reactCompiler ? REACT_COMPILER_GATE : null),
    id: "observable-clone-writes",
    needsObservableBindings: true,
    run: ({ imports, observableBindings, request }) =>
      findObservableCloneWritePractices({
        fileName: request.fileName,
        importedObservableArrayPaths: request.importedObservableArrayPaths,
        imports,
        observableBindings,
        sourceFile: request.sourceFile,
      }),
  },
  {
    id: "observable-toggle",
    needsObservableBindings: true,
    run: ({ observableBindings, request }) =>
      findObservableTogglePractices(request.sourceFile, request.fileName, observableBindings),
  },
  {
    disabledWhen: (capabilities) =>
      isLegendBeforeV3(capabilities) ? LEGEND_V2_TRACKING_GATE : null,
    id: "observable-tracking",
    needsObservableBindings: true,
    run: ({ imports, observableBindings, request }) =>
      findObservableTrackingPractices({
        fileName: request.fileName,
        imports,
        observableBindings,
        sourceFile: request.sourceFile,
      }),
  },
  {
    id: "derived-use-value",
    needsObservableBindings: true,
    run: ({ imports, observableBindings, request }) =>
      findDerivedUseValuePractices({
        fileName: request.fileName,
        imports,
        observableBindings,
        sourceFile: request.sourceFile,
      }),
  },
  {
    id: "observable-ownership",
    needsObservableBindings: true,
    run: ({ imports, observableBindings, request }) =>
      findObservableOwnershipPractices({
        fileName: request.fileName,
        imports,
        observableBindings,
        sourceFile: request.sourceFile,
      }),
  },
];

export function disabledPracticeRules(capabilities: FileCapabilities): DisabledPracticeRule[] {
  return PRACTICE_RULES.flatMap((rule) => {
    const gate = rule.disabledWhen?.(capabilities) ?? null;
    return gate ? [{ ...gate, rule: rule.id }] : [];
  });
}

export function enabledPracticeRules(capabilities: FileCapabilities): PracticeRule[] {
  return PRACTICE_RULES.filter((rule) => (rule.disabledWhen?.(capabilities) ?? null) === null);
}
