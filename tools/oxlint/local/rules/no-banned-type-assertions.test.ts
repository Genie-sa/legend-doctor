import { ruleTester } from "../rule-tester.ts";
import { noBannedTypeAssertionsRule } from "./no-banned-type-assertions.ts";

ruleTester.run("no-banned-type-assertions", noBannedTypeAssertionsRule, {
  valid: [
    "const a = value as string;",
    "const a = value as const;",
    "const a = <string>value;",
    "const a: unknown = value;",
    "type Alias = never;",
    "const a = value satisfies unknown;",
  ],
  invalid: [
    {
      code: "const a = value as any;",
      errors: [{ messageId: "bannedAssertion", data: { target: "any" } }],
    },
    {
      code: "const a = value as never;",
      errors: [{ messageId: "bannedAssertion", data: { target: "never" } }],
    },
    {
      code: "const a = value as unknown;",
      errors: [{ messageId: "bannedAssertion", data: { target: "unknown" } }],
    },
    {
      code: "const a = <any>value;",
      errors: [{ messageId: "bannedAssertion", data: { target: "any" } }],
    },
  ],
});
