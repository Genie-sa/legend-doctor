import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const DISABLE_DIRECTIVE = /^\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?\b/u;
const DIRECTIVE_JUSTIFICATION = /\s--\s*(?<reason>\S.*)$/su;
const SAFETY_COMMENT = /\bSAFETY\s*:\s*\S/u;
const FOREIGN_DIRECTIVE = /^\s*(?:biome-ignore|prettier-ignore)\b/u;

const isJustified = (comment: ESTree.Comment, previous: ESTree.Comment | undefined): boolean => {
  if (DIRECTIVE_JUSTIFICATION.test(comment.value)) return true;
  // A `SAFETY:` note only counts when it sits on the line directly above the directive.
  return (
    previous !== undefined &&
    previous.loc.end.line === comment.loc.start.line - 1 &&
    SAFETY_COMMENT.test(previous.value)
  );
};

export const requireDescriptionRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Require every lint suppression directive to state why the rule is wrong here, so the suppression can be re-judged later.",
    },
    messages: {
      missingDescription:
        "This disable directive has no justification. Append ` -- why the rule is wrong here`, or put a `// SAFETY: …` comment on the line directly above.",
    },
  },
  createOnce(context) {
    return {
      Program() {
        const comments = context.sourceCode.getAllComments();
        comments.forEach((comment, index) => {
          if (!DISABLE_DIRECTIVE.test(comment.value)) return;
          if (isJustified(comment, comments[index - 1])) return;
          context.report({ node: comment, messageId: "missingDescription" });
        });
      },
    };
  },
});

export const noForeignDirectiveRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow suppression comments aimed at tools this repository does not run; they read as active suppressions but do nothing.",
    },
    messages: {
      foreignDirective:
        "This directive targets a tool this repository does not run, so it suppresses nothing. Delete it, or express the intent with an `oxlint-disable-next-line <rule> -- reason` comment.",
    },
  },
  createOnce(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (!FOREIGN_DIRECTIVE.test(comment.value)) continue;
          context.report({ node: comment, messageId: "foreignDirective" });
        }
      },
    };
  },
});
