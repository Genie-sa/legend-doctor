import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { resolveInstalledLegendState } from "../../src/project/legend-state-package.js";
import test from "node:test";

async function writeInstalledPackage<Manifest extends object>(
  root: string,
  manifest: Manifest,
  declarations: Record<string, string> = {},
): Promise<string> {
  const packageDirectory = path.join(root, "node_modules", "@legendapp", "state");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(path.join(packageDirectory, "package.json"), JSON.stringify(manifest), "utf8");
  for (const [relativePath, text] of Object.entries(declarations)) {
    const filePath = path.join(packageDirectory, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, text, "utf8");
  }
  return packageDirectory;
}

test("resolves an aliased useValue export from the installed react declarations", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-package-alias-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeInstalledPackage(
    root,
    { name: "@legendapp/state", version: "3.0.0-beta.48" },
    {
      "react.d.ts": "export { useSelector as use$, useSelector, useSelector as useValue };",
      "sync.d.ts": "export declare function synced<T>(params: object): T;",
    },
  );

  assert.deepEqual(await resolveInstalledLegendState(root), {
    syncExport: "available",
    useValueExport: "alias",
    version: "3.0.0-beta.48",
  });
});

test("resolves declarations through the exports map and walks up from nested roots", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-package-exports-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeInstalledPackage(
    root,
    {
      exports: {
        "./react": { types: "./dist/types/react.d.ts" },
        "./sync": { types: "./dist/types/sync.d.ts" },
      },
      name: "@legendapp/state",
      version: "3.0.0",
    },
    { "dist/types/react.d.ts": "export declare function useValue<T>(selector: T): T;" },
  );
  const nested = path.join(root, "packages", "app");
  await mkdir(nested, { recursive: true });

  assert.deepEqual(await resolveInstalledLegendState(nested), {
    syncExport: "available",
    useValueExport: "distinct",
    version: "3.0.0",
  });
});

test("reports missing useValue and unresolvable declarations distinctly", async (testContext) => {
  const missingRoot = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-package-missing-"));
  const unknownRoot = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-package-unknown-"));
  testContext.after(() => rm(missingRoot, { force: true, recursive: true }));
  testContext.after(() => rm(unknownRoot, { force: true, recursive: true }));
  await writeInstalledPackage(
    missingRoot,
    {
      exports: { "./persist": "./persist.js", "./react": "./react.js" },
      name: "@legendapp/state",
      version: "2.1.0",
    },
    { "react.d.ts": "export { useSelector };" },
  );
  await writeInstalledPackage(unknownRoot, { name: "@legendapp/state", version: "2.1.0" });

  assert.deepEqual(await resolveInstalledLegendState(missingRoot), {
    syncExport: "missing",
    useValueExport: "missing",
    version: "2.1.0",
  });
  assert.deepEqual(await resolveInstalledLegendState(unknownRoot), {
    syncExport: "unknown",
    useValueExport: "unknown",
    version: "2.1.0",
  });
});

test("returns null when no @legendapp/state package is installed", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-package-none-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));

  assert.equal(await resolveInstalledLegendState(root), null);
});
