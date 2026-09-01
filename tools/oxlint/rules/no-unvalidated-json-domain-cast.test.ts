import { ruleTester } from "../rule-tester.ts";
import { noUnvalidatedJsonDomainCastRule } from "./no-unvalidated-json-domain-cast.ts";

ruleTester.run("no-unvalidated-json-domain-cast", noUnvalidatedJsonDomainCastRule, {
  valid: [
    {
      code: "export const read = (raw: string): unknown => JSON.parse(raw);",
      filename: "src/a.ts",
      name: "returning the parse result as unknown keeps the obligation visible",
    },
    {
      code: "type Company = { id: string };\nexport const read = (raw: string): Company => parse(JSON.parse(raw));\ndeclare const parse: (value: unknown) => Company;",
      filename: "src/a.ts",
      name: "a validator between the parser and the domain type",
    },
    {
      code: "type Company = { id: string };\nexport const read = (raw: string) => JSON.parse(raw) as Company;",
      filename: "tests/a.test.ts",
      name: "tests are outside the production boundary",
    },
    {
      code: "type Company = { id: string };\nexport const read = (raw: string) => JSON.parse(raw) as Company;",
      filename: "scripts/a.ts",
      name: "scripts are outside the production boundary",
    },
    {
      code: "type Company = { id: string };\nexport const read = (raw: string) => JSON.parse(raw) as Company;",
      filename: "src/a.spec.ts",
      name: "a spec file is exempt by name",
    },
    {
      code: "export const read = (raw: string) => JSON.parse(raw) as unknown;",
      filename: "src/a.ts",
      name: "asserting back to unknown commits to nothing",
    },
    {
      code: "type Company = { id: string };\nexport const read = (value: Company) => value as Company;",
      filename: "src/a.ts",
      name: "a cast of a value that never came from JSON",
    },
    {
      code: "export const version = (raw: string): string => {\n  const parsed: unknown = JSON.parse(raw);\n  return String(parsed);\n};",
      filename: "src/a.ts",
      name: "a typed return that never passes through a cast",
    },
    {
      code: "const JSON = { parse: (raw: string) => ({ id: raw }) };\ntype Company = { id: string };\nexport const read = (raw: string) => JSON.parse(raw) as Company;",
      filename: "src/a.ts",
      name: "a shadowed JSON is not the global parser",
    },
  ],
  invalid: [
    {
      code: "type Company = { id: string };\nexport const read = (raw: string) => JSON.parse(raw) as Company;",
      filename: "src/a.ts",
      errors: [{ messageId: "unvalidatedCast" }],
    },
    {
      code: "type Company = { id: string };\nexport const read = async (r: Response) => (await r.json()) as Company;",
      filename: "src/a.ts",
      name: "an awaited Response body is the same untrusted input",
      errors: [{ messageId: "unvalidatedCast" }],
    },
    {
      code: "type Company = { id: string };\nexport const read = (raw: string): Company => {\n  const payload: unknown = JSON.parse(raw);\n  return payload as Company;\n};",
      filename: "src/a.ts",
      name: "laundering through an intermediate binding",
      errors: [{ messageId: "unvalidatedCast" }],
    },
    {
      code: "export const version = (raw: string): string => {\n  const { v } = JSON.parse(raw) as { v: string };\n  return v;\n};",
      filename: "src/a.ts",
      name: "the cast and the typed return it feeds are both unproven",
      errors: [{ messageId: "unvalidatedCast" }, { messageId: "unvalidatedReturn" }],
    },
    {
      code: "type Company = { id: string };\nexport function read(raw: string): Company {\n  return JSON.parse(raw) as Company;\n}",
      filename: "/repo/src/nested/deep.ts",
      name: "an absolute production path outside tests and scripts",
      errors: [{ messageId: "unvalidatedCast" }],
    },
  ],
});
