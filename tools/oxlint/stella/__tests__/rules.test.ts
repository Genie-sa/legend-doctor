// RuleTester coverage for the vendored stella rules.
//
// Every rule ID enabled in .oxlintrc.json gets at least one genuinely
// triggering invalid case and one valid case, so a rule that reports zero
// violations against src/ is demonstrably live rather than silently dead.
//
// Run: node tools/oxlint/stella/__tests__/rules.test.ts

import { RuleTester } from "oxlint/plugins-dev";

import stellaPlugin from "../index.ts";

const ruleFor = (name: string) => {
  const rule = stellaPlugin.rules?.[name];
  if (rule === undefined) {
    throw new Error(`rule not registered in index.ts: ${name}`);
  }
  return rule;
};

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

const run = (name: string, tests: Parameters<RuleTester["run"]>[2]) => {
  tester.run(name, ruleFor(name), tests);
};

run("no-ambient-nondeterminism", {
  valid: [
    "export const stamp = (now: number): number => now;",
    "const Date = { now: () => 0 };\nexport const stamp = () => Date.now();",
    "export const explicit = () => new Date(0);",
  ],
  invalid: [
    { code: "export const stamp = () => Date.now();", errors: 1 },
    { code: "export const roll = () => Math.random();", errors: 1 },
    { code: "export const stamp = () => new Date();", errors: 1 },
    { code: "export const tick = () => performance.now();", errors: 1 },
    { code: "export const id = () => crypto.randomUUID();", errors: 1 },
    {
      code: "import { randomUUID } from 'node:crypto';\nexport const id = () => randomUUID();",
      errors: 1,
    },
    {
      code: "export const stamps = (xs: number[]) => xs.map(() => Date.now());",
      errors: 1,
    },
    {
      code: "const now = globalThis.Date.now;\nexport const stamp = () => now();",
      errors: 1,
    },
  ],
});

run("no-async-context-enter-with", {
  valid: [
    "import { AsyncLocalStorage } from 'node:async_hooks';\nconst als = new AsyncLocalStorage<number>();\nexport const scoped = (fn: () => void) => als.run(1, fn);",
  ],
  invalid: [
    {
      code: "import { AsyncLocalStorage } from 'node:async_hooks';\nconst als = new AsyncLocalStorage<number>();\nexport const leak = () => als.enterWith(1);",
      errors: 1,
    },
  ],
});

run("no-partial-record-satisfies", {
  valid: [
    "type Kind = 'a' | 'b';\nexport const total = { a: 1, b: 2 } as const satisfies Record<Kind, number>;",
    "type Kind = 'a' | 'b';\nexport const overrides = (o: Partial<Record<Kind, number>>) => o;",
    "type Kind = 'a' | 'b';\nexport const sparse: Partial<Record<Kind, number>> = { a: 1 };",
  ],
  invalid: [
    {
      code: "type Kind = 'a' | 'b';\nexport const partial = { a: 1 } satisfies Partial<Record<Kind, number>>;",
      errors: 1,
    },
    {
      code: "type Kind = 'a' | 'b';\nexport const partial = { a: 1 } as const satisfies Readonly<Partial<Record<Kind, number>>>;",
      errors: 1,
    },
  ],
});

run("no-path-prefix-containment", {
  valid: [
    // Boundary-aware: separator suffix on the prefix.
    "import path from 'node:path';\nexport const inside = (root: string, input: string) => path.resolve(root, input).startsWith(`${root}${path.sep}`);",
    // The sanctioned relative-path form.
    "import path from 'node:path';\nexport const inside = (root: string, input: string) => {\n  const rel = path.relative(root, path.resolve(root, input));\n  return rel !== '' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);\n};",
    // Not path-derived: provenance gate holds.
    "export const inside = (root: string, input: string) => input.startsWith(root);",
    // Same-named local helper must not impersonate node:path.
    "const path = { resolve: (a: string, b: string) => a + b };\nexport const inside = (root: string, input: string) => path.resolve(root, input).startsWith(root);",
  ],
  invalid: [
    {
      code: "import path from 'node:path';\nexport const inside = (root: string, input: string) => path.resolve(root, input).startsWith(root);",
      errors: 1,
    },
    {
      code: "import { normalize } from 'node:path';\nexport const inside = (root: string, c: string) => normalize(c).startsWith(normalize(root));",
      errors: 1,
    },
  ],
});

run("no-swallowed-rejection", {
  valid: [
    "export const go = (p: Promise<number>) => p.catch((error: unknown) => { report(error); return 0; });\ndeclare const report: (error: unknown) => void;",
    "export const detail = (r: Response) => r.text().catch(() => '');",
    "export const stop = (r: ReadableStreamDefaultReader<Uint8Array>) => r.cancel().catch(() => undefined);",
  ],
  invalid: [
    { code: "export const go = (p: Promise<number>) => p.catch(() => null);", errors: 1 },
    { code: "export const go = (p: Promise<number>) => p.catch(() => undefined);", errors: 1 },
    { code: "export const go = (p: Promise<number>) => p.catch(() => {});", errors: 1 },
    { code: "export const go = (p: Promise<number>) => p.catch(() => { return 0; });", errors: 1 },
  ],
});

run("no-unvalidated-json-domain-cast", {
  valid: [
    { code: "export const read = (raw: string): unknown => JSON.parse(raw);", filename: "src/a.ts" },
    {
      code: "type Company = { id: string };\nexport const read = (raw: string): Company => parse(JSON.parse(raw));\ndeclare const parse: (value: unknown) => Company;",
      filename: "src/a.ts",
    },
    // Tests and scripts are outside the production boundary.
    {
      code: "type Company = { id: string };\nexport const read = (raw: string) => JSON.parse(raw) as Company;",
      filename: "tests/a.test.ts",
    },
    {
      code: "type Company = { id: string };\nexport const read = (raw: string) => JSON.parse(raw) as Company;",
      filename: "scripts/a.ts",
    },
  ],
  invalid: [
    {
      code: "type Company = { id: string };\nexport const read = (raw: string) => JSON.parse(raw) as Company;",
      filename: "src/a.ts",
      errors: 1,
    },
    {
      code: "type Company = { id: string };\nexport const read = async (r: Response) => (await r.json()) as Company;",
      filename: "src/a.ts",
      errors: 1,
    },
    {
      code: "type Company = { id: string };\nexport const read = (raw: string): Company => {\n  const payload: unknown = JSON.parse(raw);\n  return payload as Company;\n};",
      filename: "src/a.ts",
      errors: 1,
    },
    // The typed-function-return path, as it fires at src/cli.ts:193.
    {
      code: "export const version = (raw: string): string => {\n  const { v } = JSON.parse(raw) as { v: string };\n  return v;\n};",
      filename: "src/a.ts",
      errors: 2,
    },
  ],
});

run("require-description", {
  valid: [
    "// oxlint-disable-next-line no-console -- dev-only CLI output\nconsole.log(1);",
    "// SAFETY: value validated above\n// oxlint-disable-next-line no-console\nconsole.log(1);",
    "// a plain comment\nconsole.log(1);",
  ],
  invalid: [
    { code: "// oxlint-disable-next-line no-console\nconsole.log(1);", errors: 1 },
    { code: "/* eslint-disable no-console */\nconsole.log(1);", errors: 1 },
  ],
});

run("no-foreign-directive", {
  valid: ["// oxlint-disable-next-line no-console -- ok\nconsole.log(1);"],
  invalid: [
    { code: "// biome-ignore lint/suspicious/noExplicitAny: x\nexport const a = 1;", errors: 1 },
    { code: "// prettier-ignore\nexport const a = 1;", errors: 1 },
  ],
});

process.stdout.write("stella rule tests: all cases passed\n");
