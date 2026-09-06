import { containsCallExpression, isControlledInteractionProp } from "../core/analysis-ast.js";
import type { StateCandidate } from "./model.js";
import { groupSettableStatesByOwner } from "./companion-writes.js";
import { hasStateInitializer } from "../rules/deferred-reveal/deferred-reveal.js";
import { isDirectPrimitiveExpression } from "../rules/state-proofs/state-proofs.js";
import { isVisibilityTransitionAttribute } from "./membership-toggle.js";
import { soleStatementExpression } from "./ast-helpers.js";
import ts from "typescript";
import { uniqueReturnedExpression } from "./return-call-sites.js";
import { visitSkippingNestedRuntimeFunctions } from "../core/ast.js";

export interface IndependentStateWrites {
  readonly directEventWrites: ReadonlySet<StateCandidate>;
  readonly visibilitySetterTransports: ReadonlySet<StateCandidate>;
}

export function findIndependentStateWrites(
  states: readonly StateCandidate[],
): IndependentStateWrites {
  const directEventWrites = new Set<StateCandidate>();
  const visibilitySetterTransports = new Set<StateCandidate>();
  for (const [owner, ownerStates] of groupSettableStatesByOwner(states)) {
    const bySetter = new Map(
      ownerStates.flatMap((state) =>
        state.setterName ? [[state.setterName, state] as const] : [],
      ),
    );
    const returned = owner.body ? uniqueReturnedExpression(owner) : null;
    if (!returned) {
      continue;
    }
    visitSkippingNestedRuntimeFunctions(returned, (node) => {
      if (!ts.isJsxAttribute(node)) {
        return;
      }
      const transported = visibilitySetterTransport(node, bySetter);
      if (transported) {
        visibilitySetterTransports.add(transported);
        return;
      }
      const written = directEventWriteTarget(node, bySetter);
      if (written) {
        directEventWrites.add(written);
      }
    });
  }
  return { directEventWrites, visibilitySetterTransports };
}

function jsxAttributeExpression(attribute: ts.JsxAttribute): ts.Expression | null {
  if (!attribute.initializer || !ts.isJsxExpression(attribute.initializer)) {
    return null;
  }
  return attribute.initializer.expression ?? null;
}

function visibilitySetterTransport(
  attribute: ts.JsxAttribute,
  bySetter: ReadonlyMap<string, StateCandidate>,
): StateCandidate | null {
  const expression = jsxAttributeExpression(attribute);
  if (!expression || !ts.isIdentifier(expression)) {
    return null;
  }
  const state = bySetter.get(expression.text);
  const opening = attribute.parent.parent;
  if (
    !state ||
    !hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) ||
    (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) ||
    !isVisibilityTransitionAttribute(opening, attribute.name.getText(), state.valueName)
  ) {
    return null;
  }
  return state;
}

function directEventWriteTarget(
  attribute: ts.JsxAttribute,
  bySetter: ReadonlyMap<string, StateCandidate>,
): StateCandidate | null {
  const expression = jsxAttributeExpression(attribute);
  const propName = attribute.name.getText();
  if (
    !expression ||
    ts.isIdentifier(expression) ||
    !/^on[A-Z]/u.test(propName) ||
    (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression))
  ) {
    return null;
  }
  const call = soleStatementExpression(expression.body);
  if (!call || !isSoleLiteralSetterCall(call, isControlledInteractionProp(propName))) {
    return null;
  }
  return ts.isCallExpression(call) && ts.isIdentifier(call.expression)
    ? (bySetter.get(call.expression.text) ?? null)
    : null;
}

function isSoleLiteralSetterCall(call: ts.Expression, controlledInteraction: boolean): boolean {
  if (
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    call.arguments.length !== 1
  ) {
    return false;
  }
  return (
    isDirectPrimitiveExpression(call.arguments[0]!) ||
    (controlledInteraction && !call.arguments.some((argument) => containsCallExpression(argument)))
  );
}
