import type { IdentityScope, NamedBinding, PropIdentity } from "./identity-model.js";
import {
  PRIMITIVE_OPERATORS,
  STABLE,
  bindingMember,
  defaultedBindingIdentity,
  fresh,
  isPrimitiveLiteral,
  unproven,
} from "./identity-model.js";
import { ownerHookName } from "./owner-hooks.js";
import { projectHookIdentity } from "./project-hooks.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

const STABLE_HOOK_RESULTS: ReadonlySet<string> = new Set([
  "use",
  "useContext",
  "useId",
  "useObservable",
  "useRef",
]);

const TUPLE_HOOKS: ReadonlySet<string> = new Set(["useReducer", "useState", "useTransition"]);

type SelectorFunction = ts.ArrowFunction | ts.FunctionExpression;

/** The identity of a name bound from a call: a hook tuple member, a hook result, or a member of one. */
export function hookResultIdentity(
  binding: NamedBinding,
  call: ts.CallExpression,
  scope: IdentityScope,
): PropIdentity {
  const hook = ownerHookName(call);
  if (hook && TUPLE_HOOKS.has(hook) && ts.isArrayBindingPattern(binding.pattern)) {
    return STABLE;
  }
  const whole = hook !== null || ts.isIdentifier(binding.pattern);
  const result = whole ? hookIdentity(call, scope) : destructuredHookResult(binding, call, scope);
  return result.kind === "stable" && !ts.isIdentifier(binding.pattern)
    ? defaultedBindingIdentity(binding)
    : result;
}

/** The identity a call's result has across renders that change none of its inputs. */
export function hookIdentity(call: ts.CallExpression, scope: IdentityScope): PropIdentity {
  const hook = ownerHookName(call);
  if (hook === null) {
    return projectHookIdentity(call, null, scope);
  }
  if (STABLE_HOOK_RESULTS.has(hook)) {
    return STABLE;
  }
  if (hook === "useValue") {
    return useValueIdentity(call);
  }
  return hook === "useMemo" || hook === "useCallback"
    ? memoIdentity(call, scope)
    : unproven("a hook tuple bound whole");
}

function destructuredHookResult(
  binding: NamedBinding,
  call: ts.CallExpression,
  scope: IdentityScope,
): PropIdentity {
  const member = bindingMember(binding.pattern, binding.name);
  return member
    ? projectHookIdentity(call, member, scope)
    : unproven("a nested destructuring of a call result");
}

function useValueIdentity(call: ts.CallExpression): PropIdentity {
  const [selector] = call.arguments;
  const argument = selector ? unwrapTransparentExpression(selector) : null;
  return argument && (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))
    ? selectorResultIdentity(argument)
    : STABLE;
}

/**
 * Legend runs a function selector on every render, so its result keeps its identity only when
 * the selector returns a stored observable value or a primitive it computes.
 */
function selectorResultIdentity(selector: SelectorFunction): PropIdentity {
  const result = selectorResult(selector);
  return result && (isStoredObservableRead(result) || isPrimitiveResult(result))
    ? STABLE
    : unproven("a selector result, which the selector may allocate");
}

function selectorResult(selector: SelectorFunction): ts.Expression | null {
  if (!ts.isBlock(selector.body)) {
    return unwrapTransparentExpression(selector.body);
  }
  const [statement, ...rest] = selector.body.statements;
  return statement && rest.length === 0 && ts.isReturnStatement(statement) && statement.expression
    ? unwrapTransparentExpression(statement.expression)
    : null;
}

/** `x$.get()`, `x$.get(true)`, and `x$.peek()` return the stored value, not a copy. */
function isStoredObservableRead(expression: ts.Expression): boolean {
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) {
    return false;
  }
  const method = expression.expression.name.text;
  const [argument, ...rest] = expression.arguments;
  const shallow = argument === undefined || argument.kind === ts.SyntaxKind.TrueKeyword;
  return (method === "get" || method === "peek") && shallow && rest.length === 0;
}

function isPrimitiveResult(expression: ts.Expression): boolean {
  return (
    isPrimitiveLiteral(expression) ||
    ts.isTemplateExpression(expression) ||
    ts.isPrefixUnaryExpression(expression) ||
    ts.isTypeOfExpression(expression) ||
    (ts.isBinaryExpression(expression) && PRIMITIVE_OPERATORS.has(expression.operatorToken.kind))
  );
}

function memoIdentity(call: ts.CallExpression, scope: IdentityScope): PropIdentity {
  const [, dependencies] = call.arguments;
  if (!dependencies || !ts.isArrayLiteralExpression(dependencies)) {
    return fresh("memo without dependencies", call);
  }
  const identity = dependenciesIdentity(dependencies.elements, scope);
  return identity.kind === "fresh" ? fresh("memo with a fresh dependency", call) : identity;
}

function dependenciesIdentity(
  dependencies: readonly ts.Expression[],
  scope: IdentityScope,
): PropIdentity {
  const identities = dependencies.map((dependency) =>
    ts.isSpreadElement(dependency)
      ? unproven("a spread dependency list")
      : scope.evaluate(dependency, scope),
  );
  return (
    identities.find((identity) => identity.kind === "fresh") ??
    identities.find((identity) => identity.kind === "unproven") ??
    STABLE
  );
}
