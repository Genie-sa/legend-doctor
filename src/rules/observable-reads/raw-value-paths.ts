import { RESERVED_OBSERVABLE_MEMBERS, outermostTransparentParent } from "./observable-paths.js";
import { isAssignmentOperator } from "../../core/analysis-ast.js";
import ts from "typescript";

function rawValuePathTerminates(access: ts.PropertyAccessExpression): boolean {
  return RESERVED_OBSERVABLE_MEMBERS.has(access.name.text) || propertyAccessIsExecutable(access);
}

function collectRawValuePath(
  current: ts.Expression,
  path: readonly string[],
): readonly string[] | null {
  const { parent } = current;
  if (ts.isParenthesizedExpression(parent) && parent.expression === current) {
    return collectRawValuePath(parent, path);
  }
  if (
    (ts.isElementAccessExpression(parent) && parent.expression === current) ||
    (ts.isPropertyAccessExpression(parent) &&
      parent.expression === current &&
      propertyAccessIsWritten(parent))
  ) {
    return null;
  }
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== current) {
    return path;
  }
  if (rawValuePathTerminates(parent)) {
    return path;
  }
  return collectRawValuePath(parent, [...path, parent.name.text]);
}

export function staticRawValuePath(reference: ts.Identifier): readonly string[] | null {
  const path = collectRawValuePath(reference, []);
  return path && path.length > 0 ? path : null;
}

export function rawValuePathHasOptionalAccess(reference: ts.Identifier): boolean {
  let current: ts.Expression = reference;
  while (
    (ts.isPropertyAccessExpression(current.parent) ||
      ts.isElementAccessExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    const access = current.parent;
    if (access.questionDotToken) {
      return true;
    }
    current = access;
  }
  return false;
}

interface OptionalSuffixState {
  readonly commonLength: number;
  readonly optional: boolean;
  readonly segments: number;
}

function optionalSuffixIsWholeValue(access: ts.Expression): boolean {
  const outer = outermostTransparentParent(access);
  const { parent } = outer;
  return !(
    ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === outer) ||
    (ts.isCallExpression(parent) && parent.expression === outer) ||
    (ts.isTaggedTemplateExpression(parent) && parent.tag === outer)
  );
}

function optionalSuffixStep(current: ts.Expression, state: OptionalSuffixState): boolean {
  const access = current.parent;
  if (!ts.isPropertyAccessExpression(access) || access.expression !== current) {
    return true;
  }
  if (rawValuePathTerminates(access)) {
    return !state.optional;
  }
  const next: OptionalSuffixState = {
    commonLength: state.commonLength,
    optional: state.optional || Boolean(access.questionDotToken),
    segments: state.segments + 1,
  };
  if (next.segments === next.commonLength && next.optional) {
    return optionalSuffixIsWholeValue(access);
  }
  return optionalSuffixStep(access, next);
}

export function optionalAccessPreservesSuffix(
  reference: ts.Identifier,
  commonLength: number,
): boolean {
  return optionalSuffixStep(reference, { commonLength, optional: false, segments: 0 });
}

export function commonPathPrefix(
  left: readonly string[],
  right: readonly string[],
): readonly string[] {
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) {
    length += 1;
  }
  return left.slice(0, length);
}

function propertyAccessIsExecutable(access: ts.PropertyAccessExpression): boolean {
  const { parent } = access;
  return (
    (ts.isCallExpression(parent) && parent.expression === access) ||
    (ts.isNewExpression(parent) && parent.expression === access) ||
    (ts.isTaggedTemplateExpression(parent) && parent.tag === access)
  );
}

function propertyAccessIsWritten(access: ts.PropertyAccessExpression): boolean {
  const { parent } = access;
  return (
    (ts.isBinaryExpression(parent) &&
      parent.left === access &&
      isAssignmentOperator(parent.operatorToken.kind)) ||
    (ts.isPrefixUnaryExpression(parent) &&
      parent.operand === access &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken)) ||
    (ts.isPostfixUnaryExpression(parent) && parent.operand === access) ||
    (ts.isDeleteExpression(parent) && parent.expression === access)
  );
}
