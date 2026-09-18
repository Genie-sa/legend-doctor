import { bindingDeclarationCount, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import type { ObservableReadScan } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { hasPlainOwnerParameters } from "./owner-parameter-work.js";
import { hasStableSourceBinding } from "./independent-subscription-bindings.js";
import { stableClassEvaluation } from "./owner-class-evaluation.js";
import ts from "typescript";
import { visitSkippingNestedRuntimeFunctions } from "../../core/ast.js";

/** Reuse source-proven class wrappers, but never classify their argument evaluation as opaque. */
export function ownerClassProjectionCalls(
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): ReadonlySet<ts.Node> {
  const bindings = scan.childContracts?.pureProjectionBindings() ?? new Set<string>();
  const calls = new Set<ts.Node>();
  if (!owner.body || !hasPlainOwnerParameters(owner)) {
    return calls;
  }
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      bindings.has(node.expression.text) &&
      hasStableSourceBinding(node.expression) &&
      bindingDeclarationCount(owner, node.expression.text) === 0 &&
      !node.questionDotToken &&
      node.arguments.every(
        (argument) =>
          primitiveClassArgument(argument) && stableClassEvaluation(argument, { owner, scan }),
      )
    ) {
      calls.add(node);
    }
  });
  return calls;
}

/** Primitive results cannot hide getters/iterators inside clsx's object/array traversal. */
function primitiveClassArgument(expression: ts.Expression): boolean {
  const value = unwrapTransparentExpression(expression);
  if (
    ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(
      value.kind,
    )
  ) {
    return true;
  }
  if (ts.isPrefixUnaryExpression(value)) {
    return value.operator === ts.SyntaxKind.ExclamationToken;
  }
  if (ts.isConditionalExpression(value)) {
    return primitiveClassArgument(value.whenTrue) && primitiveClassArgument(value.whenFalse);
  }
  // A falsy left-hand value is necessarily primitive. The right-hand value must be primitive too.
  return (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
    primitiveClassArgument(value.right)
  );
}
