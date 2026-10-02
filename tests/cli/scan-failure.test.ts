import { failurePayload, writeFixtureRoot } from "./harness.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const OVERFLOWING_CHAIN_TERMS = 10_000;

test("a scan that throws inside one file fails closed and names that file and phase", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));
  const chain = Array.from({ length: OVERFLOWING_CHAIN_TERMS }, () => "open").join(" && ");
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "src", "deep.tsx"),
    `
      import { useState } from "react";
      export function Deep() {
        const [open, setOpen] = useState(false);
        return <button onClick={() => setOpen(true)}>{String(${chain})}</button>;
      }
    `,
    "utf8",
  );

  const { code, payload } = await failurePayload([root]);

  assert.equal(code, 1);
  assert.equal(payload.reason, "scan_failed");
  assert.equal(payload.file, path.join("src", "deep.tsx"));
  assert.equal(payload.phase, "analyze");
  assert.match(
    payload.message,
    /^analyze failed for src.deep\.tsx: Maximum call stack size exceeded$/u,
  );
});
