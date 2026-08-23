import ts from "typescript";

import {
  isDeclarationName,
  isNonValueIdentifier,
  isPureExpression,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import {
  findAncestor,
  findAncestorUntil,
  isRuntimeFunctionLike,
  nearestNestedFunction,
  type RuntimeFunctionLike,
  visit,
} from "../ast.js";
import type { StateCandidate, StateUsage } from "../analyze-source.js";
import { isSafeProjectionExpression } from "./deferred-reveal.js";
import { mutationRegionOnlyCallsStateSetters } from "./effect-drafts.js";
import {
  hasIndependentRenderCutWitness,
  isHookDependencyReference,
  isSafeJsxProjectionReference,
  jsxElementCount,
  jsxElementCountIn,
  nearestRepeatedRenderCall,
  oneHopRenderProjectionReferences,
  sourceHasRuntimeBinding,
} from "./state-proofs.js";

interface EventScalarLeafOptions {
  eventCallbacks: ReadonlySet<RuntimeFunctionLike>;
  hasCompanionWrites: boolean;
  hasReactiveMutationPath: boolean;
  hasSafeCommands: boolean;
  localComponents: ReadonlySet<string>;
  pureProjectionImports: ReadonlySet<string>;
  sourceComponents: ReadonlySet<string>;
  useCallbackNames: ReadonlySet<string>;
}

/**
 * Proves that one event-owned numeric measurement can bypass a broad owner
 * and publish only to a small set of independent render leaves. Callback
 * timing is supplied by the cross-file child contract resolver.
 */
export function isSourceEventScalarLeafState(
  state: StateCandidate,
  usage: StateUsage,
  options: EventScalarLeafOptions
): boolean {
  const ownerElements = jsxElementCount(state.owner);
  if (
    !state.setterName ||
    !hasNumericInitializer(state) ||
    ownerElements < 12 ||
    usage.localRenderReads === 0 ||
    usage.localRenderReads !== usage.directRenderNodes.length ||
    usage.effectReads !== 0 ||
    usage.effectWrites !== 0 ||
    usage.deferredReads !== 0 ||
    usage.transportedOccurrences !== 0 ||
    options.hasCompanionWrites ||
    options.hasReactiveMutationPath ||
    !options.hasSafeCommands ||
    usage.setterCallNodes.length !== 1 ||
    usage.setterCalls !== 1 ||
    usage.setterUsesPreviousValue ||
    usage.shadowed ||
    !stateValueReferencesAreRenderOnly(state, usage) ||
    !setterReferencesAreCallsOrCallbackDependencies(state, options.useCallbackNames)
  ) {
    return false;
  }

  const setterCall = usage.setterCallNodes[0]!;
  const argument = setterCall.arguments[0];
  const callback = nearestNestedFunction(setterCall, state.owner);
  if (
    setterCall.arguments.length !== 1 ||
    !argument ||
    !isPureExpression(argument) ||
    !callback ||
    !options.eventCallbacks.has(callback) ||
    !mutationRegionOnlyCallsStateSetters(callback, new Set([state.setterName]))
  ) {
    return false;
  }

  const mathCalls = sourceHasRuntimeBinding(state.owner.getSourceFile(), "Math")
    ? new Set<string>()
    : new Set(["Math.max", "Math.min"]);
  const projections = oneHopRenderProjectionReferences(
    state.owner,
    usage.directRenderNodes,
    (expression, reference) =>
      isSafeProjectionExpression(
        expression,
        reference,
        options.pureProjectionImports,
        mathCalls
      )
  );
  if (!projections || projections.length < 2) return false;

  const surfaces = new Map<number, ts.JsxElement | ts.JsxSelfClosingElement>();
  let returned: ts.Expression | null = null;
  for (const projection of projections) {
    if (
      nearestNestedFunction(projection, state.owner) ||
      nearestRepeatedRenderCall(projection, state.owner) ||
      !isSafeJsxProjectionReference(
        projection,
        state.owner,
        options.pureProjectionImports
      )
    ) {
      return false;
    }
    const attribute = findAncestorUntil(projection, ts.isJsxAttribute, state.owner);
    const opening = attribute?.parent.parent;
    if (
      !attribute ||
      !opening ||
      (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) ||
      /^(?:children|key|ref|render|on[A-Z])/.test(attribute.name.getText())
    ) {
      return false;
    }
    const surface = ts.isJsxOpeningElement(opening) ? opening.parent : opening;
    if (jsxElementCountIn(surface) > 6) return false;
    surfaces.set(surface.getStart(), surface);

    const returnExpression = directOwnerReturnExpression(projection, state.owner);
    if (!returnExpression || (returned !== null && returned !== returnExpression)) return false;
    returned = returnExpression;
  }

  const leaves = [...surfaces.values()];
  const leafElements = leaves.reduce((sum, surface) => sum + jsxElementCountIn(surface), 0);
  return leaves.length >= 2 &&
    leaves.length <= 6 &&
    leafElements / ownerElements <= 0.4 &&
    returned !== null &&
    hasIndependentRenderCutWitness(
      returned,
      leaves,
      options.localComponents,
      options.sourceComponents
    );
}

function hasNumericInitializer(state: StateCandidate): boolean {
  const initializer = state.call.arguments[0];
  if (!initializer) return false;
  const value = unwrapTransparentExpression(initializer);
  if (ts.isNumericLiteral(value)) return true;
  return ts.isPrefixUnaryExpression(value) &&
    (value.operator === ts.SyntaxKind.PlusToken || value.operator === ts.SyntaxKind.MinusToken) &&
    ts.isNumericLiteral(unwrapTransparentExpression(value.operand));
}

function stateValueReferencesAreRenderOnly(
  state: StateCandidate,
  usage: StateUsage
): boolean {
  const renderReads = new Set(usage.directRenderNodes);
  let safe = true;
  visit(state.owner.body, node => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== state.valueName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (!renderReads.has(node)) safe = false;
  });
  return safe;
}

function setterReferencesAreCallsOrCallbackDependencies(
  state: StateCandidate,
  useCallbackNames: ReadonlySet<string>
): boolean {
  let safe = true;
  visit(state.owner.body, node => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== state.setterName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) return;
    if (isHookDependencyReference(node, useCallbackNames)) return;
    safe = false;
  });
  return safe;
}

function directOwnerReturnExpression(
  node: ts.Node,
  owner: RuntimeFunctionLike
): ts.Expression | null {
  const statement = findAncestorUntil(node, ts.isReturnStatement, owner);
  return statement?.expression && findAncestor(statement, isRuntimeFunctionLike) === owner
    ? statement.expression
    : null;
}
