import { ruleTester } from "../rule-tester.ts";
import { noOptionalFunctionParametersRule } from "./no-optional-function-parameters.ts";

ruleTester.run("no-optional-function-parameters", noOptionalFunctionParametersRule, {
  valid: [
    "function f(a: string | undefined) {}",
    "function f(a = 1) {}",
    "const f = ({ a } = { a: 1 }) => a;",
    "const f = (...rest: number[]) => rest;",
    "interface I { m(a: string): void }",
    "type F = (a: string) => void;",
    "class C { constructor(private readonly a: string) {} }",
  ],
  invalid: [
    { code: "function f(a?: string) {}", errors: [{ messageId: "optionalParameter" }] },
    { code: "const f = (a?: string) => a;", errors: [{ messageId: "optionalParameter" }] },
    {
      code: "const f = function (a?: string) { return a; };",
      errors: [{ messageId: "optionalParameter" }],
    },
    { code: "function f({ a }?: { a: number }) {}", errors: [{ messageId: "optionalParameter" }] },
    { code: "function f(a: string, b?: number, c?: boolean) {}", errors: 2 },
    { code: "type F = (a?: string) => void;", errors: [{ messageId: "optionalParameter" }] },
    { code: "interface I { m(a?: string): void }", errors: [{ messageId: "optionalParameter" }] },
    { code: "interface I { (a?: string): void }", errors: [{ messageId: "optionalParameter" }] },
    { code: "declare function f(a?: string): void;", errors: [{ messageId: "optionalParameter" }] },
    {
      code: "class C { constructor(private readonly a?: string) {} }",
      errors: [{ messageId: "optionalParameter" }],
    },
    {
      code: "class C { m(a?: string) { return a; } }",
      errors: [{ messageId: "optionalParameter" }],
    },
  ],
});
