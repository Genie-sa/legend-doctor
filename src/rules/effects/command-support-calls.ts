import type { DependencyEffectScope, EffectCallSurvey } from "./model.js";
import {
  bindingDeclarationCount,
  callRootIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { nodeWithin, visit, visitSkippingNestedRuntimeFunctions } from "../../core/ast.js";
import { KNOWN_GLOBAL_OBJECTS } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isSubscriptionCall } from "./callback-shape.js";
import ts from "typescript";

const STRING_SEARCH_METHOD_PATTERN = /^(?:endsWith|includes|indexOf|lastIndexOf|startsWith)$/u;

export function commandSupportCallsAreInert(
  survey: EffectCallSurvey,
  scope: DependencyEffectScope,
): boolean {
  const nestedCalls = survey.calls.filter((candidate) => candidate !== scope.command);
  const argumentCalls = nestedCalls.filter((candidate) =>
    scope.command.arguments.some((argument) => nodeWithin(candidate, argument)),
  );
  const projectionCallbacks = new Set<ts.Node>(
    nestedCalls.flatMap((candidate) => {
      const projection = dependencyMapProjectionCallback(candidate, scope);
      return projection ? [projection] : [];
    }),
  );
  return !(
    containsFunctionLike(scope.effectCallback.body, projectionCallbacks) ||
    argumentCalls.length > 1 ||
    nestedCalls.length - argumentCalls.length > 1 ||
    nestedCalls.some((candidate) => !isDependencyEffectSupportCall(candidate, scope)) ||
    isSubscriptionCall(scope.command)
  );
}

function isDependencyEffectSupportCall(
  call: ts.CallExpression,
  scope: DependencyEffectScope,
): boolean {
  if (dependencyMapProjectionCallback(call, scope)) {
    return true;
  }
  if (isCallbackDrivenCall(call) || isSubscriptionCall(call)) {
    return false;
  }
  if (isStringSearchCall(call)) {
    return true;
  }
  const root = callRootIdentifier(call.expression);
  if (root === null) {
    return false;
  }
  return bindingDeclarationCount(scope.owner, root) === 0
    ? scope.moduleScopeBindings.has(root) || KNOWN_GLOBAL_OBJECTS.has(root)
    : scope.command.arguments.some((argument) => nodeWithin(call, argument)) &&
        isImportedTranslationArgument(call, scope.owner, scope.dependencies);
}

function isStringSearchCall(call: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    STRING_SEARCH_METHOD_PATTERN.test(call.expression.name.text)
  );
}

function dependencyMapProjectionCallback(
  call: ts.CallExpression,
  scope: DependencyEffectScope,
): ts.ArrowFunction | null {
  if (
    !scope.command.arguments.some((argument) => nodeWithin(call, argument)) ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== "map" ||
    call.arguments.length !== 1
  ) {
    return null;
  }
  const [argument] = call.arguments;
  if (!argument || !ts.isArrowFunction(argument) || !isPureProjectionArrow(argument)) {
    return null;
  }
  const receiver = unwrapTransparentExpression(call.expression.expression);
  const root = staticAccessRoot(receiver);
  if (!root || bindingDeclarationCount(scope.effectCallback, root.text) !== 0) {
    return null;
  }
  return scope.dependencies.elements.some((dependency) =>
    sameStaticAccess(receiver, unwrapTransparentExpression(dependency)),
  )
    ? argument
    : null;
}

function isPureProjectionArrow(callback: ts.ArrowFunction): boolean {
  const parameter = callback.parameters.length === 1 ? callback.parameters[0]! : null;
  return (
    parameter !== null &&
    ts.isIdentifier(parameter.name) &&
    !parameter.dotDotDotToken &&
    !parameter.initializer &&
    !ts.isBlock(callback.body) &&
    !callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
    isParameterProjection(callback.body, parameter.name.text)
  );
}

function staticAccessRoot(expression: ts.Expression): ts.Identifier | null {
  const value = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(value)) {
    return value;
  }
  return ts.isPropertyAccessExpression(value) ? staticAccessRoot(value.expression) : null;
}

function isParameterProjection(expression: ts.Expression, parameterName: string): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(value)) {
    return value.text === parameterName;
  }
  return (
    ts.isPropertyAccessExpression(value) && isParameterProjection(value.expression, parameterName)
  );
}

function sameStaticAccess(left: ts.Expression, right: ts.Expression): boolean {
  if (ts.isIdentifier(left) || ts.isIdentifier(right)) {
    return ts.isIdentifier(left) && ts.isIdentifier(right) && left.text === right.text;
  }
  if (ts.isPropertyAccessExpression(left) || ts.isPropertyAccessExpression(right)) {
    return (
      ts.isPropertyAccessExpression(left) &&
      ts.isPropertyAccessExpression(right) &&
      left.name.text === right.name.text &&
      sameStaticAccess(
        unwrapTransparentExpression(left.expression),
        unwrapTransparentExpression(right.expression),
      )
    );
  }
  return false;
}

/**
 * Recognizes a call to the `t` function destructured from an imported `react-i18next`
 * `useTranslation()` in this owner; translation lookups are pure reads of the i18n table.
 */
export function isImportedTranslationCall(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
): boolean {
  if (!ts.isIdentifier(call.expression) || !owner.body) {
    return false;
  }
  const hookName = translationHookName(owner.body, call.expression.text);
  return (
    hookName !== null &&
    bindingDeclarationCount(owner, hookName) === 0 &&
    importsUseTranslationAs(owner.getSourceFile(), hookName)
  );
}

function isImportedTranslationArgument(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
  dependencies: ts.ArrayLiteralExpression,
): boolean {
  if (!ts.isIdentifier(call.expression) || !owner.body) {
    return false;
  }
  const localName = call.expression.text;
  if (
    !dependencies.elements.some((element) => ts.isIdentifier(element) && element.text === localName)
  ) {
    return false;
  }
  const hookName = translationHookName(owner.body, localName);
  return (
    hookName !== null &&
    bindingDeclarationCount(owner, hookName) === 0 &&
    importsUseTranslationAs(owner.getSourceFile(), hookName)
  );
}

type ConstObjectDestructuring = ts.VariableDeclaration & {
  readonly initializer: ts.CallExpression;
  readonly name: ts.ObjectBindingPattern;
};

function isConstObjectDestructuring(node: ts.Node): node is ConstObjectDestructuring {
  return (
    ts.isVariableDeclaration(node) &&
    ts.isObjectBindingPattern(node.name) &&
    node.initializer !== undefined &&
    ts.isCallExpression(node.initializer) &&
    ts.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

function isTranslationBinding(element: ts.BindingElement, localName: string): boolean {
  const sourceName = element.propertyName ?? element.name;
  return (
    !element.dotDotDotToken &&
    ts.isIdentifier(element.name) &&
    element.name.text === localName &&
    ts.isIdentifier(sourceName) &&
    sourceName.text === "t"
  );
}

function translationHookName(body: ts.Node, localName: string): string | null {
  let hookName: string | null = null;
  visitSkippingNestedRuntimeFunctions(body, (node) => {
    if (hookName !== null || !isConstObjectDestructuring(node)) {
      return;
    }
    const binding = node.name.elements.find((element) => isTranslationBinding(element, localName));
    if (binding && ts.isIdentifier(node.initializer.expression)) {
      hookName = node.initializer.expression.text;
    }
  });
  return hookName;
}

function importsUseTranslationAs(sourceFile: ts.SourceFile, hookName: string): boolean {
  return sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "react-i18next" &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (specifier) =>
          specifier.name.text === hookName &&
          (specifier.propertyName?.text ?? specifier.name.text) === "useTranslation",
      ),
  );
}

function containsFunctionLike(node: ts.Node, allowed: ReadonlySet<ts.Node> = new Set()): boolean {
  let found = false;
  visit(node, (candidate) => {
    if (ts.isFunctionLike(candidate) && !allowed.has(candidate)) {
      found = true;
    }
  });
  return found;
}

export function isCallbackDrivenCall(call: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    /^(?:addEventListener|every|filter|find|findIndex|flatMap|forEach|map|reduce|reduceRight|some)$/u.test(
      call.expression.name.text,
    )
  );
}
