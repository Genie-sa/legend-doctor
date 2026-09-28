import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { HookFinding } from "../../../src/core/types.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const PRIVATE_MANIFEST = JSON.stringify({ name: "app", private: true });

const UPLOAD_HOOK = `
  import { useCallback, useState } from "react";
  export function useUploadStatus() {
    const [status, setStatus] = useState<"idle" | "pending" | "done">("idle");
    const upload = useCallback(() => {
      setStatus("pending");
      queueMicrotask(() => setStatus("done"));
    }, []);
    return { status, upload };
  }
`;

const BROAD_CONSUMER = `
  import { useUploadStatus } from "./hooks";
  import { UploadButton } from "./UploadButton";
  export function Broad() {
    const { status, upload } = useUploadStatus();
    return (
      <main>
        <header><h1>Files</h1><p>Upload center</p></header>
        <section><p>One</p><p>Two</p><p>Three</p><p>Four</p></section>
        <aside><p>Tips</p><p>Limits</p></aside>
        <footer><UploadButton status={status} upload={upload} /></footer>
      </main>
    );
  }
`;

const UPLOAD_BUTTON = `
  export function UploadButton({ status, upload }: {
    status: "idle" | "pending" | "done";
    upload: () => void;
  }) {
    return <button disabled={status === "pending"} onClick={upload}>{status}</button>;
  }
`;

const APP_FILES = {
  "hooks.ts": UPLOAD_HOOK,
  "Broad.tsx": BROAD_CONSUMER,
  "UploadButton.tsx": UPLOAD_BUTTON,
};

async function statusVerdict(
  files: Readonly<Record<string, string>>,
  scanDirectory = ".",
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-hook-closure-"));
  try {
    const withManifest = { "package.json": PRIVATE_MANIFEST, ...files };
    await Promise.all(
      Object.entries(withManifest).map(async ([name, source]) => {
        await mkdir(path.dirname(path.join(root, name)), { recursive: true });
        await writeFile(path.join(root, name), source, "utf8");
      }),
    );
    const report = await analyzePath(path.join(root, scanDirectory));
    const finding = report.findings.find(
      (candidate: HookFinding) => candidate.hook === "useState" && candidate.name === "status",
    );
    assert.ok(finding, "missing state status");
    return finding.action;
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function inSource(files: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([name, source]) => [`src/${name}`, source]));
}

const STATUS_READER = `export function statusLength(status: string): number { return status.length; }`;

test("publishes hook state when the scan root closes over every caller", async () => {
  assert.equal(await statusVerdict(APP_FILES), "use-observable");
  assert.equal(
    await statusVerdict({ ...inSource(APP_FILES), "src/package.json": PRIVATE_MANIFEST }, "src"),
    "use-observable",
  );
});

test("publishes hook state when a harness never names the published member", async () => {
  assert.equal(
    await statusVerdict({
      ...APP_FILES,
      "hooks.test.tsx": `
        import { renderHook } from "@testing-library/react";
        import { useUploadStatus } from "./hooks";
        renderHook(() => useUploadStatus());
      `,
    }),
    "use-observable",
  );
});

test("publishes hook state when no package source outside the scan root reaches the hook", async () => {
  assert.equal(
    await statusVerdict(
      {
        ...inSource(APP_FILES),
        "vite.config.ts": `export default { root: "src" };`,
        "tests/hooks.test.tsx": `
          import { renderHook } from "@testing-library/react";
          import { useUploadStatus } from "../src/hooks";
          renderHook(() => useUploadStatus());
        `,
      },
      "src",
    ),
    "use-observable",
  );
});

test("publishes hook state when a computed load can only reach data files", async () => {
  assert.equal(
    await statusVerdict({
      ...APP_FILES,
      "locales.ts": `export function loadLocale(name: string) { return import(\`./locales/\${name}.json\`); }`,
    }),
    "use-observable",
  );
});

test("publishes hook state when a folded specifier names another module", async () => {
  assert.equal(
    await statusVerdict({
      ...APP_FILES,
      "node-bindings.ts": `declare const require: (id: string) => unknown; export const fs = require(["fs"].join());`,
    }),
    "use-observable",
  );
});

test("publishes hook state when an opaque harness never names the published member", async () => {
  assert.equal(
    await statusVerdict({
      ...APP_FILES,
      "hooks.test.ts": `import * as hooks from "./hooks"; export const exported = Object.keys(hooks);`,
    }),
    "use-observable",
  );
});

for (const [label, files, scanDirectory] of [
  [
    "a dynamic import can reach the hook",
    {
      ...APP_FILES,
      "lazy.ts": `export async function peek() { return (await import("./hooks")).useUploadStatus; }`,
    },
    ".",
  ],
  [
    "a computed load can reach the hook's directory",
    {
      ...APP_FILES,
      "loader.ts": `export function loadModule(name: string) { return import(\`./\${name}\`); }`,
    },
    ".",
  ],
  [
    "a folded specifier names the hook's module",
    {
      ...APP_FILES,
      "lazy.ts": `declare const require: (id: string) => unknown; export const hooks = require(["./ho", "oks"].join(""));`,
    },
    ".",
  ],
  [
    "an unresolved import may name the hook",
    {
      ...APP_FILES,
      "Summary.tsx": `
        import { useUploadStatus } from "~/missing/hooks";
        ${STATUS_READER}
        export function Summary() { const { status } = useUploadStatus(); return <p>{statusLength(status)}</p>; }
      `,
    },
    ".",
  ],
  [
    "a module mock replaces the published member",
    {
      ...APP_FILES,
      "Broad.test.tsx": `
        jest.mock("./hooks", () => ({ useUploadStatus: () => ({ status: "done", upload: () => {} }) }));
      `,
    },
    ".",
  ],
  [
    "a module mock outside the scan root replaces the published member",
    {
      ...inSource(APP_FILES),
      "tests/ui/Broad.tsx": `
        jest.mock("../../src/hooks", () => ({ useUploadStatus: () => ({ status: "done", upload: () => {} }) }));
      `,
    },
    "src",
  ],
  [
    "an opaque harness names the published member",
    {
      ...APP_FILES,
      "hooks.test.ts": `import * as hooks from "./hooks"; export const read = () => hooks.useUploadStatus().status;`,
    },
    ".",
  ],
  [
    "a namespace import reads the member",
    {
      ...APP_FILES,
      "Summary.tsx": `
        import * as hooks from "./hooks";
        ${STATUS_READER}
        export function Summary() { return <p>{statusLength(hooks.useUploadStatus().status)}</p>; }
      `,
    },
    ".",
  ],
  [
    "an alias without a hook name reads the member",
    {
      ...APP_FILES,
      "upload-status.ts": `import { useUploadStatus } from "./hooks"; export default useUploadStatus;`,
      "Summary.tsx": `
        import uploadStatus from "./upload-status";
        ${STATUS_READER}
        export function Summary() { const { status } = uploadStatus(); return <p>{statusLength(status)}</p>; }
      `,
    },
    ".",
  ],
  [
    "the hook ships in a published package",
    {
      ...APP_FILES,
      "package.json": JSON.stringify({ name: "@scope/uploads", exports: "./hooks.ts" }),
    },
    ".",
  ],
  [
    "a caller outside the scan root reads the member",
    {
      ...inSource(APP_FILES),
      "scripts/Summary.tsx": `
        import { useUploadStatus } from "../src/hooks";
        ${STATUS_READER}
        export function Summary() { const { status } = useUploadStatus(); return <p>{statusLength(status)}</p>; }
      `,
    },
    "src",
  ],
  [
    "a test outside the scan root reads the member",
    {
      ...inSource(APP_FILES),
      "tests/hooks.test.tsx": `
        import { renderHook } from "@testing-library/react";
        import { useUploadStatus } from "../src/hooks";
        const { result } = renderHook(() => useUploadStatus());
        console.log(result.current.status);
      `,
    },
    "src",
  ],
  [
    "a test inside the scan root reads the member",
    {
      ...APP_FILES,
      "hooks.test.tsx": `
        import { renderHook } from "@testing-library/react";
        import { useUploadStatus } from "./hooks";
        const { result } = renderHook(() => useUploadStatus());
        console.log(result.current.status);
      `,
    },
    ".",
  ],
] as const) {
  test(`abstains when ${label}`, async () => {
    assert.notEqual(await statusVerdict(files, scanDirectory), "use-observable");
  });
}
