import type { DraftEffect, EffectDraftProofs, SetterMutation } from "./model.js";
import type { EffectCandidate, StateCandidate, StateUsage } from "../../analysis/model.js";
import {
  expressionDependsOnBinding,
  localFunctionBinding,
  uniqueVariableDeclaration,
} from "../state-proofs/binding-lookup.js";
import {
  findAncestorUntil,
  nodeWithin,
  visit,
  visitSkippingNestedFunctions,
} from "../../core/ast.js";
import { isDeclarationName, isDirectJsxAttributeExpression } from "../../core/analysis-ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { callbackIsEventRooted } from "../state-proofs/event-roots.js";
import ts from "typescript";

interface DraftEditProof {
  readonly independent: boolean;
  readonly reachable: boolean;
}

export function draftEditProof(
  state: StateCandidate,
  draft: DraftEffect,
  ownerSetters: ReadonlySet<string>,
): DraftEditProof {
  const usage = draft.context.usageByState.get(state);
  if (!usage) {
    return { independent: false, reachable: false };
  }
  const direct = hasDirectJsxEventSetter(state);
  const edits = usage.setterCallNodes.filter((call) => !nodeWithin(call, draft.effect.call));
  const reachable = edits.filter((call) =>
    isEventRootedEditRegion(call, state, draft.context.proofs),
  );
  const independent =
    direct || reachable.some((call) => isIndependentEdit(call, state, { draft, ownerSetters }));
  return { independent, reachable: direct || reachable.length > 0 };
}

function isEventRootedEditRegion(
  call: ts.CallExpression,
  state: StateCandidate,
  proofs: EffectDraftProofs,
): boolean {
  const region = proofs.nearestMutationFunction(call, state.owner);
  return (
    region !== state.owner &&
    (ts.isArrowFunction(region) ||
      ts.isFunctionDeclaration(region) ||
      ts.isFunctionExpression(region)) &&
    callbackIsEventRooted({
      callback: region,
      owner: state.owner,
      dependencyName: "",
      seen: new Set(),
    })
  );
}

function isIndependentEdit(
  call: ts.CallExpression,
  state: StateCandidate,
  scope: { draft: DraftEffect; ownerSetters: ReadonlySet<string> },
): boolean {
  const region = scope.draft.context.proofs.nearestMutationFunction(call, state.owner);
  return (
    (mutationRegionOnlyCallsStateSetters(region, scope.ownerSetters) ||
      mutationRegionForwardsDraftValue(region, call, {
        owner: state.owner,
        stateSetters: scope.ownerSetters,
      })) &&
    setterArgumentDiffersFromEffect(call, state, scope.draft.effect)
  );
}

export function stateIsWrittenOnlyByEffect(
  usage: StateUsage,
  target: EffectCandidate,
  effects: readonly EffectCandidate[],
): boolean {
  const effectWrites = usage.setterCallNodes.filter((call) =>
    effects.some((effect) => nodeWithin(call, effect.call)),
  );
  return effectWrites.length > 0 && effectWrites.every((call) => nodeWithin(call, target.call));
}

function setterArgumentDiffersFromEffect(
  edit: ts.CallExpression,
  state: StateCandidate,
  effect: EffectCandidate,
): boolean {
  const [argument] = edit.arguments;
  if (!argument || !state.setterName) {
    return false;
  }
  if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
    return true;
  }
  const effectArguments: string[] = [];
  visitSkippingNestedFunctions(effect.callback!.body, effect.callback!, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === state.setterName &&
      node.arguments[0]
    ) {
      effectArguments.push(node.arguments[0].getText());
    }
  });
  return effectArguments.every((effectArgument) => effectArgument !== argument.getText());
}

export function hasDirectJsxEventSetter(state: StateCandidate): boolean {
  if (!state.setterName) {
    return false;
  }
  let found = false;
  visit(state.owner.body, (node) => {
    if (
      found ||
      !ts.isIdentifier(node) ||
      node.text !== state.setterName ||
      isDeclarationName(node)
    ) {
      return;
    }
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, state.owner);
    if (
      attribute &&
      /^(?:onChange|onChangeText|onSelect|onValueChange|onCheckedChange)$/u.test(
        attribute.name.getText(),
      ) &&
      isDirectJsxAttributeExpression(attribute, node)
    ) {
      found = true;
    }
  });
  return found;
}

export function mutationRegionOnlyCallsStateSetters(
  region: RuntimeFunctionLike,
  stateSetters: ReadonlySet<string>,
): boolean {
  if (!region.body) {
    return false;
  }
  let sawSetter = false;
  let unsafeCall = false;
  visitSkippingNestedFunctions(region.body, region, (node) => {
    if (unsafeCall || !ts.isCallExpression(node)) {
      return;
    }
    if (ts.isIdentifier(node.expression) && stateSetters.has(node.expression.text)) {
      sawSetter = true;
      return;
    }
    unsafeCall = true;
  });
  return sawSetter && !unsafeCall;
}

function mutationRegionForwardsDraftValue(
  region: RuntimeFunctionLike,
  edit: ts.CallExpression,
  scope: { owner: RuntimeFunctionLike; stateSetters: ReadonlySet<string> },
): boolean {
  const [argument] = edit.arguments;
  if (!region.body || !argument || !ts.isIdentifier(argument)) {
    return false;
  }
  const declaration = uniqueVariableDeclaration(region, argument.text);
  if (
    !declaration?.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    declaration.getStart() >= edit.getStart()
  ) {
    return false;
  }

  let forwardedCalls = 0;
  let safe = true;
  visitSkippingNestedFunctions(region.body, region, (node) => {
    if (
      !safe ||
      !ts.isCallExpression(node) ||
      (ts.isIdentifier(node.expression) && scope.stateSetters.has(node.expression.text))
    ) {
      return;
    }
    if (nodeWithin(node, declaration.initializer!)) {
      safe = !isLocalFunctionCall(node, scope.owner);
      return;
    }
    if (
      node.getStart() <= edit.getStart() ||
      !node.arguments.some((candidate) =>
        expressionDependsOnBinding(candidate, argument, region),
      ) ||
      isLocalFunctionCall(node, scope.owner)
    ) {
      safe = false;
      return;
    }
    forwardedCalls += 1;
  });
  return safe && forwardedCalls === 1;
}

function isLocalFunctionCall(call: ts.CallExpression, owner: RuntimeFunctionLike): boolean {
  return (
    ts.isIdentifier(call.expression) && localFunctionBinding(owner, call.expression.text) !== null
  );
}

export function hasExternalCompanionWrites(
  draft: DraftEffect,
  members: readonly StateCandidate[],
): boolean {
  const memberSet = new Set(members);
  const stateBySetter = new Map(
    draft.context.states.flatMap((state) =>
      state.owner === draft.owner && state.setterName ? [[state.setterName, state] as const] : [],
    ),
  );
  const mutations = collectSetterMutations(draft.owner, stateBySetter, draft.context.proofs);
  return mutations.some(
    (memberMutation) =>
      memberSet.has(memberMutation.state) &&
      mutations.some(
        (other) =>
          !memberSet.has(other.state) &&
          other.region === memberMutation.region &&
          draft.context.proofs.setterMutationsCanCooccur(
            other.call,
            memberMutation.call,
            memberMutation.region,
          ),
      ),
  );
}

function collectSetterMutations(
  owner: RuntimeFunctionLike,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
  proofs: EffectDraftProofs,
): SetterMutation[] {
  const mutations: SetterMutation[] = [];
  visit(owner.body, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) {
      return;
    }
    const state = stateBySetter.get(node.expression.text);
    if (state) {
      mutations.push({ call: node, region: proofs.nearestMutationFunction(node, owner), state });
    }
  });
  return mutations;
}
