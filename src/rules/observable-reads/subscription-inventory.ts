import { hasAncestorUseValueSubscription, otherSubscriptionTracksAncestor } from "./move-down.js";
import { subscriptionLocation, subscriptionOwner } from "./subscription-cut.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import type { ObservableReadScan } from "./model.js";
import type { SubscriptionFlow } from "./subscription-flow.js";
import type { SubscriptionInventory } from "../../core/subscriptions.js";
import type { UseValueBinding } from "./use-value-bindings.js";
import { hasUnprovenOwnerWork } from "./owner-subscription-work.js";
import { isUseValueCall } from "./observable-paths.js";
import { staticMemberPrefix } from "./selector-expressions.js";
import { subscriptionFlow } from "./subscription-flow.js";
import ts from "typescript";
import { useValueBinding } from "./use-value-bindings.js";
import { visit } from "../../core/ast.js";

type ProvenBinding = Exclude<UseValueBinding, { kind: "unproven" }>;

type BindingAnalysis =
  | { readonly binding: ProvenBinding; readonly flow: SubscriptionFlow }
  | { readonly binding: Extract<UseValueBinding, { kind: "unproven" }>; readonly flow: null };

export function subscriptionInventory(
  scan: ObservableReadScan,
  findings: readonly LegendPracticeFinding[],
): SubscriptionInventory[] {
  const inventory: SubscriptionInventory[] = [];
  visit(scan.sourceFile, (node) => {
    if (ts.isCallExpression(node) && isUseValueCall(node, scan.imports)) {
      inventory.push(inventoryEntry(node, scan, findings));
    }
  });
  return inventory;
}

function inventoryEntry(
  call: ts.CallExpression,
  scan: ObservableReadScan,
  findings: readonly LegendPracticeFinding[],
): SubscriptionInventory {
  const declaration = ts.isVariableDeclaration(call.parent) ? call.parent : null;
  const analysis = bindingAnalysis(call, scan);
  const { binding, flow } = analysis;
  const use = flow?.use;
  const location = subscriptionLocation(declaration ?? call, scan);
  const finding = findings.find(
    (item) => item.location.line === location.line && item.location.column === location.column,
  );
  const entry: SubscriptionInventory = {
    location,
    owner: use ? subscriptionOwner(use) : "unresolved",
    binding: use?.localName ?? null,
    observable: inventoryObservable(binding, scan),
    status: inventoryStatus(finding),
    reasons: finding ? [] : inventoryReasons(analysis, scan),
    reads:
      flow?.reads.map((read) => ({
        location: subscriptionLocation(read.node, scan),
        name: read.node.text,
        kind: read.kind,
      })) ?? [],
    derivations:
      flow?.derivations.map((item) => ({
        location: subscriptionLocation(item.declaration, scan),
        name: item.declaration.name.getText(),
        kind: item.kind,
      })) ?? [],
  };
  if (binding.kind === "selector") {
    entry.selector = {
      tracks: binding.selector.tracked.map((path) => path.getText(scan.sourceFile)),
      result: binding.selector.result,
    };
  }
  return entry;
}

function inventoryObservable(binding: UseValueBinding, scan: ObservableReadScan): string | null {
  if (binding.kind === "observable") {
    return binding.use.observable.getText();
  }
  const [sole, ...others] = binding.kind === "selector" ? binding.selector.tracked : [];
  return sole && others.length === 0 ? sole.getText(scan.sourceFile) : null;
}

function bindingAnalysis(call: ts.CallExpression, scan: ObservableReadScan): BindingAnalysis {
  const binding = useValueBinding(call, scan);
  return binding.kind === "unproven"
    ? { binding, flow: null }
    : { binding, flow: subscriptionFlow(binding.use, scan) };
}

function inventoryReasons(analysis: BindingAnalysis, scan: ObservableReadScan): string[] {
  if (!analysis.flow) {
    return [analysis.binding.blocker];
  }
  const reasons = new Set([...analysis.flow.blockers, ...ownerReasons(analysis, scan)]);
  if (reasons.size === 0) {
    reasons.add("stable-material-render-cut-not-proven");
  }
  return [...reasons].toSorted();
}

function ownerReasons(
  analysis: Extract<BindingAnalysis, { flow: SubscriptionFlow }>,
  scan: ObservableReadScan,
): string[] {
  const facts: readonly (readonly [boolean, string])[] = [
    [hasUnprovenOwnerWork(analysis.flow.use.owner, scan), "owner-commit-or-snapshot-work"],
    [overlapsOwnerSubscription(analysis.binding, scan), "overlapping-parent-subscription"],
  ];
  return facts.filter(([holds]) => holds).map(([, reason]) => reason);
}

function overlapsOwnerSubscription(binding: ProvenBinding, scan: ObservableReadScan): boolean {
  if (binding.kind === "observable") {
    return hasAncestorUseValueSubscription(binding.use.call, binding.use.owner, scan);
  }
  return binding.selector.tracked.some((path) => {
    const prefix = staticMemberPrefix(path);
    return prefix === null || otherSubscriptionTracksAncestor(binding.use, prefix, scan);
  });
}

function inventoryStatus(
  finding: LegendPracticeFinding | undefined,
): SubscriptionInventory["status"] {
  if (finding?.subscription) {
    return "planned";
  }
  return finding ? "other-action" : "unresolved";
}
