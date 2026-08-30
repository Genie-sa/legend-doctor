import { ruleTester } from "../rule-tester.ts";
import { noInOperatorRule } from "./no-in-operator.ts";

ruleTester.run("no-in-operator", noInOperatorRule, {
  valid: [
    "const has = Object.hasOwn(record, key);",
    "for (const key in record) { use(key); }",
    "const sum = left + right;",
  ],
  invalid: [
    { code: 'const has = "key" in record;', errors: [{ messageId: "inOperator" }] },
    { code: "if (key in record) { use(record); }", errors: [{ messageId: "inOperator" }] },
    {
      code: "class Brand { #tag = 1; static is(value: object) { return #tag in value; } }",
      name: "private brand checks are `in` too and stay banned",
      errors: [{ messageId: "inOperator" }],
    },
  ],
});
