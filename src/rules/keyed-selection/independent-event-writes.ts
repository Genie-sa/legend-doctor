import type { StateCandidate, StateUsage } from "../../analysis/model.js";
import {
  bindingDeclarationCount,
  callRootIdentifier,
  hookCallName,
} from "../../core/analysis-ast.js";
import { nearestNestedFunction, visit, visitSkippingNestedFunctions } from "../../core/ast.js";
import { callbackIsEventRooted } from "../state-proofs/event-roots.js";
import { mutationRegionOnlyCallsStateSetters } from "../effect-drafts/draft-mutations.js";
import { nearestRepeatedRenderCall } from "../state-proofs/jsx-subtrees.js";
import ts from "typescript";

export function hasIndependentCollectionEventWrite(
  state: StateCandidate,
  usage: StateUsage | undefined,
  ownerSetters: ReadonlySet<string>,
): boolean {
  if (!state.setterName || !usage) {
    return false;
  }
  return usage.setterCallNodes.some((call) => {
    const region = nearestNestedFunction(call, state.owner);
    if (
      !region ||
      (!ts.isArrowFunction(region) &&
        !ts.isFunctionDeclaration(region) &&
        !ts.isFunctionExpression(region)) ||
      !region.body ||
      !callbackIsEventRooted({
        callback: region,
        owner: state.owner,
        dependencyName: "",
        seen: new Set(),
      })
    ) {
      return false;
    }
    if (
      (ts.isArrowFunction(region) || ts.isFunctionExpression(region)) &&
      ts.isCallExpression(region.parent) &&
      region.parent.arguments.includes(region) &&
      hookCallName(region.parent) !== "useCallback"
    ) {
      return false;
    }

    return regionWritesOnlyOwnState(region, state, ownerSetters);
  });
}

function regionWritesOnlyOwnState(
  region: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  state: StateCandidate,
  ownerSetters: ReadonlySet<string>,
): boolean {
  if (!region.body) {
    return false;
  }
  let safe = true;
  visitSkippingNestedFunctions(region.body, region, (node) => {
    if (!safe || !ts.isCallExpression(node)) {
      return;
    }
    if (ts.isIdentifier(node.expression) && node.expression.text === state.setterName) {
      safe = !setterArgumentCallsOwnerCommand(node, state, ownerSetters);
      return;
    }
    const root = callRootIdentifier(node.expression);
    if (root && (ownerSetters.has(root) || bindingDeclarationCount(state.owner, root) > 0)) {
      safe = false;
    }
  });
  return safe;
}

function setterArgumentCallsOwnerCommand(
  setterCall: ts.CallExpression,
  state: StateCandidate,
  ownerSetters: ReadonlySet<string>,
): boolean {
  let found = false;
  const findOwnerCommand = (node: ts.Node): void => {
    if (
      found ||
      !ts.isCallExpression(node) ||
      !ts.isIdentifier(node.expression) ||
      node.expression.text === state.setterName
    ) {
      return;
    }
    if (
      ownerSetters.has(node.expression.text) ||
      bindingDeclarationCount(state.owner, node.expression.text) > 0
    ) {
      found = true;
    }
  };
  for (const argument of setterCall.arguments) {
    visit(argument, findOwnerCommand);
  }
  return found;
}

export function hasIndependentRepeatedEventWrite(
  state: StateCandidate,
  usage: StateUsage | undefined,
): boolean {
  if (!state.setterName || !usage) {
    return false;
  }
  return usage.setterCallNodes.some((call) => {
    const repeated = nearestRepeatedRenderCall(call, state.owner);
    const event = nearestNestedFunction(call, state.owner);
    if (
      !repeated ||
      !event ||
      event === repeated.arguments[0] ||
      (!ts.isArrowFunction(event) && !ts.isFunctionExpression(event))
    ) {
      return false;
    }
    const expression = event.parent;
    const attribute = ts.isJsxExpression(expression) ? expression.parent : null;
    return (
      attribute !== null &&
      ts.isJsxAttribute(attribute) &&
      /^on[A-Z]/u.test(attribute.name.getText()) &&
      mutationRegionOnlyCallsStateSetters(event, new Set([state.setterName!]))
    );
  });
}
