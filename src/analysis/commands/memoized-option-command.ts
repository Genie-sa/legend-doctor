import type { StateCandidate, StateUsage } from "../model.js";
import { findAncestorUntil, nearestNestedFunction, nodeWithin, visit } from "../../core/ast.js";
import {
  isDeclarationName,
  isDirectJsxAttributeExpression,
  isNonValueIdentifier,
} from "../../core/analysis-ast.js";
import {
  setterCallsAssignBooleanLiterals,
  stateHasNoEffectOrDeferredUse,
} from "../verdicts/transport-verdicts.js";
import type { ChildContractResolver } from "../../rules/child-contract/model.js";
import type { HookImports } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { hasStateInitializer } from "../../rules/deferred-reveal/deferred-reveal.js";
import { isImportedHookCall } from "../../core/imports.js";
import { isInsideJsxEventCallback } from "../../rules/state-proofs/event-roots.js";
import { isUniqueConstBindingOf } from "./effect-owned-presentation.js";
import { jsxOpeningForAttribute } from "../callbacks/local-callbacks.js";
import ts from "typescript";

interface SourceMemoScope {
  readonly childContracts: ChildContractResolver;
  readonly imports: HookImports;
}

function stateIsTransportedBooleanCommand(state: StateCandidate, usage: StateUsage): boolean {
  return (
    hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) &&
    usage.localRenderReads === 0 &&
    stateHasNoEffectOrDeferredUse(usage) &&
    usage.valueTransportSites.size === 1 &&
    usage.valueTargets.size === 1 &&
    usage.setterCallNodes.length > 0 &&
    usage.setterReferences === usage.setterCalls &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped &&
    setterCallsAssignBooleanLiterals(usage)
  );
}

export function isSourceProvenMemoizedOptionCommand(
  state: StateCandidate,
  usage: StateUsage,
  { childContracts, imports }: SourceMemoScope,
): boolean {
  if (!state.owner.body || !stateIsTransportedBooleanCommand(state, usage)) {
    return false;
  }

  const option = sharedMemoizedOptionCallback(state, usage, imports);
  const declaration = option
    ? findAncestorUntil(option.memoCall, ts.isVariableDeclaration, state.owner)
    : null;
  if (
    !option ||
    !declaration ||
    !isUniqueConstBindingOf(declaration, option.memoCall, state.owner)
  ) {
    return false;
  }
  const transport = soleMemoTransportSite(state.owner, declaration.name.getText(), declaration);
  return (
    transport !== null &&
    childContracts.componentArrayItemCallbackIsDeferred(
      transport.target,
      transport.prop,
      option.callbackProp,
    )
  );
}

interface MemoizedOptionCallback {
  readonly callbackProp: string;
  readonly memoCall: ts.CallExpression;
}

function memoizedOptionCallbackFor(
  setter: ts.CallExpression,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): MemoizedOptionCallback | null {
  const containingMemo = findAncestorUntil(
    setter,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      isImportedHookCall({
        call: node,
        localNames: imports.useMemo,
        namespaceNames: imports.reactNamespaces,
        canonicalName: "useMemo",
      }),
    owner,
  );
  const factory = containingMemo?.arguments[0];
  const property = factory ? findAncestorUntil(setter, ts.isPropertyAssignment, factory) : null;
  const propertyName = property ? staticPropertyName(property.name) : null;
  const callback = property ? nearestNestedFunction(setter, owner) : null;
  if (
    !containingMemo ||
    !factory ||
    (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) ||
    !property ||
    !propertyName ||
    !callback ||
    callback === factory ||
    !nodeWithin(callback, property)
  ) {
    return null;
  }
  return { callbackProp: propertyName, memoCall: containingMemo };
}

function sharedMemoizedOptionCallback(
  state: StateCandidate,
  usage: StateUsage,
  imports: HookImports,
): MemoizedOptionCallback | null {
  const deferredSetters = usage.setterCallNodes.filter(
    (call) => !isInsideJsxEventCallback(call, state.owner),
  );
  if (deferredSetters.length === 0) {
    return null;
  }
  const options = deferredSetters.map((setter) =>
    memoizedOptionCallbackFor(setter, state.owner, imports),
  );
  const [first] = options;
  if (!first) {
    return null;
  }
  return options.every(
    (option) =>
      option !== null &&
      option.memoCall === first.memoCall &&
      option.callbackProp === first.callbackProp,
  )
    ? first
    : null;
}

interface MemoTransportSite {
  readonly prop: string;
  readonly target: string;
}

function soleMemoTransportSite(
  owner: RuntimeFunctionLike,
  memoBinding: string,
  declaration: ts.VariableDeclaration,
): MemoTransportSite | null {
  const sites: MemoTransportSite[] = [];
  let safe = true;
  visit(owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== memoBinding ||
      node === declaration.name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node) ||
      isLengthAccess(node)
    ) {
      return;
    }
    const site = jsxTransportSiteFor(node, owner);
    if (!site || sites.length > 0) {
      safe = false;
      return;
    }
    sites.push(site);
  });
  return safe && sites.length === 1 ? (sites[0] ?? null) : null;
}

function isLengthAccess(node: ts.Identifier): boolean {
  return (
    ts.isPropertyAccessExpression(node.parent) &&
    node.parent.expression === node &&
    node.parent.name.text === "length"
  );
}

function jsxTransportSiteFor(
  node: ts.Identifier,
  owner: RuntimeFunctionLike,
): MemoTransportSite | null {
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
  if (!attribute || !isDirectJsxAttributeExpression(attribute, node)) {
    return null;
  }
  const target = jsxOpeningForAttribute(attribute)?.tagName.getText() ?? null;
  return target ? { prop: attribute.name.getText(), target } : null;
}

export function staticPropertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : null;
}
