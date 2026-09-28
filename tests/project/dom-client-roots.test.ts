import { ConcurrentRootResolver } from "../../src/project/concurrent-root-workspace.js";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { withProject } from "./with-project.js";

const APP_FILE = "src/app.tsx";
const ENTRY_FILE = "src/main.tsx";
/** Workspace discovery recognizes npm, Yarn, and Bun roots only beside their lockfile. */
const NPM_LOCKFILE = { "package-lock.json": "{}" };
const REACT_18 = { react: "^18.3.1", "react-dom": "^18.3.1" };
const CREATE_ROOT_ENTRY = `
import { createRoot } from "react-dom/client";
import { App } from "./app";

createRoot(document.getElementById("root")!).render(<App />);
`;
const LEGACY_RENDER_ENTRY = `
import ReactDOM from "react-dom";
import { App } from "./app";

ReactDOM.render(<App />, document.getElementById("root"));
`;

/** Relative file paths mapped to their contents. */
type ProjectFiles = Readonly<Record<string, string>>;

function app(dependencies: Readonly<Record<string, string>>, name = "app"): string {
  return JSON.stringify({ dependencies, name, private: true });
}

async function rendersConcurrently(files: ProjectFiles): Promise<boolean> {
  let verdict = false;
  await withProject({ [APP_FILE]: "export function App() {}", ...files }, async (root) => {
    verdict = await new ConcurrentRootResolver().rendersFileConcurrently(path.join(root, APP_FILE));
  });
  return verdict;
}

test("React DOM 18 roots created only through react-dom/client prove a concurrent workspace", async () => {
  for (const [label, entry] of [
    ["named createRoot", CREATE_ROOT_ENTRY],
    [
      "aliased hydrateRoot",
      `import { hydrateRoot as hydrate } from "react-dom/client";\nhydrate(document.body, <App />);`,
    ],
    [
      "default import",
      `import ReactDOM from "react-dom/client";\nReactDOM.createRoot(document.body).render(<App />);`,
    ],
    [
      "namespace import",
      `import * as Client from "react-dom/client";\nClient.hydrateRoot(document.body, <App />);`,
    ],
    [
      "non-root react-dom exports beside the client root",
      `import ReactDOM, { flushSync } from "react-dom";\nimport { createRoot } from "react-dom/client";\nlet container: ReactDOM.Container;\nexport const portal = ReactDOM.createPortal(null, document.body);\nflushSync(() => createRoot(document.body).render(<App />));`,
    ],
  ] as const) {
    assert.equal(
      await rendersConcurrently({ [ENTRY_FILE]: entry, "package.json": app(REACT_18) }),
      true,
      label,
    );
  }
});

test("a React DOM 18 root created any other way keeps the workspace unproven", async () => {
  for (const [label, second] of [
    ["ReactDOM.render", LEGACY_RENDER_ENTRY],
    ["named hydrate", `import { hydrate } from "react-dom";\nhydrate(<App />, document.body);`],
    [
      "subtree render",
      `import * as Dom from "react-dom";\nDom.unstable_renderSubtreeIntoContainer(null, <App />, document.body);`,
    ],
    [
      "createRoot from the legacy entry point",
      `import { createRoot } from "react-dom";\ncreateRoot(document.body);`,
    ],
    ["profiling entry point", `import { render } from "react-dom/profiling";`],
    [
      "computed member",
      `import ReactDOM from "react-dom";\nReactDOM["render"](<App />, document.body);`,
    ],
    ["escaping namespace", `import ReactDOM from "react-dom";\nexport const dom = ReactDOM;`],
    ["require", `const { render } = require("react-dom");`],
    ["dynamic import", `export const dom = import("react-dom");`],
    ["import equals", `import ReactDOM = require("react-dom");`],
    ["star re-export", `export * from "react-dom";`],
    ["named re-export", `export { render as mount } from "react-dom";`],
    ["UMD global", `ReactDOM.render(<App />, document.body);`],
  ] as const) {
    assert.equal(
      await rendersConcurrently({
        [ENTRY_FILE]: CREATE_ROOT_ENTRY,
        "package.json": app(REACT_18),
        "src/other.tsx": second,
      }),
      false,
      label,
    );
  }
});

test("a React DOM 18 package whose root the scan cannot find stays unproven", async () => {
  for (const [label, files] of [
    ["no entry point", {}],
    ["root only in build output", { "dist/main.js": CREATE_ROOT_ENTRY }],
    ["root only in a declaration file", { "src/main.d.ts": CREATE_ROOT_ENTRY }],
    ["type-only client import", { [ENTRY_FILE]: `import type { Root } from "react-dom/client";` }],
    [
      "shadowed client import",
      {
        [ENTRY_FILE]: `import { createRoot } from "react-dom/client";\nexport function mount(createRoot: () => void) {\n  createRoot();\n}`,
      },
    ],
  ] as const) {
    assert.equal(
      await rendersConcurrently({ ...files, "package.json": app(REACT_18) }),
      false,
      label,
    );
  }
});

test("renderers that lack a client root or answer for consumers stay unproven despite createRoot", async () => {
  for (const [label, manifest] of [
    ["React DOM 17", app({ react: "^17.0.2", "react-dom": "^17.0.2" })],
    ["React DOM 18 peer range", JSON.stringify({ name: "ui", peerDependencies: REACT_18 })],
  ] as const) {
    assert.equal(
      await rendersConcurrently({ [ENTRY_FILE]: CREATE_ROOT_ENTRY, "package.json": manifest }),
      false,
      label,
    );
  }
});

test("every React DOM 18 package in a workspace must create its own client root", async () => {
  const workspace = {
    ...NPM_LOCKFILE,
    "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["apps/*"] }),
    "apps/web/package.json": app(REACT_18, "web"),
    "apps/web/src/main.tsx": CREATE_ROOT_ENTRY,
    "apps/web/src/app.tsx": "export function App() {}",
  };
  const file = "apps/web/src/app.tsx";
  for (const [label, admin, expected] of [
    ["single app", {}, true],
    [
      "second app on a legacy root",
      {
        "apps/admin/package.json": app(REACT_18, "admin"),
        "apps/admin/src/main.tsx": LEGACY_RENDER_ENTRY,
      },
      false,
    ],
    ["second app without a root", { "apps/admin/package.json": app(REACT_18, "admin") }, false],
    [
      "second app with its own client root",
      {
        "apps/admin/package.json": app(REACT_18, "admin"),
        "apps/admin/src/main.tsx": CREATE_ROOT_ENTRY,
      },
      true,
    ],
  ] as const) {
    let verdict = false;
    await withProject({ ...workspace, ...admin }, async (root) => {
      verdict = await new ConcurrentRootResolver().rendersFileConcurrently(path.join(root, file));
    });
    assert.equal(verdict, expected, label);
  }
});

test("Next.js 13.1 and later create the root of a React DOM 18 app without app source", async () => {
  for (const [label, next, expected] of [
    ["Next.js 14", "^14.2.3", true],
    ["Next.js 13.1", "13.1.0", true],
    ["Next.js 13.0 falls back to ReactDOM.render", "13.0.0", false],
    ["Next.js 12", "^12.3.4", false],
  ] as const) {
    assert.equal(
      await rendersConcurrently({ "package.json": app({ ...REACT_18, next }) }),
      expected,
      label,
    );
  }
  assert.equal(
    await rendersConcurrently({
      "package.json": app({ ...REACT_18, next: "^14.2.3" }),
      "src/legacy.tsx": LEGACY_RENDER_ENTRY,
    }),
    false,
    "a legacy root beside Next.js",
  );
});
