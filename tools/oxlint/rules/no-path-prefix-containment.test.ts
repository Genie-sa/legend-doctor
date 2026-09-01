import { ruleTester } from "../rule-tester.ts";
import { noPathPrefixContainmentRule } from "./no-path-prefix-containment.ts";

ruleTester.run("no-path-prefix-containment", noPathPrefixContainmentRule, {
  valid: [
    {
      code: "import path from 'node:path';\nexport const inside = (root: string, input: string) => path.resolve(root, input).startsWith(`${root}${path.sep}`);",
      name: "a separator-terminated prefix is boundary-aware",
    },
    {
      code: "import path from 'node:path';\nexport const inside = (root: string, input: string) => {\n  const rel = path.relative(root, path.resolve(root, input));\n  return rel !== '' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);\n};",
      name: "the sanctioned path.relative idiom",
    },
    {
      code: "export const inside = (root: string, input: string) => input.startsWith(root);",
      name: "a plain string prefix check is not a containment claim",
    },
    {
      code: "const path = { resolve: (a: string, b: string) => a + b };\nexport const inside = (root: string, input: string) => path.resolve(root, input).startsWith(root);",
      name: "a same-named local object does not impersonate node:path",
    },
    {
      code: "const resolve = (a: string, b: string) => a + b;\nexport const inside = (root: string, input: string) => resolve(root, input).startsWith(root);",
      name: "a same-named local function does not impersonate node:path",
    },
    {
      code: "import path from 'node:path';\nexport const inside = (root: string, input: string) => path.resolve(root, input).startsWith(root + path.sep);",
      name: "concatenating the separator also closes the boundary",
    },
    {
      code: "import path from 'node:path';\nexport const inScope = (input: string) => path.resolve(input).startsWith('/safe/root/');",
      name: "a literal prefix ending in a separator is boundary-aware",
    },
    {
      code: "import path from 'node:path';\nexport const named = (root: string) => path.basename(root).startsWith(root);",
      name: "basename does not build a path prefix",
    },
  ],
  invalid: [
    {
      code: "import path from 'node:path';\nexport const inside = (root: string, input: string) => path.resolve(root, input).startsWith(root);",
      errors: [{ messageId: "prefixContainment" }],
    },
    {
      code: "import { normalize } from 'node:path';\nexport const inside = (root: string, c: string) => normalize(c).startsWith(normalize(root));",
      name: "named imports carry the same provenance",
      errors: [{ messageId: "prefixContainment" }],
    },
    {
      code: "import * as path from 'node:path';\nexport const inside = (root: string, input: string) => {\n  const resolved = path.join(root, input);\n  return resolved.startsWith(root);\n};",
      name: "one hop through a variable does not launder the check",
      errors: [{ messageId: "prefixContainment" }],
    },
    {
      code: "import path from 'path';\nexport const inside = (root: string, input: string) => path.resolve(root, input).startsWith('/safe/root');",
      name: "a literal prefix without a trailing separator still accepts siblings",
      errors: [{ messageId: "prefixContainment" }],
    },
  ],
});
