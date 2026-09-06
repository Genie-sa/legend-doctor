import type { ChildComponentSource, TrackedCallbackPath } from "./model.js";
import {
  bindingDeclarationCount,
  isAssignmentOperator,
  isNonValueIdentifier,
} from "../../core/analysis-ast.js";
import { isRuntimeFunctionLike, visit } from "../../core/ast.js";
import ts from "typescript";

function bindingElementNamed(
  elements: ts.NodeArray<ts.BindingElement>,
  property: string,
): ts.Identifier | null {
  for (const element of elements) {
    if (
      !element.dotDotDotToken &&
      ts.isIdentifier(element.name) &&
      bindingElementPropertyName(element) === property
    ) {
      return element.name;
    }
  }
  return null;
}

function restBindingElement(elements: ts.NodeArray<ts.BindingElement>): ts.Identifier | null {
  for (const element of elements) {
    if (element.dotDotDotToken && ts.isIdentifier(element.name)) {
      return element.name;
    }
  }
  return null;
}

function bindObjectPatternPath(
  binding: ts.ObjectBindingPattern,
  path: readonly string[],
): TrackedCallbackPath | null {
  const [head, ...tail] = path;
  if (!head) {
    return null;
  }
  const matched = bindingElementNamed(binding.elements, head);
  if (matched) {
    return { name: matched.text, path: tail };
  }
  const rest = restBindingElement(binding.elements);
  return rest ? { name: rest.text, path } : null;
}

export function bindCallbackPath(
  binding: ts.BindingName,
  path: readonly string[],
): TrackedCallbackPath | null {
  if (ts.isIdentifier(binding)) {
    return { name: binding.text, path };
  }
  return ts.isObjectBindingPattern(binding) ? bindObjectPatternPath(binding, path) : null;
}

export function bindingElementPropertyName(element: ts.BindingElement): string | null {
  if (element.propertyName) {
    return propertyName(element.propertyName);
  }
  return ts.isIdentifier(element.name) ? element.name.text : null;
}

export function isModuleBindingReference(node: ts.Identifier): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) {
      return true;
    }
    if (ts.isSourceFile(current) || isRuntimeFunctionLike(current)) {
      return false;
    }
  }
  return false;
}

export function objectBindingOmitsProperty(binding: ts.BindingName, property: string): boolean {
  return (
    ts.isObjectBindingPattern(binding) &&
    !binding.elements.some(
      (element) => element.dotDotDotToken || bindingElementPropertyName(element) === property,
    )
  );
}

export function propertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : null;
}

function destructuredSourceName(element: ts.BindingElement): string | null {
  if (element.propertyName && ts.isIdentifier(element.propertyName)) {
    return element.propertyName.text;
  }
  return ts.isIdentifier(element.name) ? element.name.text : null;
}

function directPropBinding(
  pattern: ts.ObjectBindingPattern,
  propName: string,
): ts.Identifier | null {
  for (const element of pattern.elements) {
    if (
      !element.dotDotDotToken &&
      ts.isIdentifier(element.name) &&
      destructuredSourceName(element) === propName
    ) {
      return element.name;
    }
  }
  return null;
}

function renamedPropBinding(
  pattern: ts.ObjectBindingPattern,
  propName: string,
): ts.Identifier | null {
  for (const element of pattern.elements) {
    if (
      !element.dotDotDotToken &&
      ts.isIdentifier(element.name) &&
      !element.initializer &&
      destructuredSourceName(element) === propName
    ) {
      return element.name;
    }
  }
  return null;
}

function restPropBinding(
  owner: ChildComponentSource["owner"],
  rest: ts.Identifier,
  propName: string,
): ts.Identifier | null {
  let bound: ts.Identifier | null = null;
  let safe = true;
  visit(owner.body, (node) => {
    if (!safe || !ts.isIdentifier(node) || node.text !== rest.text || isNonValueIdentifier(node)) {
      return;
    }
    const declaration = node.parent;
    if (
      !ts.isVariableDeclaration(declaration) ||
      declaration.initializer !== node ||
      !ts.isObjectBindingPattern(declaration.name)
    ) {
      safe = false;
      return;
    }
    bound ??= renamedPropBinding(declaration.name, propName);
  });
  return safe ? bound : null;
}

const REF_FORWARDING_PARAMETERS = 2;

export function propsParameter(
  owner: ChildComponentSource["owner"],
  allowRefParameter = false,
): ts.ParameterDeclaration | null {
  const [parameter, second] = owner.parameters;
  if (!parameter) {
    return null;
  }
  if (owner.parameters.length === 1) {
    return parameter;
  }
  const refOnly =
    allowRefParameter &&
    owner.parameters.length === REF_FORWARDING_PARAMETERS &&
    second !== undefined &&
    ts.isIdentifier(second.name) &&
    !second.dotDotDotToken;
  return refOnly ? parameter : null;
}

export function boundPropIdentifier(
  owner: ChildComponentSource["owner"],
  propName: string,
  allowRefParameter = false,
): ts.Identifier | null {
  const parameter = propsParameter(owner, allowRefParameter);
  if (!parameter || !ts.isObjectBindingPattern(parameter.name)) {
    return null;
  }
  const direct = directPropBinding(parameter.name, propName);
  if (direct) {
    return direct;
  }
  const rest = restBindingElement(parameter.name.elements);
  if (!rest || !owner.body || bindingDeclarationCount(owner, rest.text) !== 1) {
    return null;
  }
  return restPropBinding(owner, rest, propName);
}

export function isBindingName(node: ts.Identifier): boolean {
  const { parent } = node;
  return (
    ts.isBindingElement(parent) ||
    ts.isVariableDeclaration(parent) ||
    (ts.isParameter(parent) && parent.name === node)
  );
}

export function referenceIsWritten(node: ts.Identifier): boolean {
  const { parent } = node;
  return (
    (ts.isBinaryExpression(parent) &&
      parent.left === node &&
      isAssignmentOperator(parent.operatorToken.kind)) ||
    (ts.isPrefixUnaryExpression(parent) && parent.operand === node) ||
    (ts.isPostfixUnaryExpression(parent) && parent.operand === node) ||
    (ts.isDeleteExpression(parent) && parent.expression === node)
  );
}
