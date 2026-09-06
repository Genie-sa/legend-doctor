import type {
  CallbackContractSourceResolver,
  CallbackTrace,
  ChildComponentSource,
} from "./model.js";
import {
  bindingDeclarationCount,
  hookCallName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { bindingElementPropertyName, isBindingName, propertyName } from "./prop-bindings.js";
import {
  climbTransparentExpression,
  isNullishExpression,
  objectLiteralPropertyValue,
} from "./carried-values.js";
import {
  findAncestor,
  findAncestorUntil,
  isRuntimeFunctionLike,
  nearestNestedFunction,
  nodeWithin,
  visit,
} from "../../core/ast.js";
import { MAX_CALLBACK_PATH_DEPTH } from "./model.js";
import { callbackReferenceIsObservationOnly } from "./observation-only-reads.js";
import { jsxAttributeDirectlyCarries } from "./jsx-owner.js";
import { jsxEventAttributeIsDeferred } from "./jsx-event-attributes.js";
import ts from "typescript";

function higherOrderFactoryDefersArgument(options: {
  readonly argumentIndex: number;
  readonly call: ts.CallExpression;
  readonly resolver: CallbackContractSourceResolver;
  readonly source: ChildComponentSource;
}): boolean {
  const { argumentIndex, call, resolver, source } = options;
  const callee = call.expression;
  if (!ts.isIdentifier(callee) || bindingDeclarationCount(source.owner, callee.text) !== 1) {
    return false;
  }
  const hookBinding = returnedHookFunctionBinding(source.owner, callee.text);
  if (!hookBinding) {
    return false;
  }
  const hook = resolver.resolveHook(source.file, hookBinding.hookName);
  const factory = hook ? returnedLocalFunction(hook, hookBinding.property) : null;
  return factory !== null && higherOrderFunctionDefersParameter(factory, argumentIndex);
}

export function higherOrderCallDefersCallback(
  callback: ts.Identifier,
  source: ChildComponentSource,
  trace: CallbackTrace,
): boolean {
  if (trace.depth > MAX_CALLBACK_PATH_DEPTH) {
    return false;
  }
  const call = findAncestor(callback, ts.isCallExpression);
  if (!call || nodeWithin(callback, call.expression)) {
    return false;
  }
  const argumentIndex = call.arguments.findIndex((argument) => nodeWithin(callback, argument));
  if (argumentIndex === -1 || !callResultIsDeferredEvent(call, source, trace)) {
    return false;
  }
  return higherOrderFactoryDefersArgument({
    argumentIndex,
    call,
    resolver: trace.resolver,
    source,
  });
}

function deferredEventResultExpression(
  call: ts.CallExpression,
  source: ChildComponentSource,
): ts.Expression | null {
  const result = climbTransparentExpression(call);
  const { parent } = result;
  if (
    !ts.isConditionalExpression(parent) ||
    (parent.whenTrue !== result && parent.whenFalse !== result)
  ) {
    return result;
  }
  const other = parent.whenTrue === result ? parent.whenFalse : parent.whenTrue;
  return isNullishExpression(other, source.owner) ? parent : null;
}

function callResultIsDeferredEvent(
  call: ts.CallExpression,
  source: ChildComponentSource,
  trace: CallbackTrace,
): boolean {
  const result = deferredEventResultExpression(call, source);
  if (!result) {
    return false;
  }
  const attribute = findAncestorUntil(result, ts.isJsxAttribute, source.owner);
  if (
    !attribute ||
    !/^on[A-Z]/u.test(attribute.name.getText()) ||
    !jsxAttributeDirectlyCarries(attribute, result)
  ) {
    return false;
  }
  return jsxEventAttributeIsDeferred(attribute, source, trace);
}

function returnedHookFunctionBinding(
  owner: ChildComponentSource["owner"],
  localName: string,
): { hookName: string; property: string } | null {
  let binding: { hookName: string; property: string } | null = null;
  visit(owner.body, (node) => {
    if (
      binding ||
      !ts.isVariableDeclaration(node) ||
      !ts.isObjectBindingPattern(node.name) ||
      !node.initializer
    ) {
      return;
    }
    const matches = node.name.elements.filter(
      (element) => ts.isIdentifier(element.name) && element.name.text === localName,
    );
    const match = matches.length === 1 ? matches[0] : null;
    const call = unwrapTransparentExpression(node.initializer);
    const hookName = ts.isCallExpression(call) ? hookCallName(call) : null;
    const property = match ? bindingElementPropertyName(match) : null;
    if (hookName && property) {
      binding = { hookName, property };
    }
  });
  return binding;
}

function returnedObjectPropertyValue(
  expression: ts.Expression,
  property: string,
): ts.Identifier | null {
  const returned = unwrapTransparentExpression(expression);
  if (!ts.isObjectLiteralExpression(returned)) {
    return null;
  }
  const matches = returned.properties.filter(
    (member) =>
      (ts.isPropertyAssignment(member) || ts.isShorthandPropertyAssignment(member)) &&
      propertyName(member.name) === property,
  );
  const match = matches.length === 1 ? matches[0] : null;
  const value = objectLiteralPropertyValue(match);
  return value && ts.isIdentifier(value) ? value : null;
}

function soleReturnedPropertyName(source: ChildComponentSource, property: string): string | null {
  const names = new Set<string>();
  let safe = true;
  visit(source.owner.body, (node) => {
    if (!safe || !ts.isReturnStatement(node) || !node.expression) {
      return;
    }
    if (findAncestor(node, isRuntimeFunctionLike) !== source.owner) {
      return;
    }
    const value = returnedObjectPropertyValue(node.expression, property);
    if (!value) {
      safe = false;
      return;
    }
    names.add(value.text);
  });
  const [name] = names;
  return safe && names.size === 1 && name ? name : null;
}

function localFunctionInitializer(
  initializer: ts.Expression,
  owner: ChildComponentSource["owner"],
): ts.ArrowFunction | ts.FunctionExpression | null {
  const value = unwrapTransparentExpression(initializer);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
    return value;
  }
  const [argument] = ts.isCallExpression(value) ? value.arguments : [];
  if (
    !ts.isCallExpression(value) ||
    hookCallName(value) !== "useCallback" ||
    bindingDeclarationCount(owner, "useCallback") !== 0 ||
    !argument ||
    (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument))
  ) {
    return null;
  }
  return argument;
}

function localFunctionNamed(
  source: ChildComponentSource,
  name: string,
): ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression | null {
  let result: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression | null = null;
  visit(source.owner.body, (node) => {
    if (result) {
      return;
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      result = node;
      return;
    }
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      node.name.text !== name ||
      !node.initializer
    ) {
      return;
    }
    result = localFunctionInitializer(node.initializer, source.owner);
  });
  return result;
}

function returnedLocalFunction(
  source: ChildComponentSource,
  property: string,
): ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression | null {
  const name = soleReturnedPropertyName(source, property);
  if (!name || bindingDeclarationCount(source.owner, name) !== 1) {
    return null;
  }
  return localFunctionNamed(source, name);
}

function higherOrderFunctionDefersParameter(
  factory: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  argumentIndex: number,
): boolean {
  const parameter = factory.parameters[argumentIndex];
  if (!parameter || !ts.isIdentifier(parameter.name)) {
    return false;
  }
  const parameterName = parameter.name.text;
  let references = 0;
  let safe = true;
  visit(factory.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== parameterName ||
      isBindingName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    references += 1;
    if (callbackReferenceIsObservationOnly(node)) {
      return;
    }
    const call = findAncestorUntil(node, ts.isCallExpression, factory);
    const wrapper = nearestNestedFunction(node, factory);
    if (
      !call ||
      nodeWithin(node, call.expression) === false ||
      !wrapper ||
      (!ts.isArrowFunction(wrapper) && !ts.isFunctionExpression(wrapper)) ||
      !functionIsDirectlyReturned(wrapper, factory)
    ) {
      safe = false;
    }
  });
  return safe && references > 0;
}

function functionIsDirectlyReturned(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  owner: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
): boolean {
  if (!owner.body) {
    return false;
  }
  if (!ts.isBlock(owner.body)) {
    return unwrapTransparentExpression(owner.body) === callback;
  }
  const statement = findAncestorUntil(callback, ts.isReturnStatement, owner);
  return (
    statement?.expression !== undefined &&
    unwrapTransparentExpression(statement.expression) === callback
  );
}
