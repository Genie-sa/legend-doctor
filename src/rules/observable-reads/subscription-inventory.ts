import { identifiedUseValueDeclaration, isUseValueCall } from "./observable-paths.js";
import { subscriptionLocation, subscriptionOwner } from "./subscription-cut.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import type { ObservableReadScan } from "./model.js";
import type { SubscriptionInventory } from "../../core/subscriptions.js";
import { hasAncestorUseValueSubscription } from "./move-down.js";
import { hasUnprovenOwnerWork } from "./owner-subscription-work.js";
import { subscriptionFlow } from "./subscription-flow.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

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
  const use = declaration ? identifiedUseValueDeclaration(declaration, scan) : null;
  const location = subscriptionLocation(declaration ?? call, scan);
  const finding = findings.find(
    (item) => item.location.line === location.line && item.location.column === location.column,
  );
  const flow = use ? subscriptionFlow(use, scan) : null;
  return {
    location,
    owner: use ? subscriptionOwner(use) : "unresolved",
    binding: use?.localName ?? null,
    observable: use?.observable.getText() ?? null,
    status: inventoryStatus(finding),
    reasons: finding ? [] : inventoryReasons(flow, scan),
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
}

function inventoryReasons(
  flow: ReturnType<typeof subscriptionFlow> | null,
  scan: ObservableReadScan,
): string[] {
  if (!flow) {
    return ["selector-options-or-binding-not-proven"];
  }
  const reasons = new Set(flow.blockers);
  if (hasUnprovenOwnerWork(flow.use.owner, scan)) {
    reasons.add("owner-commit-or-snapshot-work");
  }
  if (hasAncestorUseValueSubscription(flow.use.call, flow.use.owner, scan)) {
    reasons.add("overlapping-parent-subscription");
  }
  if (reasons.size === 0) {
    reasons.add("stable-material-render-cut-not-proven");
  }
  return [...reasons].toSorted();
}

function inventoryStatus(
  finding: LegendPracticeFinding | undefined,
): SubscriptionInventory["status"] {
  if (finding?.subscription) {
    return "planned";
  }
  return finding ? "other-action" : "unresolved";
}
