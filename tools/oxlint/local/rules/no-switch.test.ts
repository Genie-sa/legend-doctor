import { ruleTester } from "../rule-tester.ts";
import { noSwitchRule } from "./no-switch.ts";

ruleTester.run("no-switch", noSwitchRule, {
  valid: [
    "const label = kind === 'a' ? 'first' : 'second';",
    "const LABELS = { a: 'first', b: 'second' } as const;",
    "if (kind === 'a') { first(); } else { second(); }",
  ],
  invalid: [
    {
      code: "switch (kind) { case 'a': first(); break; default: second(); }",
      errors: [{ messageId: "switchStatement" }],
    },
    {
      code: "function f(kind: string) { switch (kind) { case 'a': return 1; } return 0; }",
      errors: [{ messageId: "switchStatement" }],
    },
  ],
});
