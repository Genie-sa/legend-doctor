import {
  buildSourceIndex,
  buildSourceIndexFromFiles,
} from "../../src/project/source-components/source-components.js";
import { AnalysisProject } from "../../src/project/analysis-project.js";
import type { SourceResolution } from "../../src/project/source-components/module-resolution.js";
import assert from "node:assert/strict";
import { createCompilerContextCaches } from "../../src/project/source-components/module-resolution.js";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { withProject } from "./with-project.js";

test("resolves factory-created observables without a direct observable declaration", async () => {
  await withProject(
    {
      "factory.ts": `
        import type { Observable } from "@legendapp/state";
        export declare function createStore(): Observable<{ count: number }>;
      `,
      "store.ts": 'import { createStore } from "./factory"; export const store = createStore();',
      "barrel.ts": 'export { store as counter } from "./store";',
      "consumer.ts": 'import { counter } from "./barrel";',
    },
    (root, sources) => {
      const index = buildSourceIndex(root, sources);
      assert.deepEqual([...index.observablesFor(path.join(root, "consumer.ts"))], ["counter"]);
    },
  );
});

test("checks import shadowing even when no styled component triggered an eager lookup", async () => {
  await withProject(
    {
      "plain.tsx": `
        import { View as Surface } from "react-native";
        export function Plain() { return <Surface />; }
      `,
      "shadowed.tsx": `
        import { View as Surface } from "react-native";
        export function Shadowed({ Surface }: { Surface: () => null }) { return <Surface />; }
      `,
    },
    (root, sources) => {
      const index = buildSourceIndex(root, sources);
      assert.equal(index.frameworkEventComponentFor(path.join(root, "plain.tsx"), "Surface"), true);
      assert.equal(
        index.frameworkEventComponentFor(path.join(root, "shadowed.tsx"), "Surface"),
        false,
      );
    },
  );
});

test("container lookups include an aliased mutation without mixing same-named declarations", async () => {
  await withProject(
    {
      "first.ts":
        'import { observable } from "@legendapp/state"; export const store = { value$: observable(0) };',
      "second.ts":
        'import { observable } from "@legendapp/state"; export const store = { value$: observable(1) };',
      "barrel.ts": 'export { store as renamed } from "./first";',
      "mutation.ts": 'import { renamed as alias } from "./barrel"; alias.value$ = replacement;',
      "consumer.ts":
        'import { store as first } from "./first"; import { store as second } from "./second";',
    },
    (root, sources) => {
      const index = buildSourceIndex(root, sources);
      assert.deepEqual(
        [...index.observablePathsFor(path.join(root, "consumer.ts"))],
        ["second.value$"],
      );
    },
  );
});

test("new source indexes see local escapes and added aliases without changing the old snapshot", async () => {
  await withProject(
    {
      "store.ts":
        'import { observable } from "@legendapp/state"; export const store = { value$: observable(0) };',
      "consumer.ts": 'import { store } from "./store";',
    },
    (root, sources) => {
      const consumer = path.join(root, "consumer.ts");
      const original = buildSourceIndex(root, sources);
      assert.deepEqual([...original.observablePathsFor(consumer)], ["store.value$"]);

      const storeFile = path.join(root, "store.ts");
      const updated = new Map([
        ...sources,
        [storeFile, `${sources.get(storeFile)}\npublish(store);`],
      ]);
      const changed = buildSourceIndex(root, updated);
      assert.deepEqual([...changed.observablePathsFor(consumer)], []);

      const withAlias = new Map([
        ...sources,
        [
          path.join(root, "mutation.ts"),
          'import { store as alias } from "./store"; alias.value$ = replacement;',
        ],
      ]);
      const aliased = buildSourceIndex(root, withAlias);
      assert.deepEqual([...aliased.observablePathsFor(consumer)], []);
      assert.deepEqual([...original.observablePathsFor(consumer)], ["store.value$"]);
    },
  );
});

test("source indexes sharing one resolution probe the file system for an import once", async () => {
  await withProject(
    {
      "store.ts": "export const store = 1;",
      "consumer.ts": 'import { store } from "./store";',
    },
    (root, sources) => {
      let fileProbes = 0;
      const resolution: SourceResolution = {
        caches: createCompilerContextCaches(),
        host: {
          ...ts.sys,
          fileExists: (file) => {
            fileProbes += 1;
            return ts.sys.fileExists(file);
          },
        },
      };
      const { files } = new AnalysisProject(sources);
      const consumer = path.join(root, "consumer.ts");
      const resolveStore = (): string | null =>
        buildSourceIndexFromFiles(root, files, resolution).moduleFileFor(consumer, "./store");

      const store = resolveStore();
      assert.notEqual(store, null);
      const probesForFirstIndex = fileProbes;
      assert.ok(probesForFirstIndex > 0);

      assert.equal(resolveStore(), store);
      assert.equal(fileProbes, probesForFirstIndex);
    },
  );
});
