import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { HookFinding } from "../../../src/core/types.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const PRIVATE_MANIFEST = JSON.stringify({ name: "app", private: true });

const REQUEST_HOOK = `
  import { useEffect, useState } from "react";
  declare function load(id: string): Promise<string>;
  export function useRecord(id: string) {
    const [record, setRecord] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    useEffect(() => {
      setIsLoading(true);
      void load(id).then((next) => {
        setRecord(next);
        setIsLoading(false);
      });
    }, [id]);
    return { record, isLoading };
  }
`;

const RECORD_VIEW = `
  import { useRecord } from "./hooks";
  export function RecordView({ id }: { id: string }) {
    const { record } = useRecord(id);
    return <p>{record}</p>;
  }
`;

async function scan(
  files: Readonly<Record<string, string>>,
  scanDirectory = ".",
): Promise<HookFinding[]> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-hook-unread-"));
  try {
    const withManifest = { "package.json": PRIVATE_MANIFEST, ...files };
    await Promise.all(
      Object.entries(withManifest).map(async ([name, source]) => {
        await mkdir(path.dirname(path.join(root, name)), { recursive: true });
        await writeFile(path.join(root, name), source, "utf8");
      }),
    );
    const report = await analyzePath(path.join(root, scanDirectory));
    return report.findings.filter((finding) => finding.hook === "useState");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function verdict(findings: readonly HookFinding[], name: string): string {
  const finding = findings.find((candidate) => candidate.name === name);
  assert.ok(finding, `missing state ${name}`);
  return `${finding.action}${finding.abstentionReason ? `:${finding.abstentionReason}` : ""}`;
}

test("deletes hook state that every consumer leaves unbound", async () => {
  const findings = await scan({ "hooks.ts": REQUEST_HOOK, "RecordView.tsx": RECORD_VIEW });
  assert.equal(verdict(findings, "isLoading"), "delete-unused-state");
  const finding = findings.find((candidate) => candidate.name === "isLoading");
  assert.equal(finding?.confidence, "certain");
  assert.match(finding?.message ?? "", /remove `isLoading` from the object `useRecord` returns/u);
  assert.match(finding?.message ?? "", /1 call site/u);
  assert.notEqual(verdict(findings, "record"), "delete-unused-state");
});

test("keeps the proof when a consumer reads the member", async () => {
  const findings = await scan({
    "hooks.ts": REQUEST_HOOK,
    "RecordView.tsx": RECORD_VIEW,
    "Spinner.tsx": `
      import { useRecord } from "./hooks";
      export function Spinner({ id }: { id: string }) {
        const { isLoading } = useRecord(id);
        return isLoading ? <span>Loading</span> : null;
      }
    `,
  });
  assert.doesNotMatch(verdict(findings, "isLoading"), /^delete-unused-state/u);
});

for (const [label, consumer] of [
  [
    "binds the whole result",
    `export function Whole({ id }: { id: string }) { const result = useRecord(id); return <p>{result.record}</p>; }`,
  ],
  ["re-returns the call", `export function useForward(id: string) { return useRecord(id); }`],
  [
    "collects the rest of the result",
    `export function Rest({ id }: { id: string }) { const { record, ...rest } = useRecord(id); return <p data-rest={rest}>{record}</p>; }`,
  ],
  [
    "passes the hook as a value",
    `export function Pass() { const hook = useRecord; return <p>{String(hook)}</p>; }`,
  ],
  [
    "renders with a mutable ref read",
    `import { useRef } from "react";
     export function RefReader({ id }: { id: string }) {
       const { record } = useRecord(id);
       const latest = useRef(0);
       return <p data-count={latest.current}>{record}</p>;
     }`,
  ],
] as const) {
  test(`abstains when a consumer ${label}`, async () => {
    const findings = await scan({
      "hooks.ts": REQUEST_HOOK,
      "RecordView.tsx": RECORD_VIEW,
      "Other.tsx": `import { useRecord } from "./hooks";\n${consumer}`,
    });
    assert.doesNotMatch(verdict(findings, "isLoading"), /^delete-unused-state/u);
  });
}

for (const [label, importer] of [
  [
    "a namespace import",
    `import * as hooks from "./hooks"; export function N({ id }: { id: string }) { return <p>{String(hooks.useRecord(id).isLoading)}</p>; }`,
  ],
  [
    "a namespace import through a barrel",
    `import * as all from "./barrel"; export function N({ id }: { id: string }) { return <p>{String(all.useRecord(id).isLoading)}</p>; }`,
  ],
  [
    "a dynamic import",
    `export async function lazy() { return (await import("./hooks")).useRecord; }`,
  ],
  [
    "a default alias without a hook name",
    `import fetchRecord from "./default-hook"; export function D({ id }: { id: string }) { const { isLoading } = fetchRecord(id); return <p>{String(isLoading)}</p>; }`,
  ],
  [
    "an unresolved import of the same name",
    `import { useRecord } from "~/missing/hooks"; export function U({ id }: { id: string }) { const { isLoading } = useRecord(id); return <p>{String(isLoading)}</p>; }`,
  ],
] as const) {
  test(`abstains when the hook is reachable through ${label}`, async () => {
    const findings = await scan({
      "hooks.ts": REQUEST_HOOK,
      "default-hook.ts": `import { useRecord } from "./hooks"; export default useRecord;`,
      "barrel.ts": `export * from "./hooks";`,
      "RecordView.tsx": RECORD_VIEW,
      "Importer.tsx": importer,
    });
    assert.doesNotMatch(verdict(findings, "isLoading"), /^delete-unused-state/u);
  });
}

for (const [label, load] of [
  ["a template load of the hook's directory", `import(\`./\${name}\`)`],
  ["a template load without a static directory", `import(\`\${name}.ts\`)`],
  ["a variable specifier", "import(name)"],
  ["a computed require", 'require("./" + name)'],
] as const) {
  test(`abstains when production code loads ${label}`, async () => {
    const findings = await scan({
      "hooks.ts": REQUEST_HOOK,
      "RecordView.tsx": RECORD_VIEW,
      "loader.ts": `declare const require: (id: string) => unknown; export function loadModule(name: string) { return ${load}; }`,
    });
    assert.doesNotMatch(verdict(findings, "isLoading"), /^delete-unused-state/u);
  });
}

for (const [label, load] of [
  ["a data file", `import(\`./locales/\${name}.json\`)`],
  ["a sibling directory", `import(\`./locales/\${name}\`)`],
] as const) {
  test(`keeps the proof when a computed load can only reach ${label}`, async () => {
    const findings = await scan({
      "hooks.ts": REQUEST_HOOK,
      "RecordView.tsx": RECORD_VIEW,
      "loader.ts": `export function loadLocale(name: string) { return ${load}; }`,
    });
    assert.equal(verdict(findings, "isLoading"), "delete-unused-state");
  });
}

test("accepts an opaque harness only when it never names the member", async () => {
  const silent = await scan({
    "hooks.ts": REQUEST_HOOK,
    "RecordView.tsx": RECORD_VIEW,
    "hooks.test.ts": `import * as hooks from "./hooks"; void import(\`./\${String(hooks)}\`);`,
  });
  assert.equal(verdict(silent, "isLoading"), "delete-unused-state");
  const naming = await scan({
    "hooks.ts": REQUEST_HOOK,
    "RecordView.tsx": RECORD_VIEW,
    "hooks.test.ts": `import * as hooks from "./hooks"; export const read = (id: string) => hooks.useRecord(id).isLoading;`,
  });
  assert.doesNotMatch(verdict(naming, "isLoading"), /^delete-unused-state/u);
});

test("ignores harness files that never name the member and abstains when one does", async () => {
  const silent = await scan({
    "hooks.ts": REQUEST_HOOK,
    "RecordView.tsx": RECORD_VIEW,
    "hooks.test.tsx": `
      import { renderHook } from "@testing-library/react";
      import { useRecord } from "./hooks";
      renderHook(() => useRecord("a"));
    `,
  });
  assert.equal(verdict(silent, "isLoading"), "delete-unused-state");
  const asserting = await scan({
    "hooks.ts": REQUEST_HOOK,
    "RecordView.tsx": RECORD_VIEW,
    "hooks.test.tsx": `
      import { renderHook } from "@testing-library/react";
      import { useRecord } from "./hooks";
      const { result } = renderHook(() => useRecord("a"));
      console.log(result.current.isLoading);
    `,
  });
  assert.doesNotMatch(verdict(asserting, "isLoading"), /^delete-unused-state/u);
});

test("abstains when the scan root holds only part of the hook's package", async () => {
  const findings = await scan(
    {
      "src/hooks.ts": REQUEST_HOOK,
      "src/RecordView.tsx": RECORD_VIEW,
      "tests/hooks.test.ts": `import { useRecord } from "../src/hooks"; export const read = () => useRecord("a").isLoading;`,
    },
    "src",
  );
  assert.doesNotMatch(verdict(findings, "isLoading"), /^delete-unused-state/u);
});

test("abstains for a hook shipped by a published package", async () => {
  const findings = await scan({
    "package.json": JSON.stringify({ name: "@scope/kit", exports: "./hooks.ts" }),
    "hooks.ts": REQUEST_HOOK,
    "RecordView.tsx": RECORD_VIEW,
  });
  assert.doesNotMatch(verdict(findings, "isLoading"), /^delete-unused-state/u);
});

test("abstains without a production consumer", async () => {
  const findings = await scan({ "hooks.ts": REQUEST_HOOK });
  assert.doesNotMatch(verdict(findings, "isLoading"), /^delete-unused-state/u);
});

test("abstains when the hook returns the setter or reads the value itself", async () => {
  const findings = await scan({
    "hooks.ts": `
      import { useEffect, useState } from "react";
      export function useFlags() {
        const [exposed, setExposed] = useState(false);
        const [read, setRead] = useState(false);
        useEffect(() => { setRead(true); }, []);
        return { exposed, setExposed, read, label: read ? "on" : "off" };
      }
    `,
    "View.tsx": `
      import { useFlags } from "./hooks";
      export function View() {
        const { setExposed, label } = useFlags();
        return <button onClick={() => setExposed(true)}>{label}</button>;
      }
    `,
  });
  assert.doesNotMatch(verdict(findings, "exposed"), /^delete-unused-state/u);
  assert.doesNotMatch(verdict(findings, "read"), /^delete-unused-state/u);
});

test("abstains for positional members, whose removal would shift later elements", async () => {
  const hooks = `
    import { useEffect, useState } from "react";
    export function usePair() {
      const [left, setLeft] = useState(0);
      const [right, setRight] = useState(0);
      useEffect(() => { setLeft(1); setRight(2); }, []);
      return [left, right] as const;
    }
  `;
  const findings = await scan({
    "hooks.ts": hooks,
    "View.tsx": `
      import { usePair } from "./hooks";
      export function View() { const [, right] = usePair(); return <p>{right}</p>; }
    `,
  });
  assert.doesNotMatch(verdict(findings, "left"), /^delete-unused-state/u);
  assert.doesNotMatch(verdict(findings, "right"), /^delete-unused-state/u);
});

test("keeps property evaluation when a discarded write reads a member", async () => {
  const findings = await scan({
    "hooks.ts": `
      import { useEffect, useState } from "react";
      declare const metrics: { width: number };
      export function useMeasure() {
        const [size, setSize] = useState(0);
        const [label, setLabel] = useState("");
        useEffect(() => { setSize(metrics.width); setLabel("ready"); }, []);
        return { size, label };
      }
    `,
    "View.tsx": `
      import { useMeasure } from "./hooks";
      export function View() { const { label } = useMeasure(); return <p>{label}</p>; }
    `,
  });
  const size = findings.find((finding) => finding.name === "size");
  assert.equal(size?.action, "delete-unused-state");
  assert.equal(size?.confidence, "probable");
  assert.match(size?.message ?? "", /`void` expression/u);
});
