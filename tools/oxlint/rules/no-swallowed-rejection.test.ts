import { ruleTester } from "../rule-tester.ts";
import { noSwallowedRejectionRule } from "./no-swallowed-rejection.ts";

ruleTester.run("no-swallowed-rejection", noSwallowedRejectionRule, {
  valid: [
    "export const go = (p: Promise<number>) => p.catch((error: unknown) => { report(error); return 0; });\ndeclare const report: (error: unknown) => void;",
    "export const detail = (r: Response) => r.text().catch(() => '');",
    "export const stop = (r: ReadableStreamDefaultReader<Uint8Array>) => r.cancel().catch(() => undefined);",
    {
      code: "export const go = (p: Promise<number>) => p.catch(handle);\ndeclare const handle: (error: unknown) => number;",
      name: "a named handler is opaque here and is left to its own definition",
    },
    {
      code: "export const go = (p: Promise<number>) => p.catch((error: unknown) => { throw new Error('boom', { cause: error }); });",
      name: "rethrowing is not swallowing",
    },
    {
      code: "export const go = (p: Promise<number>) => p.catch(function (error: unknown) { report(error); return 0; });\ndeclare const report: (error: unknown) => void;",
      name: "function expressions that do work are fine",
    },
  ],
  invalid: [
    {
      code: "export const go = (p: Promise<number>) => p.catch(() => null);",
      errors: [{ messageId: "swallowedRejection" }],
    },
    {
      code: "export const go = (p: Promise<number>) => p.catch(() => undefined);",
      errors: [{ messageId: "swallowedRejection" }],
    },
    {
      code: "export const go = (p: Promise<number>) => p.catch(() => {});",
      errors: [{ messageId: "swallowedRejection" }],
    },
    {
      code: "export const go = (p: Promise<number>) => p.catch(() => { return 0; });",
      errors: [{ messageId: "swallowedRejection" }],
    },
    {
      code: "export const go = (p: Promise<number>) => p.catch(function () { return; });",
      name: "a bare return in a function expression swallows just the same",
      errors: [{ messageId: "swallowedRejection" }],
    },
    {
      code: "export const go = (r: Response) => r.json().catch(() => null);",
      name: "only `text` and `cancel` rejections are considered contentless",
      errors: [{ messageId: "swallowedRejection" }],
    },
    {
      code: "export const go = (p: Promise<number>) => p.catch(() => void 0);",
      name: "`void 0` is the same nothing as `undefined`",
      errors: [{ messageId: "swallowedRejection" }],
    },
  ],
});
