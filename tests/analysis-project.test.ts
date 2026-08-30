import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import ts from "typescript";

import { AnalysisProject } from "../src/analysis-project.js";

const requireValue = <Value>(value: Value | undefined): Value => {
  assert.ok(value);
  return value;
};

test("parses each project file once and caches its source file", () => {
  const project = new AnalysisProject(
      new Map([["screen.tsx", "export const Screen = () => <main />;"]]),
    ),
    first = project.getFile("screen.tsx"),
    second = project.getFile("screen.tsx");

  assert.ok(first);
  assert.strictEqual(second, first);
  assert.strictEqual(requireValue(second).sourceFile, first.sourceFile);
  assert.strictEqual(first.sourceFile.getSourceFile(), first.sourceFile);
  assert.equal(project.files.length, 1);
  assert.equal(first.identityPath, path.resolve("screen.tsx"));
  assert.equal(first.originalPath, "screen.tsx");
});

test("records the TypeScript dialect and script kind for supported source extensions", () => {
  const project = new AnalysisProject(
    new Map([
      ["plain.js", "export const value = 1;"],
      ["view.jsx", "export const View = () => <main />;"],
      ["module.mts", "export const value: number = 1;"],
      ["screen.tsx", "export const Screen = () => <main />;"],
    ]),
  );

  assert.deepEqual(
    project.files.map((file) => [file.originalPath, file.dialect, file.scriptKind]),
    [
      ["module.mts", "typescript", ts.ScriptKind.TS],
      ["plain.js", "javascript", ts.ScriptKind.JS],
      ["screen.tsx", "typescript-jsx", ts.ScriptKind.TSX],
      ["view.jsx", "javascript-jsx", ts.ScriptKind.JSX],
    ],
  );
});

test("retains syntactic diagnostics on the cached source file", () => {
  const project = new AnalysisProject(
      new Map([
        ["broken.ts", "const value = ;"],
        ["valid.ts", "const value = 1;"],
      ]),
    ),
    broken = project.getFile("broken.ts"),
    valid = project.getFile("valid.ts");

  assert.ok(broken);
  assert.equal(broken.parserDiagnostics.length, 1);
  assert.equal(requireValue(broken.parserDiagnostics[0]).code, 1109);
  assert.equal(requireValue(broken.parserDiagnostics[0]).file, path.resolve("broken.ts"));
  assert.deepEqual(requireValue(valid).parserDiagnostics, []);
});

test("keeps source snapshots independent from later source-map mutations", () => {
  const sources = new Map([["state.ts", "export const state = 1;"]]),
    project = new AnalysisProject(sources);

  sources.set("state.ts", "export const state = 2;");

  assert.equal(
    requireValue(project.getFile("state.ts")).sourceFile.text,
    "export const state = 1;",
  );
  assert.equal(project.getFile("missing.ts"), undefined);
});

test("rejects path aliases that resolve to one file identity", () => {
  assert.throws(
    () =>
      new AnalysisProject(
        new Map([
          [`src${path.sep}..${path.sep}src${path.sep}view.tsx`, "export const first = 1;"],
          [path.join("src", "view.tsx"), "export const second = 2;"],
        ]),
      ),
    /duplicate analysis file identity/u,
  );
});

test("uses filesystem case sensitivity when resolving file identities", () => {
  const sources = new Map([
    ["Screen.tsx", "export const upper = 1;"],
    ["screen.tsx", "export const lower = 2;"],
  ]);
  if (ts.sys.useCaseSensitiveFileNames) {
    assert.equal(new AnalysisProject(sources).files.length, 2);
  } else {
    assert.throws(() => new AnalysisProject(sources), /duplicate analysis file identity/u);
  }
});

test("rejects unsupported source dialects explicitly", () => {
  assert.throws(
    () => new AnalysisProject(new Map([["component.vue", "<template />"]])),
    /unsupported analysis file extension/u,
  );
});
