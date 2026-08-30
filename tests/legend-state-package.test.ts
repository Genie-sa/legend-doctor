import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveInstalledLegendState } from "../src/legend-state-package.js";

async function writeInstalledPackage(
  root: string,
  manifest: Record<string, unknown>,
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

test("resolves an aliased useValue export from the installed react declarations", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-package-alias-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeInstalledPackage(
    root,
    { name: "@legendapp/state", version: "3.0.0-beta.48" },
    { "react.d.ts": "export { useSelector as use$, useSelector, useSelector as useValue };" },
  );

  assert.deepEqual(await resolveInstalledLegendState(root), {
    useValueExport: "alias",
    version: "3.0.0-beta.48",
  });
});

test("resolves declarations through the exports map and walks up from nested roots", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-package-exports-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeInstalledPackage(
    root,
    {
      exports: { "./react": { types: "./dist/types/react.d.ts" } },
      name: "@legendapp/state",
      version: "3.0.0",
    },
    { "dist/types/react.d.ts": "export declare function useValue<T>(selector: T): T;" },
  );
  const nested = path.join(root, "packages", "app");
  await mkdir(nested, { recursive: true });

  assert.deepEqual(await resolveInstalledLegendState(nested), {
    useValueExport: "distinct",
    version: "3.0.0",
  });
});

test("reports missing useValue and unresolvable declarations distinctly", async (t) => {
  const missingRoot = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-package-missing-")),
    unknownRoot = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-package-unknown-"));
  t.after(() => rm(missingRoot, { force: true, recursive: true }));
  t.after(() => rm(unknownRoot, { force: true, recursive: true }));
  await writeInstalledPackage(
    missingRoot,
    { name: "@legendapp/state", version: "2.1.0" },
    { "react.d.ts": "export { useSelector };" },
  );
  await writeInstalledPackage(unknownRoot, { name: "@legendapp/state", version: "2.1.0" });

  assert.deepEqual(await resolveInstalledLegendState(missingRoot), {
    useValueExport: "missing",
    version: "2.1.0",
  });
  assert.deepEqual(await resolveInstalledLegendState(unknownRoot), {
    useValueExport: "unknown",
    version: "2.1.0",
  });
});

test("returns null when no @legendapp/state package is installed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-package-none-"));
  t.after(() => rm(root, { force: true, recursive: true }));

  assert.equal(await resolveInstalledLegendState(root), null);
});
