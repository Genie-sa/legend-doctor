import type { DirectReturnCallSite, DraftEffect, JsxSubtreeNode } from "./model.js";
import type { StateCandidate, StateUsage } from "../../analysis/model.js";
import {
  isSafeJsxProjectionReference,
  jsxElementCount,
  jsxElementCountIn,
  lowestCommonJsxSubtree,
} from "../state-proofs/jsx-subtrees.js";
import {
  nearestNestedFunction,
  nodeWithin,
  visitSkippingNestedRuntimeFunctions,
} from "../../core/ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { hasDirectJsxEventSetter } from "./draft-mutations.js";
import ts from "typescript";

const MIN_OWNER_JSX = 12;

const MAX_CUT_SHARE = 0.4;

export function hasDraftRenderCut(draft: DraftEffect, members: readonly StateCandidate[]): boolean {
  if (members.length === 1 && draft.context.siblingRenderCuts.has(members[0]!)) {
    return true;
  }
  const ownerJsx = jsxElementCount(draft.owner);
  const usages = members.map((member) => draft.context.usageByState.get(member));
  if (hasLocalRenderCutWitness(draft, members, ownerJsx)) {
    return true;
  }
  if (
    ownerJsx >= MIN_OWNER_JSX &&
    usages.every((usage) => usage && draftValueTransportsAreBounded(usage, draft.owner, ownerJsx))
  ) {
    return true;
  }
  return hasSharedTransportRenderCut(draft, members, usages);
}

function hasLocalRenderCutWitness(
  draft: DraftEffect,
  members: readonly StateCandidate[],
  ownerJsx: number,
): boolean {
  const localCuts = localRenderCuts(draft, members, ownerJsx);
  if (!localCuts || !draft.owner.body) {
    return false;
  }
  const returned = draft.context.proofs.uniqueReturnedExpression(draft.owner);
  return (
    returned !== null &&
    draft.context.proofs.hasIndependentRenderCutWitness({
      excluded: localCuts,
      localComponents: draft.context.localComponents,
      returned,
      sourceComponents: draft.context.sourceComponents,
    })
  );
}

function localRenderCuts(
  draft: DraftEffect,
  members: readonly StateCandidate[],
  ownerJsx: number,
): JsxSubtreeNode[] | null {
  const cuts: JsxSubtreeNode[] = [];
  for (const member of members) {
    const cut = memberRenderCut(member, draft, ownerJsx);
    if (!cut) {
      return null;
    }
    cuts.push(cut);
  }
  return cuts;
}

function memberRenderCut(
  member: StateCandidate,
  draft: DraftEffect,
  ownerJsx: number,
): JsxSubtreeNode | null {
  const usage = draft.context.usageByState.get(member);
  if (!usage || !memberRenderReadsAreDirect(usage, member, draft.owner)) {
    return null;
  }
  const cut = lowestCommonJsxSubtree(usage.directRenderNodes, draft.owner);
  return cut && jsxElementCountIn(cut) / ownerJsx <= MAX_CUT_SHARE ? cut : null;
}

function memberRenderReadsAreDirect(
  usage: StateUsage,
  member: StateCandidate,
  owner: RuntimeFunctionLike,
): boolean {
  const directSetterRead = hasDirectJsxEventSetter(member) ? 1 : 0;
  return (
    usage.transportedOccurrences === 0 &&
    usage.directRenderNodes.length > 0 &&
    usage.localRenderReads === usage.directRenderNodes.length + directSetterRead &&
    usage.directRenderNodes.every(
      (node) =>
        nearestNestedFunction(node, owner) === null && isSafeJsxProjectionReference(node, owner),
    )
  );
}

function hasSharedTransportRenderCut(
  draft: DraftEffect,
  members: readonly StateCandidate[],
  usages: readonly (StateUsage | undefined)[],
): boolean {
  if (usages.some((usage) => !usage || usage.localRenderReads > 0)) {
    return false;
  }
  const sites = usages.map((usage) => usage?.valueTransportSites);
  const [first] = sites;
  const site = first?.size === 1 ? [...first][0] : undefined;
  if (
    site === undefined ||
    !sites.every((value) => value !== undefined && value.size === 1 && [...value][0] === site)
  ) {
    return false;
  }
  const usage = draft.context.usageByState.get(members[0]!);
  const callSite = usage
    ? draft.context.proofs.directUniqueReturnCallSite(usage, draft.owner)
    : null;
  return callSite !== null && hasIndependentSiblingSubtree(callSite);
}

function hasIndependentSiblingSubtree(callSite: DirectReturnCallSite): boolean {
  const target = callSite.opening;
  const targetSubtree: ts.Node = ts.isJsxOpeningElement(target) ? target.parent : target;
  let independent = false;
  visitSkippingNestedRuntimeFunctions(callSite.returned, (node) => {
    if (
      independent ||
      (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) ||
      node === target
    ) {
      return;
    }
    const subtree: ts.Node = ts.isJsxOpeningElement(node) ? node.parent : node;
    independent = !nodeWithin(subtree, targetSubtree) && !nodeWithin(targetSubtree, subtree);
  });
  return independent;
}

function draftValueTransportsAreBounded(
  usage: StateUsage,
  owner: RuntimeFunctionLike,
  ownerJsx: number,
): boolean {
  const { body } = owner;
  if (!body) {
    return false;
  }
  for (const site of usage.valueTransportSites) {
    let target: JsxSubtreeNode | null = null;
    visitSkippingNestedRuntimeFunctions(body, (node) => {
      if (
        target ||
        (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) ||
        node.getStart() !== site
      ) {
        return;
      }
      target = ts.isJsxOpeningElement(node) ? node.parent : node;
    });
    if (!target || jsxElementCountIn(target) / ownerJsx > MAX_CUT_SHARE) {
      return false;
    }
  }
  return true;
}
