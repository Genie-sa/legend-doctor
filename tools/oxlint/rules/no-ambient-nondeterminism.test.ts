import { ruleTester } from "../rule-tester.ts";
import { noAmbientNondeterminismRule } from "./no-ambient-nondeterminism.ts";

ruleTester.run("no-ambient-nondeterminism", noAmbientNondeterminismRule, {
  valid: [
    "export const stamp = (now: number): number => now;",
    "const Date = { now: () => 0 };\nexport const stamp = () => Date.now();",
    "export const explicit = () => new Date(0);",
    {
      code: "const performance = { now: () => 0 };\nexport const tick = () => performance.now();",
      name: "a shadowed `performance` is a different value than the global",
    },
    {
      code: "export const parse = (iso: string) => new Date(iso);",
      name: "a Date built from an explicit value is deterministic",
    },
    {
      code: "import { createHash } from 'node:crypto';\nexport const digest = (s: string) => createHash('sha256').update(s).digest('hex');",
      name: "node:crypto imports that are not random are fine",
    },
    {
      code: "export const pick = (xs: number[], index: number) => xs.at(index);",
      name: "unrelated member calls",
    },
  ],
  invalid: [
    {
      code: "export const stamp = () => Date.now();",
      errors: [{ messageId: "ambientNondeterminism", data: { source: "Date.now" } }],
    },
    {
      code: "export const roll = () => Math.random();",
      errors: [{ messageId: "ambientNondeterminism", data: { source: "Math.random" } }],
    },
    {
      code: "export const stamp = () => new Date();",
      errors: [{ messageId: "ambientNondeterminism", data: { source: "new Date()" } }],
    },
    {
      code: "export const tick = () => performance.now();",
      errors: [{ messageId: "ambientNondeterminism", data: { source: "performance.now" } }],
    },
    {
      code: "export const id = () => crypto.randomUUID();",
      errors: [{ messageId: "ambientNondeterminism", data: { source: "crypto.randomUUID" } }],
    },
    {
      code: "import { randomUUID } from 'node:crypto';\nexport const id = () => randomUUID();",
      errors: [{ messageId: "ambientNondeterminism", data: { source: "randomUUID()" } }],
    },
    {
      code: "export const stamps = (xs: number[]) => xs.map(() => Date.now());",
      name: "nondeterminism hidden inside a callback",
      errors: [{ messageId: "ambientNondeterminism", data: { source: "Date.now" } }],
    },
    {
      code: "const now = globalThis.Date.now;\nexport const stamp = () => now();",
      name: "an alias of the ambient accessor is reported once, at the call",
      errors: [{ messageId: "ambientNondeterminism", data: { source: "Date.now" } }],
    },
    {
      code: "export const seed = () => globalThis.Math.random();",
      name: "the globalThis prefix does not launder the accessor",
      errors: [{ messageId: "ambientNondeterminism", data: { source: "Math.random" } }],
    },
    {
      code: "export const stamp = () => Date?.now();",
      name: "optional chaining reads the same clock",
      errors: [{ messageId: "ambientNondeterminism", data: { source: "Date.now" } }],
    },
  ],
});
