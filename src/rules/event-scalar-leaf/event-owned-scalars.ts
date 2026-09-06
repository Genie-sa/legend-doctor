import type { StateCandidate, StateUsage } from "../../analysis/model.js";
import {
  isDeclarationName,
  isNonValueIdentifier,
  isPureExpression,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { nearestNestedFunction, visit } from "../../core/ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isHookDependencyReference } from "../state-proofs/callback-sites.js";
import { jsxElementCount } from "../state-proofs/jsx-subtrees.js";
import { mutationRegionOnlyCallsStateSetters } from "../effect-drafts/draft-mutations.js";
import ts from "typescript";

export interface EventOwnedScalarOptions {
  eventCallbacks: ReadonlySet<RuntimeFunctionLike>;
  hasCompanionWrites: boolean;
  hasReactiveMutationPath: boolean;
  hasSafeCommands: boolean;
  useCallbackNames: ReadonlySet<string>;
}

const MIN_OWNER_ELEMENTS = 12;

export function isEventOwnedNumericState(
  state: StateCandidate,
  usage: StateUsage,
  options: EventOwnedScalarOptions,
): boolean {
  if (
    !hasNumericInitializer(state) ||
    usage.setterCallNodes.length !== 1 ||
    usage.setterCalls !== 1 ||
    !isEventOwnedScalarBase(state, usage, options)
  ) {
    return false;
  }

  const setterCall = usage.setterCallNodes[0]!;
  const [argument] = setterCall.arguments;
  const callback = nearestNestedFunction(setterCall, state.owner);
  const setterName = state.setterName!;
  return (
    setterCall.arguments.length === 1 &&
    argument !== undefined &&
    isPureExpression(argument) &&
    callback !== null &&
    options.eventCallbacks.has(callback) &&
    mutationRegionOnlyCallsStateSetters(callback, new Set([setterName]))
  );
}

export function isEventOwnedLiteralBooleanState(
  state: StateCandidate,
  usage: StateUsage,
  options: EventOwnedScalarOptions,
): boolean {
  return (
    state.call.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword &&
    usage.setterCallNodes.length > 0 &&
    usage.setterCalls === usage.setterCallNodes.length &&
    isEventOwnedScalarBase(state, usage, options) &&
    usage.setterCallNodes.every((call) => {
      const [argument] = call.arguments;
      const callback = nearestNestedFunction(call, state.owner);
      return (
        call.arguments.length === 1 &&
        argument !== undefined &&
        (argument.kind === ts.SyntaxKind.TrueKeyword ||
          argument.kind === ts.SyntaxKind.FalseKeyword) &&
        callback !== null &&
        options.eventCallbacks.has(callback) &&
        mutationRegionOnlyCallsStateSetters(callback, new Set([state.setterName!]))
      );
    })
  );
}

function isEventOwnedScalarBase(
  state: StateCandidate,
  usage: StateUsage,
  options: EventOwnedScalarOptions,
): boolean {
  return (
    state.setterName !== null &&
    jsxElementCount(state.owner) >= MIN_OWNER_ELEMENTS &&
    usage.localRenderReads > 0 &&
    usage.localRenderReads === usage.directRenderNodes.length &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.deferredReads === 0 &&
    usage.transportedOccurrences === 0 &&
    !options.hasCompanionWrites &&
    !options.hasReactiveMutationPath &&
    options.hasSafeCommands &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    stateValueReferencesAreRenderOnly(state, usage) &&
    setterReferencesAreCallsOrCallbackDependencies(state, options.useCallbackNames)
  );
}

function hasNumericInitializer(state: StateCandidate): boolean {
  const [initializer] = state.call.arguments;
  if (!initializer) {
    return false;
  }
  const value = unwrapTransparentExpression(initializer);
  if (ts.isNumericLiteral(value)) {
    return true;
  }
  return (
    ts.isPrefixUnaryExpression(value) &&
    (value.operator === ts.SyntaxKind.PlusToken || value.operator === ts.SyntaxKind.MinusToken) &&
    ts.isNumericLiteral(unwrapTransparentExpression(value.operand))
  );
}

function stateValueReferencesAreRenderOnly(state: StateCandidate, usage: StateUsage): boolean {
  const renderReads = new Set(usage.directRenderNodes);
  let safe = true;
  visit(state.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== state.valueName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (!renderReads.has(node)) {
      safe = false;
    }
  });
  return safe;
}

function setterReferencesAreCallsOrCallbackDependencies(
  state: StateCandidate,
  useCallbackNames: ReadonlySet<string>,
): boolean {
  let safe = true;
  visit(state.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== state.setterName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
      return;
    }
    if (isHookDependencyReference(node, useCallbackNames)) {
      return;
    }
    safe = false;
  });
  return safe;
}
