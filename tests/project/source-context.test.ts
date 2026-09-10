import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { analyzePathDetailed } from "../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import { buildSourceIndex } from "../../src/project/source-components/source-components.js";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("coverage names a missing factory even when no factory implementation is indexed", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doctor-source-context-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "screen.ts"),
    'import { makeStore } from "@fixture/missing"; import { other } from "@fixture/missing"; export const store = makeStore(other);',
  );
  const result = await analyzePathDetailed(root);
  const source = result.coverage.sourceContext?.find((entry) => entry.file === "screen.ts");
  assert.ok(source);
  assert.ok(source.requestedProofs.includes("observable-factory"));
  assert.deepEqual(source.unavailable, [
    {
      importer: "screen.ts",
      specifier: "@fixture/missing",
      reason: "module-unresolved",
      resolvedFile: null,
    },
  ]);
  assert.equal(result.report.practices.length, 0);
  const repeated = await analyzePathDetailed(root);
  assert.deepEqual(repeated.coverage.sourceContext, result.coverage.sourceContext);
});

test("coverage follows missing reexports but excludes type-only edges and terminates cycles", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doctor-source-context-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const sources = new Map([
    [
      "screen.ts",
      'import { store } from "./barrel"; import type { T } from "missing-type"; export const x = store;',
    ],
    [
      "barrel.ts",
      'export * from "./cycle"; export { store } from "missing-store"; export type * from "missing-type";',
    ],
    ["cycle.ts", 'export * from "./barrel";'],
  ]);
  for (const [file, source] of sources) {
    await writeFile(path.join(root, file), source);
  }
  const result = await analyzePathDetailed(root);
  const source = result.coverage.sourceContext?.find((entry) => entry.file === "screen.ts");
  assert.deepEqual(source?.unavailable, [
    {
      importer: "barrel.ts",
      specifier: "missing-store",
      reason: "module-unresolved",
      resolvedFile: null,
    },
  ]);
});

test("coverage distinguishes installed declarations and unindexed implementation from missing modules", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doctor-source-context-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  for (const [name, entry] of [
    ["types", "index.d.ts"],
    ["runtime", "index.js"],
  ]) {
    const dir = path.join(root, "node_modules", name!);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name, main: entry }));
    await writeFile(path.join(dir, entry!), "export const value = 1;");
  }
  await writeFile(
    path.join(root, "screen.ts"),
    'import { value } from "types"; import { value as other } from "runtime"; export const values = [value, other];',
  );
  const result = await analyzePathDetailed(root);
  const source = result.coverage.sourceContext?.find((entry) => entry.file === "screen.ts");
  assert.deepEqual(source?.unavailable, [
    {
      importer: "screen.ts",
      specifier: "runtime",
      reason: "source-not-indexed",
      resolvedFile: "node_modules/runtime/index.js",
    },
    {
      importer: "screen.ts",
      specifier: "types",
      reason: "declaration-only",
      resolvedFile: "node_modules/types/index.d.ts",
    },
  ]);
});

test("available implementation with no requested export is not mislabeled as missing source", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doctor-source-context-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "screen.ts"),
    'import { makeStore } from "./source"; export const store = makeStore();',
  );
  await writeFile(path.join(root, "source.ts"), "export const unrelated = 1;");
  const result = await analyzePathDetailed(root);
  assert.deepEqual(
    result.coverage.sourceContext?.find((entry) => entry.file === "screen.ts")?.unavailable,
    [],
  );
  assert.equal(result.report.practices.length, 0);
});

test("coverage includes direct imported hook proof requests", () => {
  const file = path.resolve("missing-hook.ts");
  const index = buildSourceIndex(
    path.dirname(file),
    new Map([[file, 'import { useMissing } from "@fixture/missing";']]),
  );
  assert.equal(index.hookDeclarationFor(file, "useMissing"), null);
  assert.deepEqual(index.sourceContextFor(file).requestedProofs, ["hook"]);
});

test("coverage paths remain relative through a symlinked scan root", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doctor-source-context-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const actual = path.join(root, "actual");
  const linked = path.join(root, "linked");
  await mkdir(actual);
  await writeFile(
    path.join(actual, "screen.ts"),
    'import { value } from "missing"; export const x = value;',
  );
  await symlink(actual, linked, "dir");
  const result = await analyzePathDetailed(linked);
  assert.deepEqual(result.coverage.sourceContext?.[0]?.unavailable, [
    {
      importer: "screen.ts",
      specifier: "missing",
      reason: "module-unresolved",
      resolvedFile: null,
    },
  ]);
});
