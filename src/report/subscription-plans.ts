import type {
  SubscriptionAnalysis,
  SubscriptionCut,
  SubscriptionInventory,
  SubscriptionMeasurement,
  SubscriptionPlan,
} from "../core/subscriptions.js";
import type { LegendPracticeFinding } from "../core/types.js";
import { applySubscriptionMeasurements } from "./subscription-measurements.js";
import { isNonValueIdentifier } from "../core/analysis-ast.js";
import ts from "typescript";
import { visit } from "../core/ast.js";

export function buildSubscriptionAnalysis(
  findings: readonly LegendPracticeFinding[],
  inventory: SubscriptionInventory[],
  measurements: readonly (SubscriptionMeasurement | null)[] = [],
): SubscriptionAnalysis {
  const groups = new Map<string, SubscriptionCut[]>();
  for (const finding of findings) {
    const cut = finding.subscription;
    if (!cut) {
      continue;
    }
    const key = `${cut.ownerLocation.file}::${cut.owner}::${cut.ownerLocation.line}:${cut.ownerLocation.column}`;
    const group = groups.get(key) ?? [];
    group.push(cut);
    groups.set(key, group);
  }
  return applySubscriptionMeasurements(
    {
      version: 1,
      inventory,
      plans: [...groups].map(([id, cuts]) => ownerPlan(id, cuts)),
      rejectedMeasurements: [],
      coverage: {
        total: inventory.length,
        planned: inventory.filter((item) => item.status === "planned").length,
        otherAction: inventory.filter((item) => item.status === "other-action").length,
        unresolved: inventory.filter((item) => item.status === "unresolved").length,
      },
    },
    measurements,
  );
}

function ownerPlan(id: string, cuts: SubscriptionCut[]): SubscriptionPlan {
  const first = cuts[0]!;
  const children = mergeBoundaries(cuts);
  const derivations = cuts
    .flatMap((cut) => cut.derivations)
    .filter((item, index, all) => all.findIndex((other) => other.name === item.name) === index);
  const moved = new Set([
    ...cuts.map((cut) => cut.binding),
    ...derivations.map((item) => item.name),
  ]);
  return {
    id,
    fingerprint: first.fingerprint,
    location: first.ownerLocation,
    owner: first.owner,
    rank: 0,
    subscriptions: cuts.map((cut) => ({ binding: cut.binding, observable: cut.observable })),
    derivations,
    children,
    parentInputs: [...new Set(cuts.flatMap((cut) => cut.parentInputs))]
      .filter((input) => !referencesMovedInput(input, moved))
      .toSorted(),
    steps: [
      "Apply this owner plan together; merge overlapping boundaries into the listed children instead of nesting duplicate wrappers.",
      "Define new children at module scope. Keep each subscription child mounted in its original slot; render conditional descendants inside it.",
      `Move these subscriptions out of the owner: ${cuts.map((cut) => cut.binding).join(", ")}. Move their listed derivations with them and preserve useMemo dependencies.`,
      "Keep observable creation and writes in their current owner. Pass handles, dynamic component types, and the remaining parent-evaluated inputs as ordinary props.",
      "Keep each existing batch/assign transaction intact. Rescan after applying the complete plan to check that no transported subscription remains in the owner.",
    ],
    impact: {
      basis: "static-jsx",
      ownerJsxElements: first.ownerJsxElements,
      affectedJsxElements: children.reduce((total, child) => total + child.jsxElements, 0),
      measurement: null,
    },
    verification: [
      "Compare the same interaction before and after: record owner and unrelated sibling renders, excluding mount renders.",
      "Verify visible values, event callback snapshots, local drafts, and DOM/native child identity through updates and prop changes.",
      "Verify conditional mount/unmount and effect cleanup in normal and StrictMode runs; preserve atomic multi-field transitions.",
    ],
  };
}

function mergeBoundaries(cuts: readonly SubscriptionCut[]): SubscriptionPlan["children"] {
  const entries = cuts.flatMap((cut) =>
    cut.boundaries.map((boundary) => ({ ...boundary, subscriptions: [cut.binding] })),
  );
  entries.sort((left, right) => left.start - right.start || right.end - left.end);
  const children: SubscriptionPlan["children"] = [];
  for (const entry of entries) {
    const parent = children.find((child) => child.start <= entry.start && child.end >= entry.end);
    if (parent) {
      parent.subscriptions = [...new Set([...parent.subscriptions, ...entry.subscriptions])];
    } else {
      children.push(entry);
    }
  }
  return children;
}

function referencesMovedInput(input: string, moved: ReadonlySet<string>): boolean {
  const source = ts.createSourceFile(
    "input.tsx",
    `const input = (${input});`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let dependent = false;
  visit(source, (node) => {
    if (ts.isIdentifier(node) && !isNonValueIdentifier(node) && moved.has(node.text)) {
      dependent = true;
    }
  });
  return dependent;
}

export function filterSubscriptionAnalysis(
  analysis: SubscriptionAnalysis,
  findings: readonly LegendPracticeFinding[],
): SubscriptionAnalysis {
  const visible = (entry: SubscriptionInventory): boolean =>
    findings.some(
      (finding) =>
        finding.location.file === entry.location.file &&
        finding.location.line === entry.location.line &&
        finding.location.column === entry.location.column,
    );
  const inventory = analysis.inventory.map((entry): SubscriptionInventory =>
    entry.status !== "unresolved" && !visible(entry)
      ? { ...entry, status: "unresolved", reasons: ["excluded-by-report-filter"] }
      : entry,
  );
  const filtered = buildSubscriptionAnalysis(findings, inventory);
  const measured = applySubscriptionMeasurements(
    filtered,
    retainedMeasurements(analysis, filtered),
  );
  return { ...measured, rejectedMeasurements: analysis.rejectedMeasurements };
}

function retainedMeasurements(
  original: SubscriptionAnalysis,
  filtered: SubscriptionAnalysis,
): SubscriptionMeasurement[] {
  const retained = new Set(filtered.plans.map((plan) => planEditKey(plan)));
  return original.plans.flatMap((plan) =>
    plan.impact.measurement && retained.has(planEditKey(plan)) ? [plan.impact.measurement] : [],
  );
}

/** Runtime evidence describes the complete edit, not just the owner whose source stayed unchanged. */
function planEditKey(plan: SubscriptionPlan): string {
  return JSON.stringify([
    plan.id,
    plan.fingerprint,
    plan.subscriptions,
    plan.children,
    plan.derivations,
    plan.parentInputs,
  ]);
}
