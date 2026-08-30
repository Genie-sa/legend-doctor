import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { AnalysisProject } from "../src/analysis-project.js";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createSemanticContext } from "../src/semantic-context.js";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

function temporaryDirectory(testContext: TestContext): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "legend-doctor-semantic-"));
  testContext.after(() => rmSync(directory, { force: true, recursive: true }));
  return directory;
}

function identifiersNamed(sourceFile: ts.SourceFile, name: string): ts.Identifier[] {
  const identifiers: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) {
      identifiers.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return identifiers;
}

const requireValue = <Value>(value: Value | undefined): Value => {
  assert.ok(value);
  return value;
};

test("reports unreadable and invalid tsconfig files without guessing compiler options", (testContext) => {
  const directory = temporaryDirectory(testContext);
  const sourcePath = path.join(directory, "screen.ts");
  writeFileSync(sourcePath, "export const value = 1;", "utf8");
  const project = new AnalysisProject(new Map([[sourcePath, "export const value = 1;"]]));
  const missing = createSemanticContext(project, {
    configFilePath: path.join(directory, "missing.json"),
  });
  assert.equal(missing.context, null);
  assert.equal(requireValue(missing.diagnostics[0]).code, "config-read-failed");
  assert.equal(requireValue(missing.diagnostics[0]).typescriptCode, 5083);

  const invalidConfigPath = path.join(directory, "tsconfig.json");
  writeFileSync(
    invalidConfigPath,
    JSON.stringify({ compilerOptions: { unsupportedOption: true }, files: ["screen.ts"] }),
    "utf8",
  );
  const invalid = createSemanticContext(project, { configFilePath: invalidConfigPath });
  assert.equal(invalid.context, null);
  assert.equal(requireValue(invalid.diagnostics[0]).code, "config-invalid");
  assert.equal(requireValue(invalid.diagnostics[0]).typescriptCode, 5023);
});

test("rejects analysis files that are not owned by the selected tsconfig shard", (testContext) => {
  const directory = temporaryDirectory(testContext);
  const ownedPath = path.join(directory, "owned.ts");
  const foreignPath = path.join(directory, "foreign.ts");
  writeFileSync(ownedPath, "export const owned = true;", "utf8");
  writeFileSync(foreignPath, "export const foreign = true;", "utf8");
  const configFilePath = path.join(directory, "tsconfig.json");
  writeFileSync(configFilePath, JSON.stringify({ files: ["owned.ts"] }), "utf8");
  const project = new AnalysisProject(
    new Map([
      [ownedPath, "export const owned = true;"],
      [foreignPath, "export const foreign = true;"],
    ]),
  );
  const result = createSemanticContext(project, { configFilePath });

  assert.equal(result.context, null);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ["file-not-in-config"],
  );
  assert.equal(requireValue(result.diagnostics[0]).fileName, foreignPath);
});

test("treats transitive imports as members of the selected tsconfig shard", (testContext) => {
  const directory = temporaryDirectory(testContext);
  const entryPath = path.join(directory, "entry.ts");
  const dependencyPath = path.join(directory, "dependency.ts");
  const dependencySource = "export const value = 1;";
  const entrySource = 'import { value } from "./dependency.js"; export const copy = value;';
  writeFileSync(entryPath, entrySource, "utf8");
  writeFileSync(dependencyPath, dependencySource, "utf8");
  const configFilePath = path.join(directory, "tsconfig.json");
  writeFileSync(
    configFilePath,
    JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
      files: ["entry.ts"],
    }),
    "utf8",
  );
  const project = new AnalysisProject(
    new Map([
      [entryPath, entrySource],
      [dependencyPath, dependencySource],
    ]),
  );
  const result = createSemanticContext(project, { configFilePath });

  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.context);
  const dependency = project.getFile(dependencyPath);
  assert.ok(dependency);
  assert.strictEqual(result.context.getSourceFile(dependency), dependency.sourceFile);
});

test("owns one Program, reuses cached ASTs, and exposes symbol, declaration, import, and type facts", (testContext) => {
  const directory = temporaryDirectory(testContext);
  const sourceDirectory = path.join(directory, "src");
  mkdirSync(sourceDirectory);

  const modelPath = path.join(sourceDirectory, "model.ts");
  const screenPath = path.join(sourceDirectory, "screen.ts");
  const modelSource = "export const values: string[] = [];";
  const screenSource = [
    'import { values as sourceValues } from "./model.js";',
    "export const selected = sourceValues[0];",
  ].join("\n");
  writeFileSync(modelPath, modelSource, "utf8");
  writeFileSync(screenPath, screenSource, "utf8");

  const configFilePath = path.join(directory, "tsconfig.json");
  writeFileSync(
    configFilePath,
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noUncheckedIndexedAccess: true,
        strict: true,
        target: "ES2022",
      },
      include: ["src/**/*.ts"],
    }),
    "utf8",
  );

  const project = new AnalysisProject(
    new Map([
      [modelPath, modelSource],
      [screenPath, screenSource],
    ]),
  );
  const result = createSemanticContext(project, { configFilePath });
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.context);

  const modelFile = project.getFile(modelPath);
  const screenFile = project.getFile(screenPath);
  assert.ok(modelFile);
  assert.ok(screenFile);
  assert.strictEqual(result.context.getSourceFile(modelFile), modelFile.sourceFile);
  assert.strictEqual(result.context.getSourceFile(screenFile), screenFile.sourceFile);

  const sourceIdentifiers = identifiersNamed(screenFile.sourceFile, "sourceValues");
  const modelIdentifiers = identifiersNamed(modelFile.sourceFile, "values");
  const selectedIdentifiers = identifiersNamed(screenFile.sourceFile, "selected");
  const [, importedUse] = sourceIdentifiers;
  const [exportedDeclaration] = modelIdentifiers;
  const [selected] = selectedIdentifiers;
  assert.ok(importedUse);
  assert.ok(exportedDeclaration);
  assert.ok(selected);

  const importSymbol = result.context.getSymbol(importedUse);
  const canonicalImportSymbol = result.context.getCanonicalSymbol(importedUse);
  assert.ok(importSymbol);
  assert.ok(canonicalImportSymbol);
  assert.notStrictEqual(importSymbol, canonicalImportSymbol);
  assert.strictEqual(canonicalImportSymbol, result.context.getSymbol(exportedDeclaration));
  assert.ok(result.context.getDeclarations(canonicalImportSymbol).length > 0);
  assert.deepEqual(result.context.getImportProvenance(importedUse), {
    accessPath: [],
    declaration: screenFile.sourceFile.statements[0],
    importedName: "values",
    isTypeOnly: false,
    kind: "named",
    localName: "sourceValues",
    moduleSpecifier: "./model.js",
  });

  assert.ok(result.context.getType(selected));
  assert.equal(result.context.getTypeText(selected), "string | undefined");
});

test("reports namespace access provenance and rejects nodes from a foreign AST", (testContext) => {
  const directory = temporaryDirectory(testContext);
  const modelPath = path.join(directory, "model.ts");
  const screenPath = path.join(directory, "screen.ts");
  const modelSource = "export const value = 1;";
  const screenSource = [
    'import * as model from "./model.js";',
    "export const copy = model.value;",
  ].join("\n");
  writeFileSync(modelPath, modelSource, "utf8");
  writeFileSync(screenPath, screenSource, "utf8");
  const configFilePath = path.join(directory, "tsconfig.json");
  writeFileSync(
    configFilePath,
    JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
      files: ["model.ts", "screen.ts"],
    }),
    "utf8",
  );

  const project = new AnalysisProject(
    new Map([
      [modelPath, modelSource],
      [screenPath, screenSource],
    ]),
  );
  const result = createSemanticContext(project, { configFilePath });
  assert.ok(result.context);
  const screenFile = project.getFile(screenPath);
  assert.ok(screenFile);
  const [valueUse] = identifiersNamed(screenFile.sourceFile, "value");
  assert.ok(valueUse);
  const provenance = result.context.getImportProvenance(valueUse);
  assert.equal(requireValue(provenance).kind, "namespace");
  assert.equal(requireValue(provenance).moduleSpecifier, "./model.js");
  assert.deepEqual(requireValue(provenance).accessPath, ["value"]);

  const foreignFile = ts.createSourceFile(
    screenPath,
    screenSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const foreignIdentifiers = identifiersNamed(foreignFile, "value");
  const [foreignValue] = foreignIdentifiers;
  assert.ok(foreignValue);
  assert.equal(result.context.getSymbol(foreignValue), undefined);
  assert.equal(result.context.getCanonicalSymbol(foreignValue), undefined);
  assert.equal(result.context.getType(foreignValue), undefined);
  assert.equal(result.context.getTypeText(foreignValue), undefined);
  assert.equal(result.context.getImportProvenance(foreignValue), undefined);
});
