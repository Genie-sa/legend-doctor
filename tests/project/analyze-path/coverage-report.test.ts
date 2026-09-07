import {
  analyzePath,
  analyzePathDetailed,
} from "../../../src/project/analyze-path/analyze-path.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzeSource } from "../../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

test("reports parser diagnostics and complete coverage without changing the default report", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-coverage-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "broken.ts"),
    'import { useState } from "react"; const [value] = useState(;',
    "utf8",
  );
  await writeFile(path.join(root, "valid.ts"), "export const value = 1;", "utf8");

  const detailed = await analyzePathDetailed(root);
  const ordinary = await analyzePath(root);

  assert.deepEqual(detailed.report, ordinary);
  assert.equal(detailed.diagnostics.parser.length, 1);
  assert.equal(requireValue(detailed.diagnostics.parser[0]).file, "broken.ts");
  assert.equal(detailed.coverage.entries.length, 2);
  assert.deepEqual(
    detailed.coverage.entries.map((entry) => [
      entry.target.file,
      entry.stages.parser.reason.code,
      entry.stages.detector.status,
    ]),
    [
      ["broken.ts", "parser-recovered", "unknown"],
      ["valid.ts", "parser-complete", "analyzed"],
    ],
  );
});

test("inventories named and anonymous runtime functions in coverage", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-functions-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "screen.ts"),
    `
      export function Screen() {
        return [1].map(value => value + 1);
      }
    `,
    "utf8",
  );

  const detailed = await analyzePathDetailed(root);
  const functions = detailed.coverage.entries.filter((entry) => entry.target.kind === "function");

  assert.deepEqual(
    functions.map((entry) => (entry.target.kind === "function" ? entry.target.name : null)),
    ["Screen", null],
  );
  assert.ok(functions.every((entry) => entry.stages.detector.status === "analyzed"));
  assert.ok(
    functions.every((entry) => entry.stages.lowering.reason.code === "bounded-flow-not-requested"),
  );
});

test("reports complete, uncertain, and unrequested bounded state-flow coverage", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-flow-coverage-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  const source = `
    import { useState } from "react";
    export function Screen({ items }: { items: string[] }) {
      const [first, setFirst] = useState("");
      const [second, setSecond] = useState("");
      const complete = () => { setFirst("a"); setSecond("b"); };
      const uncertain = () => { for (const item of items) setFirst(item); setSecond("b"); };
      return <button onClick={complete}>{first}{second}{String(uncertain)}</button>;
    }
    export function Unrelated() { return null; }
  `;
  await writeFile(path.join(root, "screen.tsx"), source, "utf8");

  const detailed = await analyzePathDetailed(root);
  const functions = detailed.coverage.entries.filter((entry) => entry.target.kind === "function");
  const byName = new Map(
    functions.map((entry) => [entry.target.kind === "function" ? entry.target.name : null, entry]),
  );

  assert.equal(
    requireValue(byName.get("complete")).stages.lowering.reason.code,
    "bounded-flow-complete",
  );
  assert.equal(
    requireValue(byName.get("uncertain")).stages.lowering.reason.code,
    "bounded-flow-uncertain",
  );
  assert.equal(
    requireValue(byName.get("Unrelated")).stages.lowering.reason.code,
    "bounded-flow-not-requested",
  );
  assert.equal(
    requireValue(detailed.coverage.entries[0]).stages.lowering.reason.code,
    "bounded-flow-uncertain",
  );
  assert.deepEqual(detailed.report.findings, analyzeSource(source, "screen.tsx"));
});

test("excludes ambient declarations, overload signatures, and abstract methods from runtime coverage", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-runtime-only-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "contracts.ts"),
    `
      declare function ambient(): void;
      function overloaded(value: string): string;
      function overloaded(value: string) { return value; }
      abstract class Base { abstract method(): void; }
    `,
    "utf8",
  );

  const detailed = await analyzePathDetailed(root);
  const names = detailed.coverage.entries.flatMap((entry) =>
    entry.target.kind === "function" ? [entry.target.name] : [],
  );

  assert.deepEqual(names, ["overloaded"]);
});

test("localizes parser recovery to the overlapping function", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-recovery-range-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "screen.ts"),
    `
      function broken() { const value = ; return value; }
      function healthy() { return 1; }
    `,
    "utf8",
  );

  const detailed = await analyzePathDetailed(root);
  const functions = detailed.coverage.entries.filter((entry) => entry.target.kind === "function");

  assert.deepEqual(
    functions.map((entry) => [
      entry.target.kind === "function" ? entry.target.name : null,
      entry.stages.parser.reason.code,
      entry.stages.detector.status,
    ]),
    [
      ["broken", "parser-recovered-in-function", "unknown"],
      ["healthy", "parser-complete", "unknown"],
    ],
  );
});

test("attributes an end-of-file recovery diagnostic to the unfinished function", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-recovery-eof-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(path.join(root, "screen.ts"), "function broken() { const value = 1;", "utf8");

  const detailed = await analyzePathDetailed(root);
  const functionEntry = detailed.coverage.entries.find((entry) => entry.target.kind === "function");

  assert.equal(
    requireValue(functionEntry).stages.parser.reason.code,
    "parser-recovered-in-function",
  );
  assert.equal(requireValue(functionEntry).stages.lowering.reason.code, "bounded-flow-uncertain");
  assert.equal(requireValue(functionEntry).stages.detector.status, "unknown");
});

test("scopes directory coverage to supported sources and reports direct unsupported targets", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-coverage-universe-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(path.join(root, "valid.ts"), "export const value = 1;", "utf8");
  const unsupportedPath = path.join(root, "component.vue");
  await writeFile(unsupportedPath, "<template />", "utf8");

  const directory = await analyzePathDetailed(root);
  const direct = await analyzePathDetailed(unsupportedPath);

  assert.deepEqual(
    directory.coverage.entries.map((entry) => entry.target.file),
    ["valid.ts"],
  );
  assert.equal(direct.coverage.entries.length, 1);
  assert.equal(
    requireValue(direct.coverage.entries[0]).stages.parser.reason.code,
    "unsupported-extension",
  );
  assert.equal(requireValue(direct.coverage.entries[0]).stages.detector.status, "unsupported");
});
