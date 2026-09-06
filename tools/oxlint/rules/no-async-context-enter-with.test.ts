import { ruleTester } from "../rule-tester.ts";
import { noAsyncContextEnterWithRule } from "./no-async-context-enter-with.ts";

ruleTester.run("no-async-context-enter-with", noAsyncContextEnterWithRule, {
  valid: [
    "import { AsyncLocalStorage } from 'node:async_hooks';\nconst als = new AsyncLocalStorage<number>();\nexport const scoped = (fn: () => void) => als.run(1, fn);",
    {
      code: "export const read = (als: { getStore: () => number | undefined }) => als.getStore();",
      name: "reads of the current store are untouched",
    },
    {
      code: "export const dynamic = (als: Record<string, () => void>) => als['enterWith']();",
      name: "a computed member is not the API this rule names",
    },
  ],
  invalid: [
    {
      code: "import { AsyncLocalStorage } from 'node:async_hooks';\nconst als = new AsyncLocalStorage<number>();\nexport const leak = () => als.enterWith(1);",
      errors: [{ messageId: "enterWith" }],
    },
    {
      code: "export const leak = (store: { enterWith: (v: number) => void }) => store?.enterWith(1);",
      name: "optional chaining does not hide the call",
      errors: [{ messageId: "enterWith" }],
    },
    {
      code: "export const leak = (self: { als: { enterWith: (v: number) => void } }) => self.als.enterWith(1);",
      name: "nested receivers still report once",
      errors: [{ messageId: "enterWith" }],
    },
  ],
});
