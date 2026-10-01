import type {
  SubscriptionInventory,
  SubscriptionInventoryReason,
  SubscriptionRuleGate,
} from "../../core/subscriptions.js";
import { hasAncestorUseValueSubscription, otherSubscriptionTracksAncestor } from "./move-down.js";
import { subscriptionLocation, subscriptionOwner } from "./subscription-cut.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import type { ObservableReadScan } from "./model.js";
import type { SubscriptionFlow } from "./subscription-flow.js";
import type { UseValueBinding } from "./use-value-bindings.js";
import { hasInventoryAnchor } from "../../core/subscriptions.js";
import { hasUnprovenOwnerWork } from "./owner-subscription-work.js";
import { isUseValueCall } from "./observable-paths.js";
import { staticMemberPrefix } from "./selector-expressions.js";
import { subscriptionFlow } from "./subscription-flow.js";
import ts from "typescript";
import { unrenderedUseValueGate } from "./unrendered-subscriptions.js";
import { useValueBinding } from "./use-value-bindings.js";
import { visit } from "../../core/ast.js";
import { wrappedResultDeclaration } from "./wrapped-use-value-results.js";

type ProvenBinding = Exclude<UseValueBinding, { kind: "unproven" }>;

type BindingAnalysis =
  | { readonly binding: ProvenBinding; readonly flow: SubscriptionFlow }
  | { readonly binding: Extract<UseValueBinding, { kind: "unproven" }>; readonly flow: null };

/** Entries start `unresolved`; `resolveSubscriptionInventory` settles them once every practice rule has run. */
export function subscriptionInventory(scan: ObservableReadScan): SubscriptionInventory[] {
  const inventory: SubscriptionInventory[] = [];
  visit(scan.sourceFile, (node) => {
    if (ts.isCallExpression(node) && isUseValueCall(node, scan.imports)) {
      inventory.push(inventoryEntry(node, scan));
    }
  });
  return inventory;
}

export function resolveSubscriptionInventory(
  entry: SubscriptionInventory,
  findings: readonly LegendPracticeFinding[],
): SubscriptionInventory {
  const anchored = findings.filter((finding) => hasInventoryAnchor(entry, finding.location));
  if (anchored.length === 0) {
    return entry;
  }
  const status = anchored.some((finding) => finding.subscription) ? "planned" : "other-action";
  return { ...entry, status, reasons: [], ruleGates: [] };
}

function inventoryEntry(call: ts.CallExpression, scan: ObservableReadScan): SubscriptionInventory {
  const declaration = wrappedResultDeclaration(call);
  const analysis = bindingAnalysis(call, scan);
  const { binding, flow } = analysis;
  const use = flow?.use;
  const location = subscriptionLocation(declaration ?? call, scan);
  const entry: SubscriptionInventory = {
    location,
    callLocation: subscriptionLocation(call, scan),
    owner: use ? subscriptionOwner(use) : "unresolved",
    binding: use?.localName ?? null,
    observable: inventoryObservable(binding, scan),
    status: "unresolved",
    reasons: inventoryReasons(analysis, scan),
    ruleGates: ruleGates(declaration, scan),
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

/** Where each binding-scoped practice rule abstained, so a replay miss names the rule's own cause. */
function ruleGates(
  declaration: ts.VariableDeclaration | null,
  scan: ObservableReadScan,
): SubscriptionRuleGate[] {
  const gate = declaration
    ? unrenderedUseValueGate(declaration, scan)
    : "binding-not-owner-level-const";
  return gate ? [{ action: "peek-unrendered-use-value", gate }] : [];
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

function inventoryReasons(
  analysis: BindingAnalysis,
  scan: ObservableReadScan,
): SubscriptionInventoryReason[] {
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
): SubscriptionInventoryReason[] {
  const facts: readonly (readonly [boolean, SubscriptionInventoryReason])[] = [
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
