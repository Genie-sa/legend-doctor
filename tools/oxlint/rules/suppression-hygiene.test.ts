import { ruleTester } from "../rule-tester.ts";
import { noForeignDirectiveRule, requireDescriptionRule } from "./suppression-hygiene.ts";

ruleTester.run("require-description", requireDescriptionRule, {
  valid: [
    "// oxlint-disable-next-line no-console -- dev-only CLI output\nconsole.log(1);",
    "// SAFETY: value validated above\n// oxlint-disable-next-line no-console\nconsole.log(1);",
    "// a plain comment\nconsole.log(1);",
    {
      code: "/* eslint-disable no-console -- the CLI writes to stdout by design */\nconsole.log(1);",
      name: "a block directive can carry the trailer too",
    },
    {
      code: "// oxlint-enable no-console\nconsole.log(1);",
      name: "re-enabling a rule suppresses nothing and needs no defence",
    },
  ],
  invalid: [
    {
      code: "// oxlint-disable-next-line no-console\nconsole.log(1);",
      errors: [{ messageId: "missingDescription" }],
    },
    {
      code: "/* eslint-disable no-console */\nconsole.log(1);",
      errors: [{ messageId: "missingDescription" }],
    },
    {
      code: "// oxlint-disable-next-line no-console --\nconsole.log(1);",
      name: "an empty trailer is not a justification",
      errors: [{ messageId: "missingDescription" }],
    },
    {
      code: "// SAFETY: value validated above\n\n// oxlint-disable-next-line no-console\nconsole.log(1);",
      name: "a SAFETY note a blank line away is no longer attached",
      errors: [{ messageId: "missingDescription" }],
    },
    {
      code: "// oxlint-disable-next-line no-console\nconsole.log(1);\n// oxlint-disable-next-line no-console\nconsole.log(2);",
      name: "each bare directive reports on its own",
      errors: [{ messageId: "missingDescription" }, { messageId: "missingDescription" }],
    },
  ],
});

ruleTester.run("no-foreign-directive", noForeignDirectiveRule, {
  valid: [
    "// oxlint-disable-next-line no-console -- ok\nconsole.log(1);",
    {
      code: "// mentions prettier in prose, which is not a directive\nexport const a = 1;",
      name: "the tool name only matters at the head of the comment",
    },
  ],
  invalid: [
    {
      code: "// biome-ignore lint/suspicious/noExplicitAny: x\nexport const a = 1;",
      errors: [{ messageId: "foreignDirective" }],
    },
    {
      code: "// prettier-ignore\nexport const a = 1;",
      errors: [{ messageId: "foreignDirective" }],
    },
    {
      code: "/* biome-ignore-start lint/style/useConst: x */\nexport const a = 1;",
      name: "range forms of the foreign directive count as well",
      errors: [{ messageId: "foreignDirective" }],
    },
  ],
});
