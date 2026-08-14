import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildSourceIndex } from "../src/source-components.js";

async function withProject(
  files: Readonly<Record<string, string>>,
  run: (root: string, sources: ReadonlyMap<string, string>) => void | Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-components-"));
  try {
    const sources = new Map<string, string>();
    for (const [relative, source] of Object.entries(files)) {
      const file = path.join(root, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, source, "utf8");
      sources.set(file, source);
    }
    await run(root, sources);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("resolves named, default, and barrel-exported source components", async () => {
  await withProject(
    {
      "feature/DefaultLeaf.tsx": "export default function () { return <div />; }",
      "feature/NamedLeaf.tsx": "export function NamedLeaf() { return <div />; }",
      "feature/index.ts": 'export { NamedLeaf } from "./NamedLeaf"; export { default as DefaultLeaf } from "./DefaultLeaf";',
      "screen.tsx": 'import { DefaultLeaf, NamedLeaf } from "./feature"; export function Screen() { return <><DefaultLeaf /><NamedLeaf /></>; }',
    },
    (root, sources) => {
      const components = buildSourceIndex(root, sources).componentsFor(path.join(root, "screen.tsx"));
      assert.deepEqual([...components].sort(), ["DefaultLeaf", "NamedLeaf"]);
    }
  );
});

test("indexes shared UI components as provenance without deciding leaf safety", async () => {
  await withProject(
    {
      "components/ui/calendar.tsx": "export function Calendar() { return <div />; }",
      "components/ui/dropdown-menu.tsx": "export function DropdownMenu() { return <div />; }",
      "screen.tsx": 'import { Calendar } from "./components/ui/calendar"; import { DropdownMenu } from "./components/ui/dropdown-menu"; export function Screen() { return <><Calendar /><DropdownMenu /></>; }',
    },
    (root, sources) => {
      const components = buildSourceIndex(root, sources).componentsFor(path.join(root, "screen.tsx"));
      assert.deepEqual([...components].sort(), ["Calendar", "DropdownMenu"]);
    }
  );
});

test("resolves each import with its nearest application tsconfig", async () => {
  await withProject(
    {
      "tsconfig.json": '{"compilerOptions":{"moduleResolution":"Bundler"}}',
      "apps/web/tsconfig.json": '{"compilerOptions":{"moduleResolution":"Bundler","baseUrl":".","paths":{"@/*":["src/*"]}}}',
      "apps/web/src/Leaf.tsx": 'export function Leaf({ open }: { open: boolean }) { return open ? <aside /> : null; }',
      "apps/web/src/Screen.tsx": 'import { Leaf } from "@/Leaf"; export function Screen() { return <Leaf open={false} />; }',
    },
    (root, sources) => {
      const components = buildSourceIndex(root, sources)
        .componentsFor(path.join(root, "apps/web/src/Screen.tsx"));
      assert.deepEqual([...components], ["Leaf"]);
    }
  );
});

test("resolves exported Legend observables through aliases and barrels", async () => {
  await withProject(
    {
      "state/player.ts": `
        import { observable as createObservable } from "@legendapp/state";
        export const player$ = createObservable({ loading: false, error: null });
        export const map$ = new Map();
      `,
      "state/index.ts": 'export { player$ as playback$ } from "./player";',
      "screen.ts": 'import { playback$ as audio$ } from "./state";',
    },
    (root, sources) => {
      const observables = buildSourceIndex(root, sources)
        .observablesFor(path.join(root, "screen.ts"));
      assert.deepEqual([...observables], ["audio$"]);
    }
  );
});

test("resolves observables created by explicitly typed project factories", async () => {
  await withProject(
    {
      "create-store.ts": `
        import { observable, type Observable as LegendObservable } from "@legendapp/state";
        export function createStore<T>(value: T): LegendObservable<T> {
          return observable(value);
        }
      `,
      "theme.ts": `
        import { createStore as makeStore } from "./create-store";
        export const theme$ = makeStore({ accent: "blue" });
      `,
      "screen.ts": 'import { theme$ as appTheme$ } from "./theme";',
    },
    (root, sources) => {
      const index = buildSourceIndex(root, sources);
      const factories = index.observableFactoriesFor(path.join(root, "theme.ts"));
      const observables = index
        .observablesFor(path.join(root, "screen.ts"));
      assert.deepEqual([...factories], ["makeStore"]);
      assert.deepEqual([...observables], ["appTheme$"]);
    }
  );
});

test("does not expose untyped project helpers as observable factories", async () => {
  await withProject(
    {
      "create-store.ts": "export function createStore<T>(value: T): T { return value; }",
      "screen.ts": 'import { createStore as makeStore } from "./create-store";',
    },
    (root, sources) => {
      const factories = buildSourceIndex(root, sources)
        .observableFactoriesFor(path.join(root, "screen.ts"));
      assert.deepEqual([...factories], []);
    }
  );
});

test("does not infer exported observables from names or unrelated factories", async () => {
  await withProject(
    {
      "state.ts": `
        const observable = makeStore;
        export const fake$ = observable({ first: "", second: "" });
        export const map$ = new Map();
      `,
      "screen.ts": 'import { fake$, map$ } from "./state";',
    },
    (root, sources) => {
      const observables = buildSourceIndex(root, sources)
        .observablesFor(path.join(root, "screen.ts"));
      assert.deepEqual([...observables], []);
    }
  );
});
