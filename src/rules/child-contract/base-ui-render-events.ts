import type { CallbackExpressionProbe, ChildComponentSource } from "./model.js";
import {
  bindingDeclarationCount,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { bindingElementPropertyName, isBindingName } from "./prop-bindings.js";
import { identifiersNamed, nearestNestedFunction } from "../../core/ast.js";
import { climbTransparentExpression } from "./carried-values.js";
import ts from "typescript";
import { uniqueVariableDeclaration } from "../state-proofs/binding-lookup.js";

const UTILITY_MODULES = {
  mergeProps: "@base-ui/react/merge-props",
  useRender: "@base-ui/react/use-render",
} as const;

/** Only an authentic Base UI import can establish the utility's runtime contract. */
function isUtility(
  call: ts.CallExpression,
  source: ChildComponentSource,
  utility: "useRender" | "mergeProps",
): boolean {
  const callee = unwrapTransparentExpression(call.expression);
  if (!ts.isIdentifier(callee) || bindingDeclarationCount(source.owner, callee.text) !== 0) {
    return false;
  }
  return source.owner.getSourceFile().statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== UTILITY_MODULES[utility] ||
      statement.importClause?.isTypeOnly
    ) {
      return false;
    }
    const bindings = statement.importClause?.namedBindings;
    return (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some(
        (element) =>
          !element.isTypeOnly &&
          element.name.text === callee.text &&
          (element.propertyName?.text ?? element.name.text) === utility,
      )
    );
  });
}

function plainObject(expression: ts.Expression): ts.ObjectLiteralExpression | null {
  const value = unwrapTransparentExpression(expression);
  return ts.isObjectLiteralExpression(value) &&
    value.properties.every(
      (property) => ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name),
    )
    ? value
    : null;
}

/** Function merge inputs execute eagerly; mutable/escaped defaults can hide one too. */
function isObjectMergeInput(expression: ts.Expression, source: ChildComponentSource): boolean {
  if (plainObject(expression)) {
    return true;
  }
  const value = unwrapTransparentExpression(expression);
  if (!ts.isIdentifier(value) || bindingDeclarationCount(source.owner, value.text) !== 1) {
    return false;
  }
  const declaration = uniqueVariableDeclaration(source.owner, value.text);
  return Boolean(
    declaration?.initializer &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
    plainObject(declaration.initializer) &&
    identifiersNamed(source.body, value.text).every(
      (reference) =>
        reference === value || isBindingName(reference) || isNonValueIdentifier(reference),
    ),
  );
}

function renderBindingIsAbsent(source: ChildComponentSource, binding: ts.Identifier): boolean {
  const [parameter] = source.owner.parameters;
  if (
    !parameter ||
    !ts.isObjectBindingPattern(parameter.name) ||
    !source.invocation ||
    bindingDeclarationCount(source.owner, binding.text) !== 1
  ) {
    return false;
  }
  const element = parameter.name.elements.find(
    (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === binding.text,
  );
  const prop = element ? bindingElementPropertyName(element) : null;
  if (
    !element ||
    !prop ||
    element.initializer ||
    element.dotDotDotToken ||
    source.invocation.attributes.properties.some(
      (attribute) => ts.isJsxSpreadAttribute(attribute) || attribute.name.getText() === prop,
    )
  ) {
    return false;
  }
  return identifiersNamed(source.body, binding.text).every((reference) => {
    if (isBindingName(reference) || isNonValueIdentifier(reference)) {
      return true;
    }
    if (reference === binding) {
      return true;
    }
    // Permit the common `render ? undefined : "button"` type default, but no mutation or escape.
    return ts.isConditionalExpression(reference.parent) && reference.parent.condition === reference;
  });
}

function rendersDefaultHost(
  call: ts.CallExpression,
  source: ChildComponentSource,
  props: ts.Expression,
): boolean {
  if (
    !isUtility(call, source, "useRender") ||
    call.arguments.length !== 1 ||
    nearestNestedFunction(call, source.owner) !== null ||
    !ts.isReturnStatement(call.parent)
  ) {
    return false;
  }
  const [options] = call.arguments;
  const fields = options && ts.isObjectLiteralExpression(options) ? optionFields(options) : null;
  const tag = fields?.get("defaultTagName");
  const render = fields?.get("render");
  return Boolean(
    fields &&
    fields.get("props") === props &&
    tag &&
    ts.isStringLiteralLike(tag) &&
    /^[a-z][a-z0-9]*$/u.test(tag.text) &&
    (!render || (ts.isIdentifier(render) && renderBindingIsAbsent(source, render))),
  );
}

function optionFields(
  options: ts.ObjectLiteralExpression,
): ReadonlyMap<string, ts.Expression> | null {
  const fields = new Map<string, ts.Expression>();
  for (const property of options.properties) {
    if (
      (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) ||
      ts.isComputedPropertyName(property.name)
    ) {
      return null;
    }
    const key = ts.isStringLiteralLike(property.name)
      ? property.name.text
      : property.name.getText();
    if (fields.has(key) || !["props", "defaultTagName", "render"].includes(key)) {
      return null;
    }
    fields.set(key, ts.isPropertyAssignment(property) ? property.initializer : property.name);
  }
  return fields;
}

function mergeReachesHost(merge: ts.CallExpression, source: ChildComponentSource): boolean {
  const props = climbTransparentExpression(merge);
  const property = props.parent;
  const options = property.parent;
  return (
    ts.isPropertyAssignment(property) &&
    property.initializer === props &&
    ts.isObjectLiteralExpression(options) &&
    ts.isCallExpression(options.parent) &&
    rendersDefaultHost(options.parent, source, props)
  );
}

/**
 * Trace one event field through mergeProps to a directly returned useRender default DOM element.
 * Other references still pass through the ordinary all-references proof. An override, unknown
 * spread, eager merge function, or non-event field cannot borrow this event-only contract.
 */
export function baseUiRenderEventStage({
  expression,
  path,
  source,
}: CallbackExpressionProbe): boolean | null {
  if (path.length !== 1 || !/^on[A-Z]/u.test(path[0] ?? "")) {
    return null;
  }
  const merge = expression.parent;
  if (
    !ts.isCallExpression(merge) ||
    !merge.arguments.includes(expression) ||
    !isUtility(merge, source, "mergeProps")
  ) {
    return null;
  }
  if (
    !merge.arguments.every(
      (argument) => argument === expression || isObjectMergeInput(argument, source),
    )
  ) {
    return false;
  }
  return mergeReachesHost(merge, source);
}
