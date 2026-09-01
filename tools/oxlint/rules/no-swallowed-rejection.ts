import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/** Rejections from these calls carry no information the caller can act on. */
const DISCARDABLE_RECEIVERS = new Set(["cancel", "text"]);

const staticPropertyName = (expression: ESTree.Expression): string | null =>
  expression.type === "MemberExpression" &&
  !expression.computed &&
  expression.property.type === "Identifier"
    ? expression.property.name
    : null;

const isDiscardableReceiver = (receiver: ESTree.Expression): boolean =>
  receiver.type === "CallExpression" &&
  DISCARDABLE_RECEIVERS.has(staticPropertyName(receiver.callee) ?? "");

const isConstantValue = (expression: ESTree.Expression): boolean =>
  expression.type === "Literal" ||
  (expression.type === "Identifier" && expression.name === "undefined") ||
  (expression.type === "UnaryExpression" &&
    expression.operator === "void" &&
    isConstantValue(expression.argument));

const isConstantNothing = (body: ESTree.FunctionBody | ESTree.Expression): boolean => {
  if (body.type !== "BlockStatement") return isConstantValue(body);
  const [statement, ...rest] = body.body;
  if (statement === undefined) return true;
  if (rest.length > 0 || statement.type !== "ReturnStatement") return false;
  return statement.argument === null || isConstantValue(statement.argument);
};

const isSwallowingHandler = (argument: ESTree.Argument): boolean => {
  if (argument.type === "ArrowFunctionExpression") return isConstantNothing(argument.body);
  if (argument.type !== "FunctionExpression" || argument.body === null) return false;
  return isConstantNothing(argument.body);
};

export const noSwallowedRejectionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `.catch()` handlers whose body is a constant; they erase the rejection instead of handling it, leaving the failure invisible at runtime.",
    },
    messages: {
      swallowedRejection:
        "This `.catch` handler discards the rejection. Report or log the error, translate it into a typed failure result, or let it propagate to a caller that can act on it.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (staticPropertyName(node.callee) !== "catch") return;
        if (node.callee.type !== "MemberExpression") return;
        if (isDiscardableReceiver(node.callee.object)) return;
        const [handler, ...rest] = node.arguments;
        if (handler === undefined || rest.length > 0 || !isSwallowingHandler(handler)) return;
        context.report({ node: handler, messageId: "swallowedRejection" });
      },
    };
  },
});
