import {
  bindingDeclarationCount,
  collectBindingNames,
  isAssignmentOperator,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import {
  isReactEffectCall,
  resolveLifecycleCallback,
} from "../react-commit-sensitivity/effect-lifecycle.js";
import { visit, visitSkippingNestedRuntimeFunctions } from "../../core/ast.js";
import type { ObservableReadScan } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { bindingContainsName } from "../../core/binding-references.js";
import { hasStableSourceBinding } from "./independent-subscription-bindings.js";
import { identifiedUseValueDeclaration } from "./observable-paths.js";
import { isReactHookCall } from "../../core/imports.js";
import { isUseObservableCall } from "../in-place-memo-keys/memo-dependencies.js";
import { primitiveType } from "./primitive-paths.js";
import ts from "typescript";
import { uniqueVariableDeclaration } from "../state-proofs/binding-lookup.js";

/** An effect whose dependencies keep their identity does not rerun on a subscription-only render. */
export function hasStableEffectDependencies(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): boolean {
  if (!isReactEffectCall(call, scan.imports) || !call.arguments[0]) {
    return false;
  }
  const callback = resolveLifecycleCallback(call.arguments[0], {
    owner,
    imports: scan.imports,
    seen: new Set(),
  });
  const [, dependencies] = call.arguments;
  return (
    callback !== null &&
    dependencies !== undefined &&
    ts.isArrayLiteralExpression(dependencies) &&
    dependencies.elements.every((dependency) => subscriptionStableValue(dependency, owner, scan))
  );
}

/**
 * A value that keeps its identity when only an unrelated subscription rerenders the owner:
 * literals and primitive props, other `useValue` results, `useRef` and `useObservable` handles,
 * `useState` tuple members, zero-argument reads of an imported context-reader hook, and
 * `useMemo`/`useCallback` results whose own dependencies are stable. Counting the subscription
 * being cut as stable is harmless: a dependency on it is a memo or effect consumer, which blocks
 * the cut by itself.
 */
export function subscriptionStableValue(
  expression: ts.Expression,
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): boolean {
  return stableValue(expression, { owner, scan, chain: new Set() });
}

/** A cached hook recomputes on a subscription-only render only when a dependency changes identity. */
export function hasStableCacheDependencies(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): boolean {
  return stableCache(call, { owner, scan, chain: new Set() });
}

interface StabilityScope {
  readonly owner: RuntimeFunctionLike;
  readonly scan: ObservableReadScan;
  /** Declarations on the current dependency chain; a cycle proves nothing. */
  readonly chain: Set<ts.VariableDeclaration>;
}

function stableValue(expression: ts.Expression, scope: StabilityScope): boolean {
  const { owner } = scope;
  if (stablePrimitiveDependency(expression, owner)) {
    return true;
  }
  if (!ts.isIdentifier(expression) || bindingDeclarationCount(owner, expression.text) !== 1) {
    return false;
  }
  const declaration = constOwnerDeclaration(owner, expression.text);
  return declaration !== null && stableDeclaration(declaration, expression.text, scope);
}

function stableDeclaration(
  declaration: ts.VariableDeclaration,
  name: string,
  scope: StabilityScope,
): boolean {
  if (scope.chain.has(declaration)) {
    return false;
  }
  scope.chain.add(declaration);
  const stable = ts.isIdentifier(declaration.name)
    ? stableHookResult(declaration, scope)
    : stateTupleMember(declaration, name, scope.scan);
  scope.chain.delete(declaration);
  return stable;
}

function stableHookResult(declaration: ts.VariableDeclaration, scope: StabilityScope): boolean {
  const { scan } = scope;
  const call = declaration.initializer;
  if (!call || !ts.isCallExpression(call)) {
    return false;
  }
  return (
    identifiedUseValueDeclaration(declaration, scan) !== null ||
    isReactHookCall(call, "useRef", scan.imports) ||
    isUseObservableCall(call, scan.imports) ||
    stableCache(call, scope) ||
    isContextRead(call, scope)
  );
}

function stableCache(call: ts.CallExpression, scope: StabilityScope): boolean {
  const { scan } = scope;
  if (
    !isReactHookCall(call, "useMemo", scan.imports) &&
    !isReactHookCall(call, "useCallback", scan.imports)
  ) {
    return false;
  }
  const [callback, dependencies, ...rest] = call.arguments;
  return (
    callback !== undefined &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
    dependencies !== undefined &&
    ts.isArrayLiteralExpression(dependencies) &&
    rest.length === 0 &&
    dependencies.elements.every((dependency) => stableValue(dependency, scope))
  );
}

/** A new provider value rerenders the owner through React context, independent of any subscription. */
function isContextRead(call: ts.CallExpression, { owner, scan }: StabilityScope): boolean {
  const callee = call.expression;
  return (
    ts.isIdentifier(callee) &&
    call.arguments.length === 0 &&
    call.questionDotToken === undefined &&
    bindingDeclarationCount(owner, callee.text) === 0 &&
    hasStableSourceBinding(callee) &&
    (scan.childContracts?.contextReaderBindings().has(callee.text) ?? false)
  );
}

function stateTupleMember(
  declaration: ts.VariableDeclaration,
  name: string,
  scan: ObservableReadScan,
): boolean {
  const call = declaration.initializer;
  if (
    !ts.isArrayBindingPattern(declaration.name) ||
    !call ||
    !ts.isCallExpression(call) ||
    !isReactHookCall(call, "useState", scan.imports)
  ) {
    return false;
  }
  const [value, setter] = declaration.name.elements;
  return [value, setter].some(
    (element) =>
      element !== undefined &&
      ts.isBindingElement(element) &&
      !element.dotDotDotToken &&
      !element.initializer &&
      ts.isIdentifier(element.name) &&
      element.name.text === name,
  );
}

function constOwnerDeclaration(
  owner: RuntimeFunctionLike,
  name: string,
): ts.VariableDeclaration | null {
  let found: ts.VariableDeclaration | null = null;
  if (!owner.body) {
    return null;
  }
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      const names = new Set<string>();
      collectBindingNames(node.name, names);
      if (names.has(name)) {
        found = node;
      }
    }
  });
  return found;
}

function stablePrimitiveDependency(expression: ts.Expression, owner: RuntimeFunctionLike): boolean {
  if (
    ts.isStringLiteralLike(expression) ||
    ts.isNumericLiteral(expression) ||
    [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(
      expression.kind,
    )
  ) {
    return true;
  }
  if (!ts.isIdentifier(expression) || bindingDeclarationCount(owner, expression.text) !== 1) {
    return false;
  }
  const name = expression.text;
  const parameter = owner.parameters.find((candidate) => bindingContainsName(candidate.name, name));
  if (parameter) {
    return parameterPrimitive(parameter, name) && !bindingWritten(owner, name);
  }
  const declaration = uniqueVariableDeclaration(owner, name);
  return (
    declaration !== null &&
    declaration.initializer !== undefined &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
    (ts.isStringLiteralLike(declaration.initializer) ||
      ts.isNumericLiteral(declaration.initializer))
  );
}

function parameterPrimitive(parameter: ts.ParameterDeclaration, name: string): boolean {
  if (!parameter.type || parameter.initializer || parameter.dotDotDotToken) {
    return false;
  }
  if (ts.isIdentifier(parameter.name)) {
    return primitiveType(parameter.type);
  }
  if (!ts.isObjectBindingPattern(parameter.name) || !ts.isTypeLiteralNode(parameter.type)) {
    return false;
  }
  const binding = parameter.name.elements.find(
    (element) => ts.isIdentifier(element.name) && element.name.text === name,
  );
  if (!binding || binding.initializer || binding.dotDotDotToken) {
    return false;
  }

  return parameter.type.members.some(
    (member) =>
      ts.isPropertySignature(member) &&
      member.name.getText() === (binding.propertyName?.getText() ?? name) &&
      member.type !== undefined &&
      primitiveType(member.type),
  );
}

function bindingWritten(owner: RuntimeFunctionLike, name: string): boolean {
  let written = false;
  visit(owner.body, (node) => {
    const target = assignmentTarget(node);
    if (target && targetWritesBinding(target, name)) {
      written = true;
    }
  });
  return written;
}

function assignmentTarget(node: ts.Node): ts.Expression | null {
  if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
    return node.left;
  }
  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    return ts.isVariableDeclarationList(node.initializer) ? null : node.initializer;
  }
  return ts.isPostfixUnaryExpression(node) ||
    (ts.isPrefixUnaryExpression(node) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator))
    ? node.operand
    : null;
}

/** Follow assignment targets only: property receivers, keys, and defaults are reads. */
function targetWritesBinding(expression: ts.Expression, name: string): boolean {
  const target = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(target)) {
    return target.text === name;
  }
  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.some((element) => targetWritesBinding(element, name));
  }
  if (ts.isObjectLiteralExpression(target)) {
    return target.properties.some((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return property.name.text === name;
      }
      if (ts.isPropertyAssignment(property)) {
        return targetWritesBinding(property.initializer, name);
      }
      return ts.isSpreadAssignment(property) && targetWritesBinding(property.expression, name);
    });
  }
  if (ts.isSpreadElement(target)) {
    return targetWritesBinding(target.expression, name);
  }
  return (
    ts.isBinaryExpression(target) &&
    target.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    targetWritesBinding(target.left, name)
  );
}
