import type {
  BindingMember,
  IdentityScope,
  NamedBinding,
  ParameterIdentity,
  PropIdentity,
} from "./identity-model.js";
import {
  STABLE,
  bindingMember,
  defaultedBindingIdentity,
  fresh,
  settled,
  unproven,
} from "./identity-model.js";
import {
  findAncestor,
  isRuntimeFunctionLike,
  visitSkippingNestedRuntimeFunctions,
} from "../../core/ast.js";
import { propertyNameText, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { lexicalBinding } from "../../core/lexical-bindings.js";
import ts from "typescript";

const MAX_HOOK_DEPTH = 3;

/**
 * A project hook's result keeps its identity when every value it can return does, evaluated in
 * the hook with each parameter bound to the caller's argument. A render that changes none of those
 * arguments and none of the hook's own state then returns the same value.
 */
export function projectHookIdentity(
  call: ts.CallExpression,
  member: BindingMember | null,
  scope: IdentityScope,
): PropIdentity {
  const hook = projectHookDeclaration(call, scope);
  if (!hook) {
    return unproven("a call result");
  }
  if (scope.depth >= MAX_HOOK_DEPTH || scope.visiting.has(hook)) {
    return unproven("a hook result nested too deeply to follow");
  }
  const hookScope: IdentityScope = {
    ...scope,
    depth: scope.depth + 1,
    owner: hook,
    parameters: parameterIdentities(hook, call, scope),
    visiting: new Set(scope.visiting).add(hook),
  };
  return returnedIdentity(returnedExpressions(hook), member, hookScope);
}

/** Only a module-scope or imported binding names the same hook on every render. */
function projectHookDeclaration(
  call: ts.CallExpression,
  scope: IdentityScope,
): RuntimeFunctionLike | null {
  const callee = unwrapTransparentExpression(call.expression);
  const binding = ts.isIdentifier(callee) ? lexicalBinding(callee) : null;
  const moduleScope =
    binding?.kind === "import" ||
    (binding?.kind === "function" &&
      findAncestor(binding.declaration, isRuntimeFunctionLike) === null);
  return moduleScope ? scope.resolveHook(call) : null;
}

function returnedIdentity(
  results: readonly ts.Expression[],
  member: BindingMember | null,
  scope: IdentityScope,
): PropIdentity {
  const identities = results.map((result) => memberIdentity(result, member, scope));
  if (identities.some((identity) => identity.kind === "fresh")) {
    return unproven("a hook result that allocates on every render");
  }
  return identities.find((identity) => identity.kind === "unproven") ?? STABLE;
}

function parameterIdentities(
  hook: RuntimeFunctionLike,
  call: ts.CallExpression,
  caller: IdentityScope,
): ParameterIdentity {
  return (parameter, name) => {
    const index = hook.parameters.indexOf(parameter);
    const passed = call.arguments.slice(0, index + 1);
    if (index === -1 || passed.some((argument) => ts.isSpreadElement(argument))) {
      return unproven("a hook parameter fed by a spread argument");
    }
    const argument = call.arguments[index];
    const binding = { name, pattern: parameter.name };
    return argument
      ? argumentIdentity(binding, argument, caller)
      : defaultedBindingIdentity(binding, parameter.initializer);
  };
}

function argumentIdentity(
  binding: NamedBinding,
  argument: ts.Expression,
  caller: IdentityScope,
): PropIdentity {
  if (ts.isIdentifier(binding.pattern)) {
    return caller.evaluate(argument, caller);
  }
  const member = bindingMember(binding.pattern, binding.name);
  const value = unwrapTransparentExpression(argument);
  const source =
    member && ts.isObjectLiteralExpression(value)
      ? memberIdentity(value, member, caller)
      : settled(caller.evaluate(argument, caller));
  return source.kind === "stable" ? defaultedBindingIdentity(binding) : source;
}

function returnedExpressions(hook: RuntimeFunctionLike): readonly ts.Expression[] {
  if (!hook.body) {
    return [];
  }
  if (!ts.isBlock(hook.body)) {
    return [hook.body];
  }
  const results: ts.Expression[] = [];
  visitSkippingNestedRuntimeFunctions(hook.body, (node) => {
    if (ts.isReturnStatement(node) && node.expression) {
      results.push(node.expression);
    }
  });
  return results;
}

/** The identity of one member of a value, read straight from a literal when the value is one. */
function memberIdentity(
  expression: ts.Expression,
  member: BindingMember | null,
  scope: IdentityScope,
): PropIdentity {
  const value = unwrapTransparentExpression(expression);
  if (member === null) {
    return scope.evaluate(value, scope);
  }
  if (member.kind === "property" && ts.isObjectLiteralExpression(value)) {
    return propertyIdentity(value, member.key, scope);
  }
  if (member.kind === "index" && ts.isArrayLiteralExpression(value)) {
    return elementIdentity(value, member.index, scope);
  }
  return settled(scope.evaluate(value, scope));
}

function elementIdentity(
  array: ts.ArrayLiteralExpression,
  index: number,
  scope: IdentityScope,
): PropIdentity {
  const element = array.elements[index];
  if (array.elements.slice(0, index + 1).some((candidate) => ts.isSpreadElement(candidate))) {
    return unproven("a member after a spread");
  }
  return element && !ts.isOmittedExpression(element) ? scope.evaluate(element, scope) : STABLE;
}

/** The last member that can supply `key` decides its value. */
function propertyIdentity(
  object: ts.ObjectLiteralExpression,
  key: string,
  scope: IdentityScope,
): PropIdentity {
  for (const property of object.properties.toReversed()) {
    const identity = propertyEntryIdentity(property, key, scope);
    if (identity) {
      return identity;
    }
  }
  return STABLE;
}

function propertyEntryIdentity(
  property: ts.ObjectLiteralElementLike,
  key: string,
  scope: IdentityScope,
): PropIdentity | null {
  if (ts.isSpreadAssignment(property)) {
    return unproven("a member that a spread may supply");
  }
  const name = propertyNameText(property.name);
  if (name === null) {
    return unproven("a member beside a computed key");
  }
  return name === key ? propertyValueIdentity(property, scope) : null;
}

function propertyValueIdentity(
  property: Exclude<ts.ObjectLiteralElementLike, ts.SpreadAssignment>,
  scope: IdentityScope,
): PropIdentity {
  if (ts.isPropertyAssignment(property)) {
    return scope.evaluate(property.initializer, scope);
  }
  if (ts.isShorthandPropertyAssignment(property)) {
    return scope.evaluate(property.name, scope);
  }
  return ts.isMethodDeclaration(property)
    ? fresh("function", property)
    : unproven("an accessor member");
}
