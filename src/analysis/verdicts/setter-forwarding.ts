import type { StateCandidate, StateUsage } from "../model.js";
import type { ChildContractResolver } from "../../rules/child-contract/model.js";
import { isDirectJsxAttributeExpression } from "../../core/analysis-ast.js";
import { jsxTargetName } from "../ast-helpers.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

export interface ForwardedSetterProp {
  readonly propName: string;
  readonly target: string;
}

/**
 * Resolves the one callback prop through which the owner hands its setter to the same child that
 * receives the value. The child must call that prop only after render, so a leaf wrapper can forward
 * `next => value$.set(next)` without changing when the write happens.
 */
export function forwardedSetterProp(
  state: StateCandidate,
  usage: StateUsage,
  childContracts: ChildContractResolver,
): ForwardedSetterProp | null {
  const [target] = [...usage.setterTargets];
  if (
    target === undefined ||
    usage.setterTargets.size !== 1 ||
    !usage.valueTargets.has(target) ||
    usage.setterReferences !== usage.setterCalls + 1 ||
    ![...usage.setterTransportSites].every((site) => usage.valueTransportSites.has(site))
  ) {
    return null;
  }
  const attribute = soleSetterAttribute(state);
  if (!attribute || jsxTargetName(attribute) !== target) {
    return null;
  }
  const propName = attribute.name.getText();
  return childContracts.componentCallbackPropIsDeferred(target, propName)
    ? { propName, target }
    : null;
}

function soleSetterAttribute(state: StateCandidate): ts.JsxAttribute | null {
  const attributes: ts.JsxAttribute[] = [];
  visit(state.owner.body, (node) => {
    if (
      ts.isJsxAttribute(node) &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === state.setterName &&
      isDirectJsxAttributeExpression(node, node.initializer.expression)
    ) {
      attributes.push(node);
    }
  });
  const [attribute] = attributes;
  return attributes.length === 1 && attribute ? attribute : null;
}
