import type { ClassifiedState, SetterMutation, StateCandidate } from "./model.js";
import { executionUnit, functionEntryKey } from "../core/execution-units.js";
import { isRuntimeFunctionLike, nodeWithin, visit } from "../core/ast.js";
import { BROAD_OWNER_JSX_ELEMENTS } from "./constants.js";
import { EVENT_HANDLER_PROP } from "../rules/state-proofs/event-roots.js";
import type { RuntimeFunctionLike } from "../core/ast.js";
import type { SourceAnalysis } from "./proofs/contracts.js";
import type { StateClassificationInputs } from "./verdicts/classification-context.js";
import { classifyState } from "./verdicts/classify-state.js";
import { collectSetterMutations } from "./companion-writes.js";
import { fileReach } from "../project/source-components/synchronous-reach.js";
import { isSynchronousRenderCallback } from "../rules/state-proofs/callback-sites.js";
import { isVisibilityTransitionAttribute } from "./membership-toggle.js";
import { lexicalBinding } from "../core/lexical-bindings.js";
import { localReachResolver } from "../project/source-components/reach-resolvers.js";
import { programReach } from "../project/source-components/write-units.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../core/analysis-ast.js";

/**
 * A co-written state converted alone still saves its owner's render in an event that writes no
 * other state of the owner. React 19 commits its remaining stretches with their companions; React
 * 18 may commit the observable first when a library calls the event outside React's event system.
 */
export function classifyCowrittenState(
  inputs: StateClassificationInputs,
  analysis: SourceAnalysis,
): ClassifiedState {
  const classified = classifyState(inputs);
  if (
    classified.action !== "review-state" ||
    classified.abstentionReason !== "atomic-transition-unproven" ||
    !inputs.hasCompanionWrites ||
    analysis.syncLaneRendersAlone
  ) {
    return classified;
  }
  const alone = classifyState({
    ...inputs,
    hasCompanionWrites: false,
    hasNonClosingCompanionWrites: false,
  });
  return alone.action !== "review-state" &&
    alone.action !== "keep-state" &&
    hasMaterialLoneWriteStretch(inputs.state, analysis)
    ? alone
    : classified;
}

/**
 * The handler of a lone event prop sets more than the initial literal in a top-level statement,
 * or the owner hands the setter bare as an element's only callback, other than as a visibility
 * callback, which mostly closes the element: a reset. The owner keeps a broad owner's JSX mounted
 * around that element.
 */
function hasMaterialLoneWriteStretch(
  state: StateCandidate,
  { sourceFile, states }: SourceAnalysis,
): boolean {
  const ownerStates = states.filter((other) => other.owner === state.owner && other.setterName);
  const mutations = collectSetterMutations(state.owner, ownerStates);
  let companionStretches: ReadonlySet<string> | null = null;
  const writesAlone = (handler: RuntimeFunctionLike): boolean => {
    if (!companionStretches) {
      const reach = programReach([fileReach(sourceFile, localReachResolver)]);
      companionStretches = new Set(
        mutations
          .filter((mutation) => mutation.state !== state)
          .flatMap(({ call }) => reach.callingUnits(executionUnit(call)).map(({ key }) => key)),
      );
    }
    return !companionStretches.has(functionEntryKey(handler));
  };
  const isLoneEvent = (attribute: ts.JsxAttribute): boolean => {
    const value = attributeValue(attribute);
    const handler = handlerFunction(value);
    const name = attribute.name.getText();
    if (!EVENT_HANDLER_PROP.test(name)) {
      return false;
    }
    return handler
      ? mutations.some((mutation) => setsOnEveryEvent(mutation, state, handler)) &&
          writesAlone(handler)
      : handedSetter(value, state) &&
          !isVisibilityTransitionAttribute(attribute.parent.parent, name, state.valueName) &&
          attribute.parent.properties.every(
            (sibling) =>
              sibling === attribute ||
              (ts.isJsxAttribute(sibling) &&
                !handlerFunction(attributeValue(sibling)) &&
                !ownerStates.some((other) => handedSetter(attributeValue(sibling), other))),
          );
  };
  let lone = false;
  visit(state.owner.body, (node) => {
    lone ||= ts.isJsxAttribute(node) && isLoneEvent(node) && isMaterialMount(node, state.owner);
  });
  return lone;
}

/** Setting the initial literal back usually finds it already set, so React renders nothing. */
function setsOnEveryEvent(
  { call, state }: SetterMutation,
  converted: StateCandidate,
  handler: RuntimeFunctionLike,
): boolean {
  const [initial] = converted.call.arguments;
  const [next] = call.arguments;
  const resets =
    !initial || !next
      ? initial === next
      : (ts.isLiteralExpression(initial) || ts.isToken(initial)) &&
        initial.getText() === next.getText();
  return (
    state === converted &&
    !resets &&
    executionUnit(call).key === functionEntryKey(handler) &&
    (handler.body === call ||
      (ts.isExpressionStatement(call.parent) && call.parent.parent === handler.body))
  );
}

function attributeValue({ initializer }: ts.JsxAttribute): ts.Expression | null {
  return initializer && ts.isJsxExpression(initializer) && initializer.expression
    ? unwrapTransparentExpression(initializer.expression)
    : null;
}

function handlerFunction(value: ts.Expression | null): RuntimeFunctionLike | null {
  if (value && isRuntimeFunctionLike(value)) {
    return value;
  }
  const binding = value && ts.isIdentifier(value) ? lexicalBinding(value) : null;
  return binding?.kind === "function" ? binding.declaration : null;
}

function handedSetter(value: ts.Expression | null, state: StateCandidate): boolean {
  const binding = value && ts.isIdentifier(value) ? lexicalBinding(value) : null;
  return (
    value?.getText() === state.setterName &&
    binding?.kind === "value" &&
    binding.declaration === state.call.parent
  );
}

/** Counts the owner's JSX that stays mounted with the attribute's element, branches aside. */
function isMaterialMount(attribute: ts.JsxAttribute, owner: RuntimeFunctionLike): boolean {
  const root = returnedRoot(attribute, owner);
  let count = 0;
  const countMounted = (node: ts.Node): void => {
    const { parent } = node;
    const conditional =
      isRuntimeFunctionLike(node) ||
      (ts.isConditionalExpression(parent) && node !== parent.condition) ||
      (ts.isBinaryExpression(parent) && node === parent.right);
    if (nodeWithin(attribute, node) || !conditional) {
      count += ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) ? 1 : 0;
      ts.forEachChild(node, countMounted);
    }
  };
  if (root) {
    countMounted(root);
  }
  return count >= BROAD_OWNER_JSX_ELEMENTS;
}

/** The outermost expression the owner returns around the attribute, through render callbacks. */
function returnedRoot(attribute: ts.JsxAttribute, owner: RuntimeFunctionLike): ts.Node | null {
  let root: ts.Node | null = null;
  for (let node: ts.Node = attribute; node !== owner; node = node.parent) {
    if (isRuntimeFunctionLike(node) && !isSynchronousRenderCallback(node)) {
      return null;
    }
    if (
      ts.isReturnStatement(node.parent) ||
      (ts.isArrowFunction(node.parent) && !ts.isBlock(node))
    ) {
      root = node;
    }
  }
  return root;
}
