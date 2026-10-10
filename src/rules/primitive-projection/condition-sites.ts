import { LOGICAL_OPERATORS, isNegation, positionUse } from "./truthiness-sites.js";
import {
  bindingDeclarationCount,
  outermostTransparentParent,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import {
  containsReference,
  derivedValue,
  isComparison,
  isPureCondition,
} from "./condition-reads.js";
import { sourceDomainValues, truthinessDomain } from "./value-domains.js";
import type { ConditionScope } from "./condition-reads.js";
import type { RawSubscription } from "./projection-subscriptions.js";
import type { ValueSource } from "./value-domains.js";
import { isBooleanExpression } from "../literal-boolean-leaf/boolean-setters.js";
import { ownerLevelReferences } from "../../core/scope-references.js";
import ts from "typescript";

type References = [ts.Identifier, ...ts.Identifier[]];

/** One boolean the owner derives from the raw value and render-stable operands. */
export interface ConditionSite {
  /** The expression the selector computes and its binding replaces. */
  readonly condition: ts.Expression;
  /** The condition is only truthiness-tested, so the selector coerces it with `!!`. */
  readonly coerced: boolean;
  readonly references: Readonly<References>;
}

/**
 * Every owner read of the raw value sits inside a boolean condition built from comparisons,
 * read-only built-in predicates, declared data members, and `length` or `size`, whose other
 * operands are fixed for the render. The render then depends on the value only through those
 * booleans, and an inline selector computes each one from the value the render would read.
 */
export function conditionSites(
  raw: RawSubscription,
  source: ValueSource,
): readonly [ConditionSite, ...ConditionSite[]] | null {
  const { owner } = raw.owner;
  const { name } = raw.declaration;
  if (bindingDeclarationCount(owner, name.text) !== 1) {
    return null;
  }
  const references = ownerLevelReferences(owner, name);
  const scope: ConditionScope = { raw, references: new Set(references), source };
  const conditions = referencesByCondition(references, scope);
  const sites = [...(conditions ?? [])].map(([condition, reads]) =>
    provenSite(condition, reads, scope),
  );
  const [first, ...rest] = sites;
  return conditions && first && rest.every((site) => site !== null) ? [first, ...rest] : null;
}

function referencesByCondition(
  references: readonly ts.Identifier[],
  scope: ConditionScope,
): ReadonlyMap<ts.Expression, References> | null {
  const conditions = new Map<ts.Expression, References>();
  for (const reference of references) {
    const condition = enclosingCondition(reference, scope);
    if (!condition) {
      return null;
    }
    const reads = conditions.get(condition);
    if (reads) {
      reads.push(reference);
    } else {
      conditions.set(condition, [reference]);
    }
  }
  return conditions;
}

function provenSite(
  condition: ts.Expression,
  references: References,
  scope: ConditionScope,
): ConditionSite | null {
  const coerced = !isBooleanValued(condition);
  return isPureCondition(condition, condition, scope) &&
    (!coerced || keepsOnlyTruthiness(condition, scope))
    ? { coerced, condition, references }
    : null;
}

/**
 * A test keeps only truthiness. A falsy value handed to JSX renders nothing, as `false` does,
 * unless it can be `0`, `NaN`, `""`, or `0n`, which JSX renders as text.
 */
function keepsOnlyTruthiness(condition: ts.Expression, scope: ConditionScope): boolean {
  const use = positionUse(condition);
  if (use !== "falsy-render") {
    return use === "test";
  }
  const source = derivedValue(condition, condition, scope)?.source;
  const domain = truthinessDomain(source ? sourceDomainValues(source) : null);
  return domain !== null && !domain.rendersFalsyValue;
}

/**
 * The largest expression around `reference` that is still one condition over the raw value: the
 * comparison, predicate call, or truthiness test that consumes its derived value, joined by `&&`
 * or `||` with sibling conditions that read the raw value too.
 */
function enclosingCondition(reference: ts.Identifier, scope: ConditionScope): ts.Expression | null {
  let condition = consumingCondition(derivedChainTop(reference));
  let joined = condition && joinedCondition(condition, scope);
  while (joined) {
    condition = joined;
    joined = joinedCondition(joined, scope);
  }
  return condition;
}

/** `raw.member.length` up to the receiver of a method call or the first non-member parent. */
function derivedChainTop(reference: ts.Identifier): ts.Expression {
  let current = outermostTransparentParent(reference);
  while (ts.isPropertyAccessExpression(current.parent) && !methodCall(current.parent)) {
    current = outermostTransparentParent(current.parent);
  }
  return current;
}

function consumingCondition(derived: ts.Expression): ts.Expression | null {
  const consumer = derived.parent;
  if (ts.isPropertyAccessExpression(consumer)) {
    return methodCall(consumer);
  }
  return ts.isBinaryExpression(consumer) && isComparison(consumer.operatorToken.kind)
    ? consumer
    : derived;
}

/** The call `access` is the callee of. */
function methodCall(access: ts.PropertyAccessExpression): ts.CallExpression | null {
  const call = outermostTransparentParent(access).parent;
  return ts.isCallExpression(call) && unwrapTransparentExpression(call.expression) === access
    ? call
    : null;
}

/** The `&&`/`||` that joins `condition`, possibly negated, with a sibling that reads the raw value. */
function joinedCondition(condition: ts.Expression, scope: ConditionScope): ts.Expression | null {
  let operand = outermostTransparentParent(condition);
  if (isNegation(operand.parent)) {
    operand = outermostTransparentParent(operand.parent);
  }
  const logical = operand.parent;
  if (!ts.isBinaryExpression(logical) || !LOGICAL_OPERATORS.has(logical.operatorToken.kind)) {
    return null;
  }
  const sibling = logical.left === operand ? logical.right : logical.left;
  return containsReference(sibling, scope.references) ? logical : null;
}

/** A comparison, negation, or predicate call, or `&&`/`||` joining two of them. */
function isBooleanValued(expression: ts.Expression): boolean {
  const node = unwrapTransparentExpression(expression);
  return ts.isBinaryExpression(node) && LOGICAL_OPERATORS.has(node.operatorToken.kind)
    ? isBooleanValued(node.left) && isBooleanValued(node.right)
    : ts.isCallExpression(node) || isBooleanExpression(node);
}
