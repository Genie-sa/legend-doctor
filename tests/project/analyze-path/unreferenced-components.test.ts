import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { HookFinding } from "../../../src/core/types.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const APPLICATION_MANIFEST = JSON.stringify({ name: "app", private: true });

const PANEL_BODY = `
  const [open, setOpen] = useState(false);
  return (
    <main>
      <header><h1>Files</h1><p>Upload center</p></header>
      <section><p>One</p><p>Two</p><p>Three</p><p>Four</p></section>
      <aside><p>Tips</p><p>Limits</p></aside>
      <footer><button onClick={() => setOpen(!open)}>{open ? "Close" : "Open"}</button></footer>
    </main>
  );
`;

const PANEL = `
  import { useState } from "react";
  export function Panel() {${PANEL_BODY}}
`;

const ROOT_ENTRY = `
  import { createRoot } from "react-dom/client";
  createRoot(document.body).render(<p>Home</p>);
`;

const RENDERING_APP = `
  import { Panel } from "./Panel";
  export function App() {
    return <Panel />;
  }
`;

async function renderedAction(): Promise<HookFinding["action"]> {
  const action = await openAction({ "App.tsx": RENDERING_APP, "Panel.tsx": PANEL });
  assert.notEqual(action, "keep-state");
  return action;
}

async function openAction(
  files: Readonly<Record<string, string>>,
  { entry = ROOT_ENTRY, manifest = APPLICATION_MANIFEST, scanDirectory = "." } = {},
): Promise<HookFinding["action"]> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-unreferenced-"));
  try {
    await Promise.all(
      Object.entries({ "main.tsx": entry, "package.json": manifest, ...files }).map(
        async ([name, source]) => {
          await mkdir(path.dirname(path.join(root, name)), { recursive: true });
          await writeFile(path.join(root, name), source, "utf8");
        },
      ),
    );
    const report = await analyzePath(path.join(root, scanDirectory));
    const finding = report.findings.find(
      (candidate) => candidate.hook === "useState" && candidate.name === "open",
    );
    assert.ok(finding, "missing state open");
    return finding.action;
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("keeps state in a component no production source renders", async () => {
  await renderedAction();
  assert.equal(await openAction({ "Panel.tsx": PANEL }), "keep-state");
  assert.equal(
    await openAction({
      "App.tsx": `
        import { Panel } from "./Panel";
        export function App() {
          return <div>{/* <Panel /> */}</div>;
        }
      `,
      "Panel.tsx": PANEL,
    }),
    "keep-state",
  );
  assert.equal(
    await openAction({
      "Panel.test.tsx": `
        import { Panel } from "./Panel";
        export const rendered = <Panel />;
      `,
      "Panel.tsx": PANEL,
    }),
    "keep-state",
  );
  assert.equal(
    await openAction({
      "Panel.tsx": `${PANEL}\nPanel.displayName = "Panel";`,
      "index.ts": `export { Panel } from "./Panel";`,
    }),
    "keep-state",
  );
  assert.equal(
    await openAction(
      { "Panel.tsx": PANEL, "app/index.tsx": `export default () => null;` },
      {
        entry: "",
      },
    ),
    "keep-state",
  );
});

test("treats a component as rendered when unseen code could reach it", async () => {
  const rendered = await renderedAction();
  const reachable = {
    "default export": {
      "Panel.tsx": `import { useState } from "react";\nexport default function Panel() {${PANEL_BODY}}`,
    },
    "dynamic import": {
      "App.tsx": `export const load = () => import("./Panel");`,
      "Panel.tsx": PANEL,
    },
    "file-system route": { "app/Panel.tsx": PANEL },
    "namespace import": {
      "App.tsx": `import * as Panels from "./Panel";\nexport const panels = Panels;`,
      "Panel.tsx": PANEL,
    },
    "value reference": {
      "App.tsx": `import { Panel } from "./Panel";\nexport const screens = { Panel };`,
      "Panel.tsx": PANEL,
    },
  };
  for (const [reach, files] of Object.entries(reachable)) {
    assert.equal(await openAction(files), rendered, reach);
  }
});

test("treats a component as rendered when its package is not a closed application", async () => {
  const rendered = await renderedAction();
  assert.equal(await openAction({ "Panel.tsx": PANEL }, { entry: "" }), rendered);
  assert.equal(
    await openAction(
      { "Panel.tsx": PANEL },
      { manifest: JSON.stringify({ exports: "./Panel.tsx", name: "ui", private: true }) },
    ),
    rendered,
  );
  assert.equal(
    await openAction(
      {
        "extension/popup.tsx": `
          import { Panel } from "../src/Panel";
          export function Popup() {
            return <Panel />;
          }
        `,
        "src/Panel.tsx": PANEL,
      },
      { scanDirectory: "src" },
    ),
    rendered,
  );
});
