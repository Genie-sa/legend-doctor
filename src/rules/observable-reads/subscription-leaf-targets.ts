import type { JsxSubtree, ObservableReadScan, UseValueDeclaration } from "./model.js";
import {
  hasUnstableSubtreeLifetime,
  jsxElementCount,
  jsxElementCountIn,
  lowestCommonJsxSubtree,
} from "../state-proofs/jsx-subtrees.js";
import { identifiedUseValueDeclaration, isUseValueCall } from "./observable-paths.js";
import { isInsideOwnerReturn, stableConditionalJsxSlot } from "./conditional-jsx-slots.js";
import { nodeWithin, visitSkippingNestedRuntimeFunctions } from "../../core/ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { hasUnprovenOwnerWork } from "./owner-subscription-work.js";
import { ownerHasMutableRenderRead } from "../state-proofs/render-purpose.js";
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
  use: UseValueDeclaration,
  { scan, derived = false }: { scan: ObservableReadScan; derived?: boolean },
): readonly MoveDownTarget[] {
  const { owner } = use;
  if (hasUnprovenOwnerWork(owner, scan)) {
    return [];
  }
  const common = moveDownTarget(references, owner, scan);
  if (common) {
    return [common];
  }
  if (ownerHasMutableRenderRead(owner, use.call, trackedCalls(owner, scan, derived))) {
    return [];
  }
  return separateTargets(references, owner, scan);
}

function trackedCalls(
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
  derived: boolean,
): ReadonlySet<ts.Node> {
  const trackedSources = new Set<ts.Node>();
  if (derived && owner.body) {
    visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
      if (ts.isCallExpression(node) && isUseValueCall(node, scan.imports)) {
        trackedSources.add(node);
      }
      if (ts.isVariableDeclaration(node)) {
        const subscription = identifiedUseValueDeclaration(node, scan);
        if (subscription) {
          for (const item of subscriptionFlow(subscription, scan).derivations) {
            if (item.kind === "useMemo") {
              trackedSources.add(item.declaration.initializer!);
            }
          }
        }
      }
    });
  }
  return trackedSources;
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
