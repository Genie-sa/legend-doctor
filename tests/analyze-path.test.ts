import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  analyzeLegendPractices,
  analyzeLegendPracticesFile,
} from "../src/analyze-legend-practices.js";
import {
  analyzePath,
  analyzePathDetailed,
  createAnalysisContext,
} from "../src/analyze-path.js";
import { analyzeSource, analyzeSourceFile } from "../src/analyze-source.js";
import { AnalysisProject } from "../src/analysis-project.js";

test("scans source files deterministically and ignores generated directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-test-"));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "node_modules"));
  await writeFile(
    path.join(root, "src", "component.tsx"),
    'import { useState } from "react"; export function C() { const [x] = useState(1); return <>{x}</>; }'
  );
  await writeFile(
    path.join(root, "node_modules", "ignored.tsx"),
    'import { useState } from "react"; export function C() { const [x] = useState(1); return <>{x}</>; }'
  );

  const report = await analyzePath(root);

  assert.equal(report.files, 1);
  assert.equal(report.hooks.states, 1);
  assert.equal(report.findings[0]?.location.file, path.join("src", "component.tsx"));
});

test("reports parser diagnostics and complete coverage without changing the default report", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-coverage-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "broken.ts"),
    'import { useState } from "react"; const [value] = useState(;',
    "utf8"
  );
  await writeFile(path.join(root, "valid.ts"), "export const value = 1;", "utf8");

  const detailed = await analyzePathDetailed(root);
  const ordinary = await analyzePath(root);

  assert.deepEqual(detailed.report, ordinary);
  assert.equal(detailed.diagnostics.parser.length, 1);
  assert.equal(detailed.diagnostics.parser[0]?.file, "broken.ts");
  assert.deepEqual(detailed.diagnostics.semantic, []);
  assert.equal(detailed.coverage.entries.length, 2);
  assert.deepEqual(
    detailed.coverage.entries.map(entry => [
      entry.target.file,
      entry.stages.parser.reason.code,
      entry.stages.detector.status,
    ]),
    [
      ["broken.ts", "parser-recovered", "unknown"],
      ["valid.ts", "parser-complete", "analyzed"],
    ]
  );
});

test("inventories named and anonymous runtime functions in coverage", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-functions-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "screen.ts"),
    `
      export function Screen() {
        return [1].map(value => value + 1);
      }
    `,
    "utf8"
  );

  const detailed = await analyzePathDetailed(root);
  const functions = detailed.coverage.entries.filter(entry => entry.target.kind === "function");

  assert.deepEqual(
    functions.map(entry => entry.target.kind === "function" ? entry.target.name : null),
    ["Screen", null]
  );
  assert.ok(functions.every(entry => entry.stages.detector.status === "analyzed"));
  assert.ok(functions.every(entry => entry.stages.lowering.reason.code === "bounded-flow-not-requested"));
});

test("reports complete, uncertain, and unrequested bounded state-flow coverage", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-flow-coverage-"));
  t.after(() => rm(root, { force: true, recursive: true }));
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
  const functions = detailed.coverage.entries.filter(entry => entry.target.kind === "function");
  const byName = new Map(functions.map(entry => [entry.target.kind === "function" ? entry.target.name : null, entry]));

  assert.equal(byName.get("complete")?.stages.lowering.reason.code, "bounded-flow-complete");
  assert.equal(byName.get("uncertain")?.stages.lowering.reason.code, "bounded-flow-uncertain");
  assert.equal(byName.get("Unrelated")?.stages.lowering.reason.code, "bounded-flow-not-requested");
  assert.equal(detailed.coverage.entries[0]?.stages.lowering.reason.code, "bounded-flow-uncertain");
  assert.deepEqual(detailed.report.findings, analyzeSource(source, "screen.tsx"));
});

test("excludes ambient declarations, overload signatures, and abstract methods from runtime coverage", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-runtime-only-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "contracts.ts"),
    `
      declare function ambient(): void;
      function overloaded(value: string): string;
      function overloaded(value: string) { return value; }
      abstract class Base { abstract method(): void; }
    `,
    "utf8"
  );

  const detailed = await analyzePathDetailed(root);
  const names = detailed.coverage.entries.flatMap(entry =>
    entry.target.kind === "function" ? [entry.target.name] : []
  );

  assert.deepEqual(names, ["overloaded"]);
});

test("localizes parser recovery to the overlapping function", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-recovery-range-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "screen.ts"),
    `
      function broken() { const value = ; return value; }
      function healthy() { return 1; }
    `,
    "utf8"
  );

  const detailed = await analyzePathDetailed(root);
  const functions = detailed.coverage.entries.filter(entry => entry.target.kind === "function");

  assert.deepEqual(
    functions.map(entry => [
      entry.target.kind === "function" ? entry.target.name : null,
      entry.stages.parser.reason.code,
      entry.stages.detector.status,
    ]),
    [
      ["broken", "parser-recovered-in-function", "unknown"],
      ["healthy", "parser-complete", "unknown"],
    ]
  );
});

test("attributes an end-of-file recovery diagnostic to the unfinished function", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-recovery-eof-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "screen.ts"),
    "function broken() { const value = 1;",
    "utf8"
  );

  const detailed = await analyzePathDetailed(root);
  const functionEntry = detailed.coverage.entries.find(
    entry => entry.target.kind === "function"
  );

  assert.equal(functionEntry?.stages.parser.reason.code, "parser-recovered-in-function");
  assert.equal(functionEntry?.stages.lowering.reason.code, "bounded-flow-uncertain");
  assert.equal(functionEntry?.stages.detector.status, "unknown");
});

test("scopes directory coverage to supported sources and reports direct unsupported targets", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-coverage-universe-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(path.join(root, "valid.ts"), "export const value = 1;", "utf8");
  const unsupportedPath = path.join(root, "component.vue");
  await writeFile(unsupportedPath, "<template />", "utf8");

  const directory = await analyzePathDetailed(root);
  const direct = await analyzePathDetailed(unsupportedPath);

  assert.deepEqual(directory.coverage.entries.map(entry => entry.target.file), ["valid.ts"]);
  assert.equal(direct.coverage.entries.length, 1);
  assert.equal(direct.coverage.entries[0]?.stages.parser.reason.code, "unsupported-extension");
  assert.equal(direct.coverage.entries[0]?.stages.detector.status, "unsupported");
});

test("preserves the path-level Legend practice eligibility boundary", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-practice-eligibility-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "legacy.ts"),
    `
      import { useSelector } from "@legendapp/state/react";
      export function read(value: string) { return useSelector(() => value); }
    `,
    "utf8"
  );

  const context = await createAnalysisContext(root);
  const file = context.project.getFile(path.join(root, "legacy.ts"));
  assert.ok(file);
  assert.equal(
    analyzeLegendPracticesFile(file, "legacy.ts")[0]?.action,
    "replace-legacy-use-value"
  );

  const report = await analyzePath(root, context);

  assert.deepEqual(report.practices, []);
});

test("shares one cached AST across source indexing and both detector families", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-cached-ast-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const statePath = path.join(root, "state.ts");
  const leafPath = path.join(root, "Leaf.tsx");
  const screenPath = path.join(root, "Screen.tsx");
  await writeFile(
    statePath,
    'import { observable } from "@legendapp/state"; export const profile$ = observable({ name: "Ada" });',
    "utf8"
  );
  await writeFile(
    leafPath,
    "export function Leaf({ busy }: { busy: boolean }) { return <span>{String(busy)}</span>; }",
    "utf8"
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
  assert.strictEqual(context.project.getFile(screenPath)?.sourceFile, file.sourceFile);
  const reportName = "Screen.tsx";
  const components = context.sourceIndex.componentsFor(screenPath);
  const observables = context.sourceIndex.observablesFor(screenPath);
  const factories = context.sourceIndex.observableFactoriesFor(screenPath);

  assert.deepEqual(
    analyzeSourceFile(file, reportName, components),
    analyzeSource(screenSource, reportName, components)
  );
  assert.deepEqual(
    analyzeLegendPracticesFile(file, reportName, observables, factories),
    analyzeLegendPractices(screenSource, reportName, observables, factories)
  );

  const report = await analyzePath(root, context);
  assert.equal(report.findings.find(finding => finding.name === "busy")?.action, "use-observable");
  assert.equal(report.practices[0]?.action, "narrow-use-value-subscription");
});

test("keeps display-path harness semantics separate from cached absolute identity", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-display-path-"));
  t.after(() => rm(root, { force: true, recursive: true }));
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
    "utf8"
  );

  const directoryFinding = (await analyzePath(root)).findings[0];
  const focusedFinding = (await analyzePath(harnessPath)).findings[0];
  assert.equal(directoryFinding?.action, "keep-state");
  assert.equal(directoryFinding?.location.file, path.join("src", "__tests__", "Screen.tsx"));
  assert.equal(focusedFinding?.action, "use-observable");
  assert.equal(focusedFinding?.location.file, "Screen.tsx");
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
    const file = new AnalysisProject(new Map([[fileName, source]])).files[0];
    assert.ok(file);
    assert.deepEqual(
      analyzeLegendPracticesFile(file, fileName),
      analyzeLegendPractices(source, fileName),
      extension
    );
  }
});

test("reports optional semantic coverage only for an explicit tsconfig shard", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-semantic-context-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const sourcePath = path.join(root, "screen.ts");
  const configFilePath = path.join(root, "tsconfig.json");
  await writeFile(sourcePath, "export const value: string = 'ready';", "utf8");
  await writeFile(
    configFilePath,
    JSON.stringify({ compilerOptions: { strict: true }, files: ["screen.ts"] }),
    "utf8"
  );

  const context = await createAnalysisContext(root, { configFilePath });
  const detailed = await analyzePathDetailed(root, context);

  assert.ok(context.semanticContext);
  assert.deepEqual(detailed.diagnostics.semantic, []);
  assert.equal(detailed.coverage.entries[0]?.stages.semantic.status, "analyzed");
});

test("does not require application component provenance for a focused call-site wrapper", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-context-"));
  const components = path.join(root, "components");
  const screens = path.join(root, "screens");
  await mkdir(components);
  await mkdir(screens);
  await writeFile(
    path.join(components, "Leaf.tsx"),
    'export function Leaf({ value }: { value: string }) { return <output>{value}</output>; }'
  );
  const screen = path.join(screens, "Screen.tsx");
  await writeFile(
    screen,
    `
      import { useState } from "react";
      import { Leaf } from "../components/Leaf";
      export function Screen() {
        const [value, setValue] = useState("idle");
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
          <button onClick={() => setValue("done")}>Done</button><Leaf value={value} /></main>;
      }
    `
  );

  const focused = await analyzePath(screen);
  assert.equal(focused.findings[0]?.action, "use-observable");

  const context = await createAnalysisContext(root);
  const contextual = await analyzePath(screen, context);
  assert.equal(contextual.files, 1);
  assert.equal(contextual.findings[0]?.location.file, "Screen.tsx");
  assert.equal(contextual.findings[0]?.action, "use-observable");
});

test("rejects targets outside a shared analysis project", async t => {
  const contextRoot = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-context-root-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-target-root-"));
  t.after(() => rm(contextRoot, { force: true, recursive: true }));
  t.after(() => rm(targetRoot, { force: true, recursive: true }));
  await writeFile(path.join(contextRoot, "owned.ts"), "export const owned = true;", "utf8");
  const targetPath = path.join(targetRoot, "foreign.ts");
  await writeFile(targetPath, "export const foreign = true;", "utf8");

  const context = await createAnalysisContext(contextRoot);

  await assert.rejects(
    analyzePath(targetPath, context),
    /analysis context does not own target file/
  );
});

test("uses cross-file observable provenance for batching findings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-observable-import-"));
  try {
    await mkdir(path.join(root, "state"), { recursive: true });
    await writeFile(
      path.join(root, "state", "player.ts"),
      `
        import { observable } from "@legendapp/state";
        export const player$ = observable({ loading: false, error: null as string | null });
      `,
      "utf8"
    );
    await writeFile(
      path.join(root, "screen.ts"),
      `
        import { player$ } from "./state/player";
        export function fail(message: string) {
          player$.error.set(message);
          player$.loading.set(false);
        }
      `,
      "utf8"
    );

    const report = await analyzePath(root);
    assert.equal(report.practices.length, 1);
    assert.equal(report.practices[0]?.action, "assign-observable-fields");
    assert.equal(report.practices[0]?.location.file, "screen.ts");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("uses typed project factory provenance for narrow leaf subscriptions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-observable-factory-"));
  try {
    await writeFile(
      path.join(root, "create-store.ts"),
      `
        import { observable, type Observable } from "@legendapp/state";
        export function createStore<T>(value: T): Observable<T> {
          return observable(value);
        }
      `,
      "utf8"
    );
    await writeFile(
      path.join(root, "screen.tsx"),
      `
        import { useValue } from "@legendapp/state/react";
        import { createStore } from "./create-store";
        const state$ = createStore({ profile: { name: "Ada", email: "ada@example.com" } });
        function Name(profile$: typeof state$.profile) {
          const profile = useValue(profile$);
          return <span>{profile.name}</span>;
        }
        export function Screen() { return <span>{Name(state$.profile)}</span>; }
      `,
      "utf8"
    );

    const report = await analyzePath(root);
    assert.deepEqual(report.practices.map(finding => finding.action), [
      "narrow-use-value-subscription",
    ]);
    assert.match(report.practices[0]?.message ?? "", /useValue\(profile\$\.name\)/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("uses cross-file observable provenance for direct useValue findings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-observable-read-"));
  try {
    await mkdir(path.join(root, "state"), { recursive: true });
    await writeFile(
      path.join(root, "state", "theme.ts"),
      `
        import { observable } from "@legendapp/state";
        export const theme$ = observable({ accent: "blue" });
      `,
      "utf8"
    );
    await writeFile(
      path.join(root, "screen.tsx"),
      `
        import { useValue as observe } from "@legendapp/state/react";
        import { theme$ } from "./state/theme";
        export function Screen() {
          return <span>{observe(() => theme$.accent.get())}</span>;
        }
      `,
      "utf8"
    );

    const report = await analyzePath(root);
    assert.equal(report.practices.length, 1);
    assert.equal(report.practices[0]?.action, "pass-observable-to-use-value");
    assert.equal(report.practices[0]?.location.file, "screen.tsx");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("analyzes useValue-only files for the narrowest observable child", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-observable-child-read-"));
  try {
    await mkdir(path.join(root, "state"), { recursive: true });
    await writeFile(
      path.join(root, "state", "profile.ts"),
      `
        import { observable } from "@legendapp/state";
        export const profile$ = observable({ name: "Ada", email: "ada@example.com" });
      `,
      "utf8"
    );
    await writeFile(
      path.join(root, "screen.tsx"),
      `
        import { useValue } from "@legendapp/state/react";
        import { profile$ } from "./state/profile";
        export function Screen() {
          const profile = useValue(profile$);
          return <span>{profile.name}</span>;
        }
      `,
      "utf8"
    );

    const report = await analyzePath(root);
    assert.equal(report.practices.length, 1);
    assert.equal(report.practices[0]?.action, "narrow-use-value-subscription");
    assert.equal(report.practices[0]?.location.file, "screen.tsx");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("places an observable subscription at one resolved child call site", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-contract-"));
  await writeFile(
    path.join(root, "StatusLeaf.tsx"),
    'export function StatusLeaf({ busy }: { busy: boolean }) { return <span>{busy ? "Busy" : "Ready"}</span>; }'
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { StatusLeaf } from "./StatusLeaf";
      export function Screen() {
        const [busy, setBusy] = useState(false);
        const run = async () => { setBusy(true); await work(); setBusy(false); };
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><StatusLeaf busy={busy} onRun={run} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "busy");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /stable `StatusLeaf` call site/);
});

test("does not require child prop semantics for a call-site subscription wrapper", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-call-site-"));
  await writeFile(
    path.join(root, "Leaf.tsx"),
    `
      import { useEffect } from "react";
      export function Leaf({ open }: { open: boolean }) {
        useEffect(() => report(open), [open]);
        return <aside />;
      }
    `
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { Leaf } from "./Leaf";
      export function Screen() {
        const [open, setOpen] = useState(false);
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={() => setOpen(true)} /><Leaf open={open} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "open");
  assert.equal(finding?.action, "use-observable");
});

test("wraps a shared primitive locally without changing its API", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-shared-primitive-"));
  await mkdir(path.join(root, "components", "ui"), { recursive: true });
  await writeFile(
    path.join(root, "components", "ui", "Dialog.tsx"),
    'export function Dialog({ open }: { open: boolean }) { return open ? <aside /> : null; }'
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { Dialog } from "./components/ui/Dialog";
      export function Screen() {
        const [open, setOpen] = useState(false);
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={() => setOpen(true)} /><Dialog open={open} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "open");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /call-site leaf wrapper/);
});

test("moves non-boolean controlled state into a stable local wrapper", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-controlled-call-site-"));
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { Tabs } from "some-ui-library";
      export function Screen() {
        const [tab, setTab] = useState("summary");
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><Tabs value={tab} onValueChange={setTab} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "tab");
  assert.equal(finding?.action, "move-state-down");
  assert.match(finding?.message ?? "", /stable local wrapper/);
});

test("does not create a second observable for state initialized from a hook result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-hook-initializer-"));
  await writeFile(
    path.join(root, "Input.tsx"),
    'export function Input({ value, onChange }: { value: string; onChange: (value: string) => void }) { return <input value={value} onChange={event => onChange(event.target.value)} />; }'
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { Input } from "./Input";
      export function Screen() {
        const saved = useWriterName();
        const [name, setName] = useState(saved);
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><Input value={name} onChange={setName} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "name");
  assert.notEqual(finding?.action, "use-observable");
});

test("allows repeated row commands when the value has one stable leaf consumer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-repeated-command-"));
  await writeFile(
    path.join(root, "Leaves.tsx"),
    `
      export function Row({ onSelect }: { onSelect: (id: string) => void }) { return <button onClick={() => onSelect("x")} />; }
      export function Dialog({ selected }: { selected: string | null }) { return selected ? <aside /> : null; }
    `
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { Dialog, Row } from "./Leaves";
      export function Screen({ rows }: { rows: string[] }) {
        const [selected, setSelected] = useState<string | null>(null);
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview />{rows.map(row => <Row key={row} onSelect={setSelected} />)}
          <Dialog selected={selected} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "selected");
  assert.equal(finding?.action, "use-observable");
});

test("keeps observable ownership stable when its one leaf subscription mounts conditionally", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-contract-conditional-"));
  await writeFile(
    path.join(root, "StatusLeaf.tsx"),
    'export function StatusLeaf({ busy }: { busy: boolean }) { return <span>{busy ? "Busy" : "Ready"}</span>; }'
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { StatusLeaf } from "./StatusLeaf";
      export function Screen({ visible }: { visible: boolean }) {
        const [busy, setBusy] = useState(false);
        const run = async () => { setBusy(true); await work(); setBusy(false); };
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview />{visible ? <StatusLeaf busy={busy} onRun={run} /> : null}</main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "busy");
  assert.equal(finding?.action, "use-observable");
});

test("does not promote one imported-child state when its writes still invalidate the owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-contract-cluster-"));
  await writeFile(
    path.join(root, "DialogLeaf.tsx"),
    'export function DialogLeaf({ open }: { open: boolean }) { return open ? <aside /> : null; }'
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { DialogLeaf } from "./DialogLeaf";
      export function Screen() {
        const [open, setOpen] = useState(false);
        const [selection, setSelection] = useState<string | null>(null);
        const show = (id: string) => { setSelection(id); setOpen(true); };
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={() => show("a")} />
          <span>{selection}</span><DialogLeaf open={open} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "open");
  assert.notEqual(finding?.action, "use-observable");
});

test("does not promote imported-child state written by an effect", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-contract-effect-"));
  await writeFile(
    path.join(root, "StatusLeaf.tsx"),
    'export function StatusLeaf({ busy }: { busy: boolean }) { return <span>{busy ? "Busy" : "Ready"}</span>; }'
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useEffect, useState } from "react";
      import { StatusLeaf } from "./StatusLeaf";
      export function Screen({ running }: { running: boolean }) {
        const [busy, setBusy] = useState(false);
        useEffect(() => setBusy(running), [running]);
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><StatusLeaf busy={busy} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "busy");
  assert.notEqual(finding?.action, "use-observable");
});

test("does not promote a leaf call site when commands share reactive mutation ownership", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-leaf-mutation-"));
  await writeFile(
    path.join(root, "StatusLeaf.tsx"),
    'export function StatusLeaf({ busy }: { busy: boolean }) { return <span>{busy ? "Busy" : "Ready"}</span>; }'
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { StatusLeaf } from "./StatusLeaf";
      export function Screen() {
        const { mutateAsync: save } = useSave();
        const [busy, setBusy] = useState(false);
        const run = async () => { setBusy(true); try { await save(); } finally { setBusy(false); } };
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={run} /><StatusLeaf busy={busy} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "busy");
  assert.notEqual(finding?.action, "use-observable");
});

test("does not promote a leaf call site inside an opaque render callback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-render-callback-"));
  await writeFile(path.join(root, "StatusLeaf.tsx"), 'export function StatusLeaf({ busy }: { busy: boolean }) { return <span>{String(busy)}</span>; }');
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { StatusLeaf } from "./StatusLeaf";
      export function Screen() {
        const [busy, setBusy] = useState(false);
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={() => setBusy(true)} />
          <VirtualList renderItem={() => <StatusLeaf busy={busy} />} /></main>;
      }
    `
  );
  const finding = (await analyzePath(root)).findings.find(candidate => candidate.name === "busy");
  assert.notEqual(finding?.action, "use-observable");
});

test("does not miss reactive mutation ownership through a hook result object", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-object-mutation-"));
  await writeFile(path.join(root, "StatusLeaf.tsx"), 'export function StatusLeaf({ busy }: { busy: boolean }) { return <span>{String(busy)}</span>; }');
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { StatusLeaf } from "./StatusLeaf";
      export function Screen() {
        const save = useSave();
        const [busy, setBusy] = useState(false);
        const run = async () => { setBusy(true); try { await save.mutateAsync(); } finally { setBusy(false); } };
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={run} /><StatusLeaf busy={busy} /></main>;
      }
    `
  );
  const finding = (await analyzePath(root)).findings.find(candidate => candidate.name === "busy");
  assert.notEqual(finding?.action, "use-observable");
});

test("does not put nullable callable state into a leaf observable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-callable-leaf-"));
  await writeFile(path.join(root, "Slot.tsx"), 'export function Slot({ value }: { value: (() => void) | null }) { return <button onClick={value ?? undefined} />; }');
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { Slot } from "./Slot";
      export function Screen() {
        const [callback, setCallback] = useState<(() => void) | null>(null);
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={() => setCallback(() => work)} /><Slot value={callback} /></main>;
      }
    `
  );
  const finding = (await analyzePath(root)).findings.find(candidate => candidate.name === "callback");
  assert.notEqual(finding?.action, "use-observable");
});
