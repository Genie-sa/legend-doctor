import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { LegendPracticeFinding } from "../../../src/core/types.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

const STORE = `
  import { observable } from "@legendapp/state";
  export const status$ = observable({
    enabled: false,
    authenticated: false,
    isLoading: false,
    connect: () => status$.enabled.set(true),
  });
`;

const COMPONENT = `
  import { useValue } from "@legendapp/state/react";
  import { status$ } from "./state/status";
  export function SourceBadge() {
    const status = useValue(status$);
    return <span>{String(status.enabled && status.authenticated)}</span>;
  }
`;

async function splitFindings(writerPath: string, writer: string): Promise<LegendPracticeFinding[]> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-split-leaf-writes-"));
  try {
    await mkdir(path.join(root, path.dirname(writerPath)), { recursive: true });
    await mkdir(path.join(root, "state"), { recursive: true });
    await writeFile(path.join(root, "state", "status.ts"), STORE, "utf8");
    await writeFile(path.join(root, writerPath), writer, "utf8");
    await writeFile(path.join(root, "source-badge.tsx"), COMPONENT, "utf8");
    const report = await analyzePath(root);
    return report.practices.filter((finding) => finding.action === "split-use-value-leaves");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("splits when another module writes an unread sibling on its own", async () => {
  const [finding, ...rest] = await splitFindings(
    "state/connect.ts",
    `
      import { status$ } from "./status";
      export async function connect() {
        status$.isLoading.set(true);
      }
    `,
  );
  assert.deepEqual(rest, []);
  assert.match(
    requireValue(finding).evidence.join(" "),
    /unread `isLoading` is written without any field this owner reads/u,
  );
});

test("ignores sibling writes that only a test makes", async () => {
  assert.deepEqual(
    await splitFindings(
      "state/__tests__/status.test.ts",
      `
        import { status$ } from "../status";
        status$.isLoading.set(true);
      `,
    ),
    [],
  );
});

async function splitCount(files: Readonly<Record<string, string>>): Promise<number> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-split-helper-writes-"));
  try {
    await mkdir(path.join(root, "state"), { recursive: true });
    await writeFile(path.join(root, "state", "status.ts"), STORE, "utf8");
    await writeFile(path.join(root, "source-badge.tsx"), COMPONENT, "utf8");
    for (const [file, text] of Object.entries(files)) {
      await writeFile(path.join(root, file), text, "utf8");
    }
    const report = await analyzePath(root);
    return report.practices.filter((finding) => finding.action === "split-use-value-leaves").length;
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("follows an imported helper into the stretch that calls it", async () => {
  const loading = `
    import { status$ } from "./status";
    export function markLoading() {
      status$.isLoading.set(true);
    }
  `;
  assert.equal(
    await splitCount({
      "state/connect.ts": `
        import { markLoading } from "./index";
        import { status$ } from "./status";
        export function connect() {
          status$.authenticated.set(false);
          markLoading();
        }
      `,
      "state/index.ts": `export { markLoading } from "./loading";`,
      "state/loading.ts": loading,
    }),
    0,
  );
  assert.equal(
    await splitCount({
      "state/connect.ts": `
        import { markLoading } from "./loading";
        export function connect() {
          markLoading();
        }
      `,
      "state/loading.ts": loading,
    }),
    1,
  );
});

test("abstains when the writing stretch calls a relative module outside the project", async () => {
  assert.equal(
    await splitCount({
      "state/connect.ts": `
        import { status$ } from "./status";
        import { track } from "./generated/analytics";
        export function connect() {
          status$.isLoading.set(true);
          track();
        }
      `,
    }),
    0,
  );
});
