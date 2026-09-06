import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { ReactCompilerResolver } from "../../src/project/react-compiler-package.js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("config discovery preserves the filesystem's case matching", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-compiler-case-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(path.join(root, "NEXT.CONFIG.JS"), "export default { reactCompiler: true };");

  // The directory optimization must accept exactly the same spelling as a direct file read.
  const readableByConfiguredName = existsSync(path.join(root, "next.config.js"));
  const resolver = new ReactCompilerResolver();
  assert.equal(await resolver.compilesDirectory(root), readableByConfiguredName);
});
