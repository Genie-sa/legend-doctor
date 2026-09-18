import type { JsxSubtree, ObservableReadScan } from "./model.js";
import {
  hasUnstableSubtreeLifetime,
  jsxElementCount,
  jsxElementCountIn,
  lowestCommonJsxSubtree,
} from "../state-proofs/jsx-subtrees.js";
import {
  identifiedUseValueDeclaration,
  isUseValueCall,
  provenObservablePath,
} from "./observable-paths.js";
import { isInsideOwnerReturn, stableConditionalJsxSlot } from "./conditional-jsx-slots.js";
import { nodeWithin, visitSkippingNestedRuntimeFunctions } from "../../core/ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { SubscriptionFlow } from "./subscription-flow.js";
import { hasPlainOwnerParameters } from "./owner-parameter-work.js";
import { hasStableIndependentBindings } from "./independent-subscription-bindings.js";
import { hasUnprovenOwnerWork } from "./owner-subscription-work.js";
import { isImportedHookCall } from "../../core/imports.js";
import { ownerClassProjectionCalls } from "./owner-class-projections.js";
import { ownerHasMutableRenderRead } from "../state-proofs/render-purpose.js";
import { pureFlowExpression } from "./flow-expressions.js";
import { subscriptionFlow } from "./subscription-flow.js";
import ts from "typescript";

const MAX_LEAF_OWNER_SHARE = 0.4;

export interface MoveDownTarget {
  readonly leaf: JsxSubtree | null;
  readonly node: ts.Node;
  readonly leafElements: number;
  readonly ownerElements: number;
  readonly references: readonly ts.Identifier[];
}

export function moveDownTargets(
  references: readonly ts.Identifier[],
  { scan, flow }: { scan: ObservableReadScan; flow: SubscriptionFlow },
): readonly MoveDownTarget[] {
  const { use } = flow;
  const { owner } = use;
  if (hasUnprovenOwnerWork(owner, scan)) {
    return [];
  }
  if (
    ownerHasMutableRenderRead(owner, use.call, {
      trackedSources: trackedCalls(owner, scan, flow),
      pureCalls: ownerClassProjectionCalls(owner, scan),
    })
  ) {
    return [];
  }
  const common = moveDownTarget(references, owner, scan);
  if (common) {
    return [common];
  }
  return separateTargets(references, owner, scan);
}

function trackedCalls(
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
  flow: SubscriptionFlow,
): ReadonlySet<ts.Node> {
  if (!owner.body) {
    return new Set();
  }
  const names = new Set(flow.names);
  const primitives = new Set(flow.primitives);
  mergeIndependentFlows(owner, scan, { names, primitives });
  const scope = { names, primitives, sourceFile: scan.sourceFile };
  const trackedSources = new Set<ts.Node>();
  if (owner.body) {
    visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
      if (
        ts.isCallExpression(node) &&
        (isDirectSubscription(node, scan) ||
          pureFlowExpression(node, scope) ||
          (["useMemo", "useCallback"] as const).some((canonicalName) =>
            isImportedHookCall({
              call: node,
              canonicalName,
              localNames: scan.imports[canonicalName],
              namespaceNames: scan.imports.reactNamespaces,
            }),
          ))
      ) {
        // Owner-work validation checks memo dependencies first. A cached value or
        // Deferred callback is not a fresh imperative read on this subscription's update.
        trackedSources.add(node);
      }
    });
  }
  return trackedSources;
}

function mergeIndependentFlows(
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
  scope: { names: Set<string>; primitives: Set<string> },
): void {
  if (!owner.body || !hasPlainOwnerParameters(owner)) {
    return;
  }
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (!ts.isVariableDeclaration(node) || !(node.parent.flags & ts.NodeFlags.Const)) {
      return;
    }
    const use = identifiedUseValueDeclaration(node, scan);
    if (!use || use.owner !== owner || !hasStableIndependentBindings(use)) {
      return;
    }
    mergeIndependentScope(subscriptionFlow(use, scan), scope);
  });
}

function mergeIndependentScope(
  flow: SubscriptionFlow,
  scope: { names: Set<string>; primitives: Set<string> },
): void {
  if (flow.blockers.has("shadowed-or-reassigned-binding")) {
    return;
  }
  for (const name of flow.names) {
    scope.names.add(name);
  }
  for (const name of flow.primitives) {
    scope.primitives.add(name);
  }
}

function separateTargets(
  references: readonly ts.Identifier[],
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): readonly MoveDownTarget[] {
  const byNode = new Map<ts.Node, MoveDownTarget>();
  for (const reference of references) {
    const target = moveDownTarget([reference], owner, scan);
    if (!target || !isInsideOwnerReturn(target.node, owner)) {
      return [];
    }
    byNode.set(target.node, target);
  }
  // A conditional slot can contain another read's leaf. Extract that slot only once.
  const nodes = [...byNode.keys()];
  const targets = [...byNode.values()].filter(
    (target) => !nodes.some((other) => other !== target.node && nodeWithin(target.node, other)),
  );
  const elements = targets.reduce((total, target) => total + target.leafElements, 0);
  return targets.length > 1 && elements / jsxElementCount(owner) <= MAX_LEAF_OWNER_SHARE
    ? targets
    : [];
}

function moveDownTarget(
  references: readonly ts.Identifier[],
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): MoveDownTarget | null {
  const conditionalSlot = stableConditionalJsxSlot(references, owner, scan.imports);
  const subtree = conditionalSlot ? null : lowestCommonJsxSubtree(references, owner);
  const leaf = subtree && !hasUnstableSubtreeLifetime(subtree, owner) ? subtree : null;
  const node = leaf ?? conditionalSlot;
  if (!node) {
    return null;
  }
  const ownerElements = jsxElementCount(owner);
  const leafElements = jsxElementCountIn(node);
  return leafElements / ownerElements <= MAX_LEAF_OWNER_SHARE
    ? { leaf, leafElements, node, ownerElements, references }
    : null;
}

function isDirectSubscription(call: ts.CallExpression, scan: ObservableReadScan): boolean {
  return (
    isUseValueCall(call, scan.imports) &&
    call.arguments.length === 1 &&
    provenObservablePath(call.arguments[0]!, scan.observableBindings) !== null
  );
}
