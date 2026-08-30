import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const BANNED_TARGETS = new Map<ESTree.TSType["type"], string>([
  ["TSAnyKeyword", "any"],
  ["TSNeverKeyword", "never"],
  ["TSUnknownKeyword", "unknown"],
]);

export const noBannedTypeAssertionsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow assertions to `any`, `never`, or `unknown`; they erase the type checker's knowledge instead of correcting the type.",
    },
    messages: {
      bannedAssertion:
        "Do not assert to `{{target}}`. Fix the source type, use a generic, or validate the value at its boundary.",
    },
  },
  createOnce(context) {
    const checkAssertion = (node: ESTree.TSAsExpression | ESTree.TSTypeAssertion) => {
      const target = BANNED_TARGETS.get(node.typeAnnotation.type);
      if (target === undefined) return;
      context.report({ node, messageId: "bannedAssertion", data: { target } });
    };

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
});
