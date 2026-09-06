import { ruleTester } from "../rule-tester.ts";
import { noPartialRecordSatisfiesRule } from "./no-partial-record-satisfies.ts";

ruleTester.run("no-partial-record-satisfies", noPartialRecordSatisfiesRule, {
  valid: [
    "type Kind = 'a' | 'b';\nexport const total = { a: 1, b: 2 } as const satisfies Record<Kind, number>;",
    "type Kind = 'a' | 'b';\nexport const overrides = (o: Partial<Record<Kind, number>>) => o;",
    "type Kind = 'a' | 'b';\nexport const sparse: Partial<Record<Kind, number>> = { a: 1 };",
    {
      code: "type Kind = 'a' | 'b';\nexport const partialOfSomethingElse = { a: 1 } satisfies Partial<{ a: number }>;",
      name: "`Partial` over a literal type is not the total-map contract this rule protects",
    },
    {
      code: "type Kind = 'a' | 'b';\ndeclare const build: () => Partial<Record<Kind, number>>;\nexport const built = build() satisfies Partial<Record<Kind, number>>;",
      name: "only literals are checked; a call result has no keys to enumerate here",
    },
  ],
  invalid: [
    {
      code: "type Kind = 'a' | 'b';\nexport const partial = { a: 1 } satisfies Partial<Record<Kind, number>>;",
      errors: [{ messageId: "partialRecordSatisfies" }],
    },
    {
      code: "type Kind = 'a' | 'b';\nexport const partial = { a: 1 } as const satisfies Readonly<Partial<Record<Kind, number>>>;",
      errors: [{ messageId: "partialRecordSatisfies" }],
    },
    {
      code: "type Kind = 'a' | 'b';\nexport const partial = { a: 1 } satisfies readonly [] | Partial<Record<Kind, number>>;",
      name: "a union member carrying the partial map is still the partial map",
      errors: [{ messageId: "partialRecordSatisfies" }],
    },
    {
      code: "type Kind = 'a' | 'b';\nexport const partial = ({ a: 1 }) satisfies Partial<Record<Kind, number>>;",
      name: "parentheses around the literal change nothing",
      errors: [{ messageId: "partialRecordSatisfies" }],
    },
  ],
});
