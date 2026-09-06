import type { StateCandidate, StateUsage } from "../../analysis/model.js";
import {
  collectionMembershipSummaryCall,
  collectionSummaryControlsRepeatedRendering,
  isBoundedFilteredSelectionSummary,
} from "./collection-summaries.js";
import { findAncestorUntil, nearestNestedFunction, visit } from "../../core/ast.js";
import { isDeclarationName, isNonValueIdentifier } from "../../core/analysis-ast.js";
import {
  isHookDependencyReference,
  isSynchronousRenderCallback,
} from "../state-proofs/callback-sites.js";
import { jsxElementCount, nearestRepeatedRenderCall } from "../state-proofs/jsx-subtrees.js";
import {
  membershipControlsRepeatedMount,
  membershipUsesCallbackKey,
  renderedListCallback,
} from "./rendered-list-membership.js";
import type { ArraySetAlias } from "./model.js";
import { LIST_SIZED_OWNER_JSX_ELEMENTS } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isSetOrMapState } from "./state-value-shapes.js";
import { localSetAliasForArrayState } from "./array-set-aliases.js";
import { repeatedRenderHasStableItemKey } from "../state-proofs/unique-repeated-selection.js";
import ts from "typescript";

const KEYED_COLLECTION_PROPERTIES = new Set(["entries", "has", "keys", "size", "values"]);

const MEMO_CALLBACK_HOOKS = new Set(["useCallback", "useMemo"]);

export function isKeyedLeafCollectionState(
  state: StateCandidate,
  usage: StateUsage | undefined,
): boolean {
  if (!usage || usage.effectReads > 0) {
    return false;
  }
  const directCollection = isSetOrMapState(state.call);
  const arraySetAlias = directCollection ? null : localSetAliasForArrayState(state);
  if (
    (!directCollection && !arraySetAlias) ||
    jsxElementCount(state.owner) < LIST_SIZED_OWNER_JSX_ELEMENTS
  ) {
    return false;
  }
  return collectionReadsAreKeyedMembership({
    aliasName: arraySetAlias?.declaration.name.getText() ?? null,
    arraySetAlias,
    state,
  });
}

interface CollectionReadContext {
  aliasName: string | null;
  arraySetAlias: ArraySetAlias | null;
  state: StateCandidate;
}

type CollectionReadOutcome = "ignored" | "membership" | "unsafe";

function collectionReadsAreKeyedMembership(context: CollectionReadContext): boolean {
  let repeatedMembership = false;
  let unsafe = false;
  visit(context.state.owner.body, (node) => {
    if (unsafe || !isKeyedCollectionRead(node, context)) {
      return;
    }
    const outcome = classifyKeyedCollectionRead(node, context);
    if (outcome === "unsafe") {
      unsafe = true;
    } else if (outcome === "membership") {
      repeatedMembership = true;
    }
  });
  return repeatedMembership && !unsafe;
}

function isKeyedCollectionRead(
  node: ts.Node,
  context: CollectionReadContext,
): node is ts.Identifier {
  const { aliasName, arraySetAlias, state } = context;
  return (
    ts.isIdentifier(node) &&
    (node.text === state.valueName || node.text === aliasName) &&
    !isDeclarationName(node) &&
    !isNonValueIdentifier(node) &&
    !(arraySetAlias !== null && node === arraySetAlias.stateSource)
  );
}

function classifyKeyedCollectionRead(
  node: ts.Identifier,
  context: CollectionReadContext,
): CollectionReadOutcome {
  const { arraySetAlias, state } = context;
  const property =
    ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
      ? node.parent
      : null;
  if (arraySetAlias && node.text === state.valueName) {
    return classifyAliasedArrayRead(node, property, state.owner);
  }
  if (property && KEYED_COLLECTION_PROPERTIES.has(property.name.text)) {
    return classifyCollectionPropertyRead(property, state);
  }
  return classifyPlainCollectionRead(node, state.owner);
}

function classifyAliasedArrayRead(
  node: ts.Identifier,
  property: ts.PropertyAccessExpression | null,
  owner: RuntimeFunctionLike,
): CollectionReadOutcome {
  if (property?.name.text === "length") {
    return collectionSummaryControlsRepeatedRendering(property, owner) ? "unsafe" : "ignored";
  }
  return isDeferredCollectionRead(node, owner) ||
    isHookDependencyReference(node, MEMO_CALLBACK_HOOKS) ||
    isListExtraDataReference(node, owner)
    ? "ignored"
    : "unsafe";
}

function classifyCollectionPropertyRead(
  property: ts.PropertyAccessExpression,
  state: StateCandidate,
): CollectionReadOutcome {
  if (property.name.text === "size") {
    return collectionSummaryControlsRepeatedRendering(property, state.owner) ? "unsafe" : "ignored";
  }
  if (["entries", "keys", "values"].includes(property.name.text)) {
    return "ignored";
  }
  if (
    property.name.text !== "has" ||
    !ts.isCallExpression(property.parent) ||
    property.parent.expression !== property
  ) {
    return "unsafe";
  }
  return classifyMembershipCall(property.parent, state);
}

function classifyMembershipCall(
  membershipCall: ts.CallExpression,
  state: StateCandidate,
): CollectionReadOutcome {
  const summaryCall = collectionMembershipSummaryCall(membershipCall, state.owner);
  if (summaryCall) {
    return collectionSummaryControlsRepeatedRendering(summaryCall, state.owner)
      ? "unsafe"
      : "ignored";
  }
  if (isBoundedFilteredSelectionSummary(membershipCall, state)) {
    return "ignored";
  }
  if (
    !isRepeatedMembershipRender(membershipCall, state.owner) ||
    membershipControlsRepeatedMount(membershipCall, state.owner)
  ) {
    return "unsafe";
  }
  return "membership";
}

function classifyPlainCollectionRead(
  node: ts.Identifier,
  owner: RuntimeFunctionLike,
): CollectionReadOutcome {
  return ts.isSpreadElement(node.parent) ||
    (isCollectionCopyArgument(node) && isDeferredCollectionRead(node, owner)) ||
    isHookDependencyReference(node, MEMO_CALLBACK_HOOKS) ||
    isListExtraDataReference(node, owner)
    ? "ignored"
    : "unsafe";
}

function isDeferredCollectionRead(node: ts.Identifier, owner: RuntimeFunctionLike): boolean {
  const callback = nearestNestedFunction(node, owner);
  if (!callback || isSynchronousRenderCallback(callback) || renderedListCallback(node, owner)) {
    return false;
  }
  const attribute = findAncestorUntil(callback, ts.isJsxAttribute, owner);
  return !attribute || /^on[A-Z]/u.test(attribute.name.getText());
}

function isRepeatedMembershipRender(call: ts.CallExpression, owner: RuntimeFunctionLike): boolean {
  const repeated = nearestRepeatedRenderCall(call, owner);
  const callback = repeated?.arguments[0] ?? renderedListCallback(call, owner);
  return (
    callback !== null &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
    membershipUsesCallbackKey(call, callback) &&
    (!repeated || repeatedRenderHasStableItemKey(callback))
  );
}

function isListExtraDataReference(node: ts.Identifier, owner: RuntimeFunctionLike): boolean {
  const expression = node.parent;
  if (!ts.isJsxExpression(expression) || expression.expression !== node) {
    return false;
  }
  const attribute = expression.parent;
  return (
    ts.isJsxAttribute(attribute) &&
    attribute.name.getText() === "extraData" &&
    isInsideOwner(attribute, owner)
  );
}

function isInsideOwner(node: ts.Node, owner: RuntimeFunctionLike): boolean {
  return node.getStart() >= owner.getStart() && node.end <= owner.end;
}

function isCollectionCopyArgument(node: ts.Identifier): boolean {
  const { parent } = node;
  if (
    ts.isCallExpression(parent) &&
    parent.arguments.includes(node) &&
    ts.isPropertyAccessExpression(parent.expression) &&
    ts.isIdentifier(parent.expression.expression) &&
    parent.expression.expression.text === "Array" &&
    parent.expression.name.text === "from"
  ) {
    return true;
  }
  return (
    ts.isNewExpression(parent) &&
    parent.arguments?.includes(node) === true &&
    ts.isIdentifier(parent.expression) &&
    (parent.expression.text === "Set" || parent.expression.text === "Map")
  );
}
