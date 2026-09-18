import { bindingDeclarationCount, isNonValueIdentifier } from "../../core/analysis-ast.js";
import type { ObservableReadScan } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { hasPlainOwnerParameters } from "./owner-parameter-work.js";
import { identifiersNamed } from "../../core/ast.js";
import ts from "typescript";

/** A caller-owned fresh data object must not escape into code that can install an accessor. */
export function propBindingDoesNotEscape(
  name: string,
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): boolean {
  return identifiersNamed(owner.body, name).every((reference) => {
    if (isNonValueIdentifier(reference)) {
      return true;
    }
    const { parent } = reference;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === reference) {
      return !ts.isCallExpression(parent.parent) || parent.parent.expression !== parent;
    }
    return unusedForwardedProp(reference, owner, scan);
  });
}

function unusedForwardedProp(
  reference: ts.Identifier,
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): boolean {
  const expression = reference.parent;
  if (
    !ts.isJsxExpression(expression) ||
    expression.expression !== reference ||
    !ts.isJsxAttribute(expression.parent)
  ) {
    return false;
  }
  const attribute = expression.parent;
  const opening = attribute.parent.parent;
  if (
    (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) ||
    !ts.isIdentifier(attribute.name) ||
    !ts.isIdentifier(opening.tagName) ||
    bindingDeclarationCount(owner, opening.tagName.text) !== 0
  ) {
    return false;
  }
  const child = scan.childContracts?.resolveComponent(opening.tagName.getText());
  return (
    child !== null && child !== undefined && unusedChildBinding(child.owner, attribute.name.text)
  );
}

function unusedChildBinding(owner: RuntimeFunctionLike, name: string): boolean {
  const [parameter] = owner.parameters;
  if (
    !parameter ||
    !ts.isObjectBindingPattern(parameter.name) ||
    !hasPlainOwnerParameters(owner) ||
    parameter.name.elements.some(
      (element) =>
        element.dotDotDotToken || (element.propertyName && !ts.isIdentifier(element.propertyName)),
    )
  ) {
    return false;
  }
  const bindings = parameter.name.elements.filter(
    (element) =>
      !element.dotDotDotToken &&
      (element.propertyName?.getText() ?? element.name.getText()) === name,
  );
  const [binding] = bindings;
  return (
    bindings.length === 1 &&
    binding !== undefined &&
    ts.isIdentifier(binding.name) &&
    identifiersNamed(owner.body, binding.name.text).length === 0 &&
    identifiersNamed(owner.body, "arguments").length === 0
  );
}
