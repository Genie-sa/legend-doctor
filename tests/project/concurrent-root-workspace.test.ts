import {
  ConcurrentRootResolver,
  filesRenderingSyncLaneAlone,
} from "../../src/project/concurrent-root-workspace.js";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { withProject } from "./with-project.js";

const APP_FILE = "src/app.tsx";
/** Workspace discovery recognizes npm, Yarn, and Bun roots only beside their lockfile. */
const NPM_LOCKFILE = { "package-lock.json": "{}" };

type Dependencies = Readonly<Record<string, string>>;
/** Relative file paths mapped to their contents. */
type ProjectFiles = Readonly<Record<string, string>>;

interface Manifest {
  readonly dependencies?: Dependencies;
  readonly name?: string;
  readonly peerDependencies?: Dependencies;
  readonly private?: boolean;
  readonly workspaces?:
    | readonly string[]
    | { readonly catalog: Dependencies; readonly packages: readonly string[] };
}

function manifest(fields: Manifest): string {
  return JSON.stringify({ name: "app", private: true, ...fields });
}

async function rendersConcurrently(files: ProjectFiles): Promise<boolean> {
  let verdict = false;
  await withProject({ [APP_FILE]: "export {};", ...files }, async (root) => {
    verdict = await new ConcurrentRootResolver().rendersFileConcurrently(path.join(root, APP_FILE));
  });
  return verdict;
}

test("renderers that removed their legacy root APIs prove a concurrent workspace", async () => {
  for (const [label, dependencies] of [
    ["React Native 0.82", { "react-native": "0.82.0" }],
    ["caret React Native", { "react-native": "^0.86.2" }],
    ["React DOM 19", { "react-dom": "19.2.3", react: "19.2.3" }],
    ["React Native Web on React DOM 19", { "react-dom": "~19.1.0", "react-native": "0.85.3" }],
  ] as const) {
    assert.equal(
      await rendersConcurrently({ "package.json": manifest({ dependencies }) }),
      true,
      label,
    );
  }
});

test("renderers that can still create legacy roots keep the workspace unproven", async () => {
  for (const [label, dependencies] of [
    ["React Native 0.81", { "react-native": "0.81.6" }],
    ["React Native macOS 0.78", { "react-native": "0.82.0", "react-native-macos": "^0.78.3" }],
    ["React DOM 18", { "react-dom": "^18.3.1" }],
    ["alternative ranges", { "react-dom": "^18.2.0 || ^19.0.0" }],
    ["upper-bound range", { "react-dom": "<20" }],
    ["any version", { "react-native": "*" }],
    ["workspace protocol", { "react-dom": "workspace:*" }],
    ["unknown catalog", { "react-dom": "catalog:missing" }],
    ["no renderer", { react: "19.2.3" }],
  ] as const) {
    assert.equal(
      await rendersConcurrently({ "package.json": manifest({ dependencies }) }),
      false,
      label,
    );
  }
});

test("every renderer in the workspace must qualify, not only the file's own package", async () => {
  const workspace = {
    ...NPM_LOCKFILE,
    "package.json": manifest({ workspaces: ["apps/*"] }),
    "apps/mobile/package.json": JSON.stringify({
      dependencies: { "react-native": "0.86.0" },
      name: "mobile",
    }),
  };
  assert.equal(await rendersConcurrently(workspace), true);
  assert.equal(
    await rendersConcurrently({
      ...workspace,
      "apps/desktop/package.json": JSON.stringify({
        dependencies: { "react-native-macos": "0.78.3" },
        name: "desktop",
      }),
    }),
    false,
  );
});

test("published packages answer for their consumers' renderers through peer ranges", async () => {
  const workspace = {
    ...NPM_LOCKFILE,
    "package.json": manifest({ workspaces: ["packages/*"] }),
    "packages/app/package.json": JSON.stringify({
      dependencies: { "react-dom": "19.2.3" },
      name: "web",
    }),
  };
  const library = { name: "ui", peerDependencies: { "react-dom": "^18.2.0 || ^19.0.0" } };
  for (const [label, published, expected] of [
    ["published", library, false],
    ["private", { ...library, private: true }, true],
  ] as const) {
    assert.equal(
      await rendersConcurrently({
        ...workspace,
        "packages/ui/package.json": JSON.stringify(published),
      }),
      expected,
      label,
    );
  }
});

test("a peer range that admits every renderer version constrains nothing, like an omitted peer", async () => {
  const workspace = {
    ...NPM_LOCKFILE,
    "package.json": manifest({ workspaces: ["packages/*"] }),
    "packages/app/package.json": JSON.stringify({
      dependencies: { "react-native": "0.86.3" },
      name: "mobile",
    }),
  };
  for (const [label, library, expected] of [
    ["star peer", { peerDependencies: { "react-native": "*" } }, true],
    ["x peer", { peerDependencies: { "react-native": "x" } }, true],
    ["empty peer", { peerDependencies: { "react-native": "" } }, true],
    [
      "star peer beside a legacy development renderer",
      { devDependencies: { "react-native": "0.81.6" }, peerDependencies: { "react-native": "*" } },
      false,
    ],
    ["bounded legacy peer", { peerDependencies: { "react-native": ">=0.70" } }, false],
  ] as const) {
    assert.equal(
      await rendersConcurrently({
        ...workspace,
        "packages/tabs/package.json": JSON.stringify({ name: "tabs", ...library }),
      }),
      expected,
      label,
    );
  }
});

test("catalog references resolve through pnpm and Bun workspace catalogs", async () => {
  const app = JSON.stringify({ dependencies: { "react-dom": "catalog:" }, name: "web" });
  for (const [catalog, expected] of [
    ["catalog:\n  react-dom: ^19.2.8\n", true],
    ["catalogs:\n  default:\n    react-dom: ^19.2.8\n", true],
    ["catalog:\n  react-dom: ^18.3.1\n", false],
  ] as const) {
    assert.equal(
      await rendersConcurrently({
        "package.json": manifest({}),
        "pnpm-workspace.yaml": `packages:\n  - apps/*\n${catalog}`,
        "apps/web/package.json": app,
      }),
      expected,
      catalog,
    );
  }
  assert.equal(
    await rendersConcurrently({
      "bun.lock": "{}",
      "package.json": manifest({
        workspaces: { catalog: { "react-dom": "19.1.0" }, packages: ["apps/*"] },
      }),
      "apps/web/package.json": app,
    }),
    true,
  );
});

test("a workspace package on React below 19 renders the store's sync lane alone", async () => {
  for (const [label, files, expected] of [
    ["React 18", { "package.json": manifest({ dependencies: { react: "18.3.1" } }) }, true],
    ["React 19", { "package.json": manifest({ dependencies: { react: "^19.1.0" } }) }, false],
    ["no React", { "package.json": manifest({}) }, false],
    [
      "one React 18 package",
      {
        ...NPM_LOCKFILE,
        "package.json": manifest({ workspaces: ["apps/*"] }),
        "apps/web/package.json": JSON.stringify({
          dependencies: { react: "^19.0.0" },
          name: "web",
        }),
        "apps/legacy/package.json": JSON.stringify({
          dependencies: { react: "^18.2.0" },
          name: "old",
        }),
      },
      true,
    ],
  ] as const) {
    let verdict = !expected;
    await withProject({ [APP_FILE]: "export {};", ...files }, async (root) => {
      const file = path.join(root, APP_FILE);
      const aloneFiles = await filesRenderingSyncLaneAlone([file]);
      verdict = aloneFiles.has(file);
    });
    assert.equal(verdict, expected, label);
  }
});
