import {
  analyzeLegendPractices,
  analyzeLegendPracticesFile,
} from "../../../src/practices/analyze-legend-practices.js";
import { analyzeSource, analyzeSourceFile } from "../../../src/analysis/analyze-source.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { AnalysisProject } from "../../../src/project/analysis-project.js";
import type { FindingSignature } from "./harness.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import { createAnalysisContext } from "../../../src/project/analyze-path/analysis-context.js";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

test("scans source files deterministically and ignores generated directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-test-"));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "node_modules"));
  await writeFile(
    path.join(root, "src", "component.tsx"),
    'import { useState } from "react"; export function C() { const [x] = useState(1); return <>{x}</>; }',
  );
  await writeFile(
    path.join(root, "node_modules", "ignored.tsx"),
    'import { useState } from "react"; export function C() { const [x] = useState(1); return <>{x}</>; }',
  );

  const report = await analyzePath(root);

  assert.equal(report.files, 1);
  assert.equal(report.hooks.states, 1);
  assert.equal(requireValue(report.findings[0]).location.file, path.join("src", "component.tsx"));
});

test("comments and blank lines never change findings", async (testContext) => {
  const plain = [
    'import { useEffect, useState } from "react";',
    "export function Price({ amount }: { amount: number }) {",
    '  const [label, setLabel] = useState("");',
    "  useEffect(() => {",
    `    setLabel(\`$\${amount}\`);`,
    "  }, [amount]);",
    "  return <span>{label}</span>;",
    "}",
  ];
  const withTrivia = [
    "/* banner */",
    "",
    ...plain.map((line) => `${line} // trailing`),
    "",
    "// footer",
  ];
  const signatures = async (source: string): Promise<FindingSignature[]> => {
    const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-trivia-"));
    testContext.after(() => rm(root, { force: true, recursive: true }));
    await writeFile(path.join(root, "price.tsx"), source, "utf8");
    const report = await analyzePath(root);
    return report.findings.map((finding): FindingSignature => [
      finding.hook,
      finding.name,
      finding.action,
      finding.disposition,
    ]);
  };
  const [plainSignatures, triviaSignatures] = await Promise.all([
    signatures(plain.join("\n")),
    signatures(withTrivia.join("\n")),
  ]);

  assert.ok(plainSignatures.length > 0);
  assert.deepEqual(triviaSignatures, plainSignatures);
});

test("shares one cached AST across source indexing and both detector families", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-cached-ast-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  const statePath = path.join(root, "state.ts");
  const leafPath = path.join(root, "Leaf.tsx");
  const screenPath = path.join(root, "Screen.tsx");
  await writeFile(
    statePath,
    'import { observable } from "@legendapp/state"; export const profile$ = observable({ name: "Ada", email: "ada@example.com" });',
    "utf8",
  );
  await writeFile(
    leafPath,
    "export function Leaf({ busy }: { busy: boolean }) { return <span>{String(busy)}</span>; }",
    "utf8",
  );
  const screenSource = `
    import { useState } from "react";
    import { useValue } from "@legendapp/state/react";
    import { Leaf } from "./Leaf";
    import { profile$ } from "./state";
    export function Screen() {
      const [busy, setBusy] = useState(false);
      const profile = useValue(profile$);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <button onClick={() => setBusy(true)}>Run</button><Leaf busy={busy} /><span>{profile.name}</span>
      </main>;
    }
  `;
  await writeFile(screenPath, screenSource, "utf8");

  const context = await createAnalysisContext(root);
  const file = context.project.getFile(screenPath);
  assert.ok(file);
  assert.strictEqual(requireValue(context.project.getFile(screenPath)).sourceFile, file.sourceFile);
  const reportName = "Screen.tsx";
  const components = context.sourceIndex.componentsFor(screenPath);
  const observables = context.sourceIndex.observablesFor(screenPath);
  const factories = context.sourceIndex.observableFactoriesFor(screenPath);

  assert.deepEqual(
    analyzeSourceFile({ file, reportFileName: reportName, sourceComponents: components }),
    analyzeSource(screenSource, reportName, components),
  );
  assert.deepEqual(
    analyzeLegendPracticesFile({
      file,
      reportFileName: reportName,
      importedObservables: observables,
      importedObservableFactories: factories,
    }),
    analyzeLegendPractices({
      sourceText: screenSource,
      fileName: reportName,
      importedObservables: observables,
      importedObservableFactories: factories,
    }),
  );

  const report = await analyzePath(root, { sharedContext: context });
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "busy")).action,
    "use-observable",
  );
  assert.equal(requireValue(report.practices[0]).action, "narrow-use-value-subscription");
});

test("keeps display-path harness semantics separate from cached absolute identity", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-display-path-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  const harnessDirectory = path.join(root, "src", "__tests__");
  await mkdir(harnessDirectory, { recursive: true });
  const harnessPath = path.join(harnessDirectory, "Screen.tsx");
  await writeFile(
    harnessPath,
    `
      import { useState } from "react";
      export function Screen() {
        const [busy, setBusy] = useState(false);
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
          <button onClick={() => setBusy(true)} /><Leaf busy={busy} />
        </main>;
      }
    `,
    "utf8",
  );

  const directoryReport = await analyzePath(root);
  const focusedReport = await analyzePath(harnessPath);
  const [directoryFinding] = directoryReport.findings;
  const [focusedFinding] = focusedReport.findings;
  assert.equal(requireValue(directoryFinding).action, "keep-state");
  assert.equal(
    requireValue(directoryFinding).location.file,
    path.join("src", "__tests__", "Screen.tsx"),
  );
  assert.equal(requireValue(focusedFinding).action, "use-observable");
  assert.equal(requireValue(focusedFinding).location.file, "Screen.tsx");
});

test("keeps JavaScript and JSX practice results stable through the cached parser", () => {
  for (const extension of ["js", "jsx", "mjs", "cjs"] as const) {
    const fileName = `screen.${extension}`;
    const source = `
      import { observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      const profile$ = observable({ name: "Ada" });
      /** @returns {string} */
      export function read() {
        const profile = useValue(profile$);
        return profile.name;
      }
    `;
    const project = new AnalysisProject(new Map([[fileName, source]]));
    const [file] = project.files;
    assert.ok(file);
    assert.deepEqual(
      analyzeLegendPracticesFile({ file, reportFileName: fileName }),
      analyzeLegendPractices({ sourceText: source, fileName }),
      extension,
    );
  }
});

test("rejects targets outside a shared analysis project", async (testContext) => {
  const contextRoot = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-context-root-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-target-root-"));
  testContext.after(() => rm(contextRoot, { force: true, recursive: true }));
  testContext.after(() => rm(targetRoot, { force: true, recursive: true }));
  await writeFile(path.join(contextRoot, "owned.ts"), "export const owned = true;", "utf8");
  const targetPath = path.join(targetRoot, "foreign.ts");
  await writeFile(targetPath, "export const foreign = true;", "utf8");

  const context = await createAnalysisContext(contextRoot);

  await assert.rejects(
    analyzePath(targetPath, { sharedContext: context }),
    /analysis context does not own target file/u,
  );
});
