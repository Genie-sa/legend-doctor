import { defineRule } from "@oxlint/plugins";

export const noInOperatorRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow object key checks with the `in` operator; its result depends on the prototype chain and it widens types instead of proving structure.",
    },
    messages: {
      inOperator:
        "Do not check keys with the `in` operator. Model the structure so the check is unnecessary, or use `Object.hasOwn` / a type-guard predicate at the boundary.",
    },
  },
  createOnce(context) {
    return {
      BinaryExpression(node) {
        if (node.operator === "in") {
          context.report({ node, messageId: "inOperator" });
        }
      },
    };
  },
});
