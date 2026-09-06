import { defineRule } from "@oxlint/plugins";

export const noSwitchRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow switch statements; fallthrough, non-exhaustiveness, and statement-position-only usage make them weaker than expression-based alternatives.",
    },
    messages: {
      switchStatement:
        "Do not use a switch statement. Use a lookup object, a discriminated-union handler map, or an if/else chain that returns a value.",
    },
  },
  createOnce(context) {
    return {
      SwitchStatement(node) {
        context.report({ node, messageId: "switchStatement" });
      },
    };
  },
});
