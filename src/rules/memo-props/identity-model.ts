import { propertyNameText, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import type { LexicalBinding } from "../../core/lexical-bindings.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import ts from "typescript";

/** What a render allocates anew each time it runs. */
export type FreshAllocation =
  | "array"
  | "children list"
  | "element"
  | "function"
  | "instance"
  | "memo with a fresh dependency"
  | "memo without dependencies"
  | "object"
  | "regular expression";

/** Whether a value keeps its identity across a render that changes none of its inputs. */
export type PropIdentity =
  | { readonly kind: "fresh"; readonly allocation: FreshAllocation; readonly origin: ts.Node }
  | { readonly kind: "stable" }
  | { readonly kind: "unproven"; readonly reason: string };

export type FreshIdentity = Extract<PropIdentity, { kind: "fresh" }>;

/** The source declaration of a project hook a call invokes, or null when it has none in view. */
export type HookResolver = (call: ts.CallExpression) => RuntimeFunctionLike | null;

/** The render scope an expression is evaluated in. */
export interface IdentityContext {
  readonly owner: RuntimeFunctionLike;
  readonly resolveHook: HookResolver;
}

/** A destructured binding's position in the value it reads. */
export type BindingMember =
  | { readonly kind: "index"; readonly index: number }
  | { readonly kind: "property"; readonly key: string };

/** A local name and the pattern that binds it. */
export interface NamedBinding {
  readonly name: string;
  readonly pattern: ts.BindingName;
}

/** A hook parameter's identity, taken from the argument its caller passes. */
export type ParameterIdentity = (parameter: ts.ParameterDeclaration, name: string) => PropIdentity;

export interface IdentityScope {
  readonly depth: number;
  /** Evaluates an expression in a scope, so hook analysis can recurse into any render scope. */
  readonly evaluate: (expression: ts.Expression, scope: IdentityScope) => PropIdentity;
  readonly owner: RuntimeFunctionLike;
  /** Present inside a project hook, where each parameter carries its caller's argument. */
  readonly parameters: ParameterIdentity | null;
  readonly resolveHook: HookResolver;
  /** Declarations under evaluation, so a cycle through memo dependencies stays unproven. */
  readonly visiting: ReadonlySet<ts.Node>;
}

export const STABLE: PropIdentity = { kind: "stable" };

/** Binary operators whose result is a primitive computed from the operands' values. */
export const PRIMITIVE_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.InKeyword,
  ts.SyntaxKind.InstanceOfKeyword,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.SlashToken,
]);

const ALLOCATIONS: readonly (readonly [(node: ts.Node) => boolean, FreshAllocation])[] = [
  [ts.isObjectLiteralExpression, "object"],
  [ts.isArrayLiteralExpression, "array"],
  [ts.isArrowFunction, "function"],
  [ts.isFunctionExpression, "function"],
  [ts.isJsxElement, "element"],
  [ts.isJsxSelfClosingElement, "element"],
  [ts.isJsxFragment, "element"],
  [ts.isNewExpression, "instance"],
  [ts.isClassExpression, "instance"],
  [ts.isRegularExpressionLiteral, "regular expression"],
];

export function unproven(reason: string): PropIdentity {
  return { kind: "unproven", reason };
}

export function fresh(allocation: FreshAllocation, origin: ts.Node): PropIdentity {
  return { allocation, kind: "fresh", origin };
}

/** Reading from or operating on a fresh value is not itself a proven allocation. */
export function settled(identity: PropIdentity): PropIdentity {
  return identity.kind === "fresh" ? unproven("a value read from a fresh allocation") : identity;
}

/** A value that is one of two operands: fresh only when both are, stable only when both are. */
export function eitherIdentity(first: PropIdentity, second: PropIdentity): PropIdentity {
  if (first.kind === "unproven") {
    return first;
  }
  if (second.kind === "unproven" || first.kind === second.kind) {
    return second;
  }
  return unproven("a value that is fresh on only one branch");
}

export function freshAllocation(value: ts.Expression): FreshAllocation | null {
  return ALLOCATIONS.find(([matches]) => matches(value))?.[1] ?? null;
}

export function isPrimitiveLiteral(value: ts.Expression): boolean {
  return (
    ts.isStringLiteral(value) ||
    ts.isNumericLiteral(value) ||
    ts.isBigIntLiteral(value) ||
    ts.isNoSubstitutionTemplateLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword
  );
}

export function bindingDeclaration(binding: LexicalBinding | null): ts.Node | null {
  return binding?.kind === "function" || binding?.kind === "value" ? binding.declaration : null;
}

/** Where a top-level destructured name reads from, or null for a nested or rest pattern. */
export function bindingMember(pattern: ts.BindingName, name: string): BindingMember | null {
  if (ts.isIdentifier(pattern)) {
    return null;
  }
  const elements: readonly ts.ArrayBindingElement[] = pattern.elements;
  const index = elements.findIndex((element) => bindsDirectly(element, name));
  const element = elements[index];
  if (!element || ts.isOmittedExpression(element) || element.dotDotDotToken) {
    return null;
  }
  return ts.isArrayBindingPattern(pattern)
    ? { index, kind: "index" }
    : propertyMember(element, name);
}

function propertyMember(element: ts.BindingElement, name: string): BindingMember | null {
  const key = element.propertyName ? propertyNameText(element.propertyName) : name;
  return key === null ? null : { key, kind: "property" };
}

/** A destructured value keeps its identity on an owner-only render unless a default allocates it. */
export function defaultedBindingIdentity(
  binding: NamedBinding,
  initializer?: ts.Expression,
): PropIdentity {
  const element = bindingElementNamed(binding.pattern, binding.name);
  const fallback = element ? element.initializer : initializer;
  return fallback && !isPrimitiveLiteral(unwrapTransparentExpression(fallback))
    ? unproven("a default that allocates whenever the value is missing")
    : STABLE;
}

function bindsDirectly(element: ts.ArrayBindingElement, name: string): boolean {
  return (
    !ts.isOmittedExpression(element) && ts.isIdentifier(element.name) && element.name.text === name
  );
}

function bindingElementNamed(pattern: ts.BindingName, name: string): ts.BindingElement | null {
  if (ts.isIdentifier(pattern)) {
    return null;
  }
  const elements: readonly ts.ArrayBindingElement[] = pattern.elements;
  for (const element of elements) {
    const match = ts.isOmittedExpression(element) ? null : elementNamed(element, name);
    if (match) {
      return match;
    }
  }
  return null;
}

function elementNamed(element: ts.BindingElement, name: string): ts.BindingElement | null {
  if (!ts.isIdentifier(element.name)) {
    return bindingElementNamed(element.name, name);
  }
  return element.name.text === name ? element : null;
}
