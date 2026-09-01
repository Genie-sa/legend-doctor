import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const isEnterWithCallee = (callee: ESTree.CallExpression["callee"]): boolean =>
  callee.type === "MemberExpression" &&
  !callee.computed &&
  callee.property.type === "Identifier" &&
  callee.property.name === "enterWith";

export const noAsyncContextEnterWithRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `AsyncLocalStorage.enterWith`; it mutates the current async context for the rest of the tick, so the store leaks into unrelated continuations.",
    },
    messages: {
      enterWith:
        "Do not use `enterWith`. Wrap the work in `als.run(store, callback)` so the store is scoped to that callback and cannot leak into sibling tasks.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (!isEnterWithCallee(node.callee)) return;
        context.report({ node, messageId: "enterWith" });
      },
    };
  },
});
