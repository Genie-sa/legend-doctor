import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

const STATUS_LEAF =
  'export function StatusLeaf({ busy }: { busy: boolean }) { return <span>{busy ? "Busy" : "Ready"}</span>; }';

async function busyAction(
  testContext: test.TestContext,
  { command, imports }: { readonly command: string; readonly imports: string },
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-setter-dependency-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(path.join(root, "StatusLeaf.tsx"), STATUS_LEAF);
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      ${imports}
      import { StatusLeaf } from "./StatusLeaf";
      export function Screen() {
        const [busy, setBusy] = useState(false);
        ${command}
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={start} /><StatusLeaf busy={busy} /></main>;
      }
    `,
  );
  const report = await analyzePath(root);
  return requireValue(report.findings.find((finding) => finding.name === "busy")).action;
}

test("a setter listed in a hook dependency array does not escape the owner", async (testContext) => {
  const forms = {
    "named hooks": {
      command: "const start = useCallback(() => setBusy(true), [setBusy]);",
      imports: 'import { useCallback, useState } from "react";',
    },
    "React namespace hooks": {
      command: "const start = React.useCallback(() => setBusy(true), [setBusy]);",
      imports: 'import * as React from "react";\nimport { useState } from "react";',
    },
  };
  for (const [name, form] of Object.entries(forms)) {
    assert.equal(await busyAction(testContext, form), "use-observable", name);
  }
});

test("a setter in any other array still escapes the owner", async (testContext) => {
  const action = await busyAction(testContext, {
    command: "const start = useCallback(() => setBusy(true), []);\nregister([setBusy]);",
    imports: 'import { useCallback, useState } from "react";',
  });

  assert.notEqual(action, "use-observable");
});
