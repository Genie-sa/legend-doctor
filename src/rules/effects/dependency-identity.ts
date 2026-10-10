import type { EffectClassificationContext } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { declaresComparablePrimitive } from "./declared-primitive-paths.js";
import { isCustomHookOwner } from "../../analysis/ast-helpers.js";
import { isPrimitive } from "../in-place-memo-keys/primitive-selection.js";
import { isReactHookCall } from "../../core/imports.js";
import { lexicalBinding } from "../../core/lexical-bindings.js";
import { nodeWithin } from "../../core/ast.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

/**
 * React keeps a state value's identity until its setter runs, a binding outside the owner does
 * not change between its renders, a length or other primitive compares by value, React re-runs
 * a component after a render-phase update with the same props, and a pure owner recomputes a
 * parameter its type declares primitive to an equal value, so comparing them settles.
 */
export function hasStableIdentity(
  dependency: ts.Expression,
  owner: RuntimeFunctionLike,
  context: EffectClassificationContext,
): boolean {
  const node = unwrapTransparentExpression(dependency);
  const root = pathRoot(node);
  const binding = root && lexicalBinding(root);
  if (
    (ts.isPropertyAccessExpression(node) && node.name.text === "length") ||
    binding?.kind === "import"
  ) {
    return true;
  }
  if (!root || !binding || binding.kind === "ambient") {
    return false;
  }
  const state = context.stateByValue.get(root.text);
  return (
    !nodeWithin(binding.declaration, owner) ||
    (state?.owner === owner && nodeWithin(binding.declaration, state.call.parent)) ||
    isStableConstant(binding.declaration, owner, context.imports) ||
    isComponentProp(root.text, binding.declaration, owner) ||
    declaresComparablePrimitive(node, binding.declaration, owner)
  );
}

/**
 * A primitive compares by value and an outer binding keeps its identity, so recomputing either
 * settles, and so does a memo whose pure factory returns only such values.
 */
function isStableConstant(
  declaration: ts.Node,
  owner: RuntimeFunctionLike,
  imports: EffectClassificationContext["imports"],
): boolean {
  if (
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) ||
    (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0 ||
    !declaration.initializer
  ) {
    return false;
  }
  const value = unwrapTransparentExpression(declaration.initializer);
  return isStableValue(value, owner) || isStableMemo(value, owner, imports);
}

function isStableMemo(
  value: ts.Expression,
  owner: RuntimeFunctionLike,
  imports: EffectClassificationContext["imports"],
): boolean {
  if (!ts.isCallExpression(value) || !isReactHookCall(value, "useMemo", imports)) {
    return false;
  }
  const [argument] = value.arguments;
  const factory = argument && unwrapTransparentExpression(argument);
  return (
    factory !== undefined &&
    (ts.isArrowFunction(factory) || ts.isFunctionExpression(factory)) &&
    factory.parameters.length === 0 &&
    !factory.asteriskToken &&
    !factory.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
    returnedValues(factory).every((returned) => isStableValue(returned, owner))
  );
}

/** Every value a function returns; a missing or bare `return` yields `undefined`, a primitive. */
function returnedValues(factory: ts.ArrowFunction | ts.FunctionExpression): ts.Expression[] {
  if (!ts.isBlock(factory.body)) {
    return [factory.body];
  }
  const values: ts.Expression[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression) {
      values.push(node.expression);
    } else if (!ts.isFunctionLike(node) && !ts.isClassLike(node)) {
      node.forEachChild(collect);
    }
  };
  factory.body.forEachChild(collect);
  return values;
}

/** A primitive, a choice between stable values, or a constant path rooted outside the owner. */
function isStableValue(expression: ts.Expression, owner: RuntimeFunctionLike): boolean {
  const value = unwrapTransparentExpression(expression);
  if (isPrimitive(value, value.getSourceFile())) {
    return true;
  }
  if (ts.isConditionalExpression(value)) {
    return isStableValue(value.whenTrue, owner) && isStableValue(value.whenFalse, owner);
  }
  const root = constantPathRoot(value);
  const binding = root && lexicalBinding(root);
  return (
    binding?.kind === "import" ||
    ((binding?.kind === "value" || binding?.kind === "function") &&
      !nodeWithin(binding.declaration, owner))
  );
}

/** The root of a path whose every step is a property name or a literal key. */
function constantPathRoot(node: ts.Expression): ts.Identifier | null {
  const inner = unwrapTransparentExpression(node);
  if (ts.isIdentifier(inner)) {
    return inner;
  }
  if (ts.isPropertyAccessExpression(inner)) {
    return constantPathRoot(inner.expression);
  }
  return ts.isElementAccessExpression(inner) &&
    (ts.isStringLiteralLike(inner.argumentExpression) ||
      ts.isNumericLiteral(inner.argumentExpression))
    ? constantPathRoot(inner.expression)
    : null;
}

function pathRoot(node: ts.Expression): ts.Identifier | null {
  const inner = unwrapTransparentExpression(node);
  if (ts.isIdentifier(inner)) {
    return inner;
  }
  return ts.isPropertyAccessExpression(inner) ? pathRoot(inner.expression) : null;
}

/** A destructuring default other than a stable value is rebuilt on every render the prop is missing. */
function isComponentProp(name: string, declaration: ts.Node, owner: RuntimeFunctionLike): boolean {
  const pattern = isCustomHookOwner(owner) ? null : componentPropsPattern(declaration, owner);
  return pattern !== null && bindsWithStableDefault(pattern, name, owner);
}

/** The pattern that binds the owner's props: its parameter, or a `const` destructuring of that parameter. */
function componentPropsPattern(
  declaration: ts.Node,
  owner: RuntimeFunctionLike,
): ts.BindingName | null {
  if (ts.isParameter(declaration)) {
    return declaration.parent === owner && !declaration.initializer ? declaration.name : null;
  }
  if (
    !ts.isVariableDeclaration(declaration) ||
    !ts.isObjectBindingPattern(declaration.name) ||
    !declaration.initializer ||
    (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0
  ) {
    return null;
  }
  const source = unwrapTransparentExpression(declaration.initializer);
  const binding = ts.isIdentifier(source) ? lexicalBinding(source) : null;
  const parameter = binding?.kind === "value" ? binding.declaration : null;
  return ts.isIdentifier(source) &&
    parameter &&
    ts.isParameter(parameter) &&
    parameter.parent === owner &&
    !parameter.initializer &&
    bindsPropsObject(parameter.name, source.text)
    ? declaration.name
    : null;
}

/** The props parameter itself, or the rest of its fields, whose values are the props' own. */
function bindsPropsObject(pattern: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(pattern)) {
    return pattern.text === name;
  }
  return (
    ts.isObjectBindingPattern(pattern) &&
    pattern.elements.some(
      (element) =>
        element.dotDotDotToken !== undefined &&
        ts.isIdentifier(element.name) &&
        element.name.text === name,
    )
  );
}

function bindsWithStableDefault(
  pattern: ts.BindingName,
  name: string,
  owner: RuntimeFunctionLike,
): boolean {
  if (ts.isIdentifier(pattern)) {
    return pattern.text === name;
  }
  return pattern.elements.some(
    (element) =>
      ts.isBindingElement(element) &&
      (!element.initializer || isStableValue(element.initializer, owner)) &&
      bindsWithStableDefault(element.name, name, owner),
  );
}
