import { ruleTester } from "../rule-tester.ts";
import { noReexportOnlyModulesRule } from "./no-reexport-only-modules.ts";

ruleTester.run("no-reexport-only-modules", noReexportOnlyModulesRule, {
  valid: [
    { code: 'import "./side-effect.ts";', name: "side-effect-only module re-exports nothing" },
    {
      code: 'import { a } from "./a.ts";\nimport { b } from "./b.ts";\nregister(a, b);',
      name: "import-only module re-exports nothing",
    },
    {
      code: 'import { a } from "./a.ts";\nexport { a };',
      name: "bare local export names no source module",
    },
    "export const a = 1;",
    'export * from "./a.ts";\nexport const b = 2;',
    'import "./setup.ts";\nexport * from "./a.ts";',
    'export { a } from "./a.ts";\nsetup();',
    "\n",
  ],
  invalid: [
    { code: 'export * from "./a.ts";', errors: [{ messageId: "reexportOnly" }] },
    { code: 'export * as ns from "./a.ts";', errors: [{ messageId: "reexportOnly" }] },
    { code: 'export { a } from "./a.ts";', errors: [{ messageId: "reexportOnly" }] },
    { code: 'export type { A } from "./a.ts";', errors: [{ messageId: "reexportOnly" }] },
    {
      code: 'export { a } from "./a.ts";\nexport * from "./b.ts";\nexport type { C } from "./c.ts";',
      errors: [{ messageId: "reexportOnly" }],
    },
  ],
});
