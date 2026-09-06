import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { HookFinding } from "../../../src/core/types.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const HOOKS_FILE = `
  import { useEffect, useState } from "react";
  export function useTimerFlag(delay: number) {
    const [ready, setReady] = useState(false);
    useEffect(() => {
      const timer = setTimeout(() => setReady(true), delay);
      return () => clearTimeout(timer);
    }, [delay]);
    return { ready, reset: () => setReady(false) };
  }
  export function useCounter() {
    const [count, setCount] = useState(0);
    return [count, setCount] as const;
  }
  export function useLabel() {
    const [label, setLabel] = useState("");
    return { label, setLabel };
  }
  export function useShared() {
    const [shared, setShared] = useState(0);
    return { shared, setShared };
  }
  export function useForwarded() {
    const [value, setValue] = useState("");
    return { value, setValue };
  }
  export function useChained() {
    const [inner, setInner] = useState(0);
    return { inner, setInner };
  }
`;

async function scan(files: Readonly<Record<string, string>>): Promise<HookFinding[]> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-hook-consumer-"));
  try {
    await Promise.all(
      Object.entries(files).map(([name, source]) =>
        writeFile(path.join(root, name), source, "utf8"),
      ),
    );
    const report = await analyzePath(root);
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

test("keeps hook state whose only consumer is a leaf component rendering it locally", async () => {
  const findings = await scan({
    "hooks.ts": HOOKS_FILE,
    "Leaf.tsx": `
      import { useCounter, useLabel, useTimerFlag } from "./hooks";
      export function Badge({ delay }: { delay: number }) {
        const { ready, reset } = useTimerFlag(delay);
        const [count, setCount] = useCounter();
        const { label } = useLabel();
        return (
          <button className={ready ? "ready" : ""} onClick={() => { setCount(count + 1); reset(); }}>
            {label} {count}
          </button>
        );
      }
    `,
  });
  assert.equal(verdict(findings, "ready"), "keep-state");
  assert.equal(verdict(findings, "count"), "keep-state");
  assert.equal(verdict(findings, "label"), "keep-state");
  const ready = findings.find((finding) => finding.name === "ready");
  assert.equal(ready?.confidence, "certain");
  assert.match(ready?.message ?? "", /only component that consumes `useTimerFlag`/u);
});

test("keeps same-named hooks separate while following aliased barrel consumers", async () => {
  const findings = await scan({
    "first.ts":
      'import { useState } from "react"; export function useLabel() { const [first, setFirst] = useState(""); return { first, setFirst }; }',
    "second.ts":
      'import { useState } from "react"; export function useLabel() { const [second, setSecond] = useState(""); return { second, setSecond }; }',
    "barrel.ts": 'export { useLabel as useFirst } from "./first";',
    "Leaf.tsx": `
      import { useFirst as useAliased } from "./barrel";
      import { useLabel } from "./second";
      export function Leaf() { const { first } = useAliased(); return <span>{first}</span>; }
      export function Unsafe() { return useLabel(); }
    `,
  });
  assert.equal(verdict(findings, "first"), "keep-state");
  assert.match(verdict(findings, "second"), /^review-state:/u);
});

test("refreshes consumer lookups on a new scan of the same paths", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-consumer-refresh-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(path.join(root, "hooks.ts"), HOOKS_FILE);
  const consumerPath = path.join(root, "Leaf.tsx");
  await writeFile(
    consumerPath,
    `
    import { useLabel } from "./hooks";
    export function Leaf() { const { label } = useLabel(); return <span>{label}</span>; }
  `,
  );
  const before = await analyzePath(root);
  assert.equal(verdict(before.findings, "label"), "keep-state");
  await writeFile(
    consumerPath,
    `
    import { useLabel } from "./hooks";
    export function Unsafe() { return useLabel(); }
  `,
  );
  const after = await analyzePath(root);
  assert.match(verdict(after.findings, "label"), /^review-state:/u);
});

test("leaves hook state under review when its consumers are not a single local leaf", async () => {
  const findings = await scan({
    "hooks.ts": HOOKS_FILE,
    "Broad.tsx": `
      import { useCounter, useForwarded, useLabel, useShared } from "./hooks";
      import { Field } from "./Field";
      export function Broad() {
        const [count, setCount] = useCounter();
        const { value, setValue } = useForwarded();
        const { label } = useLabel();
        return (
          <section>
            <header><h1>{label}</h1><p>{count}</p></header>
            <main><p>Body</p><p>More</p></main>
            <Field value={value} onChange={setValue} />
            <footer><button onClick={() => setCount(count + 1)}>Ok</button></footer>
          </section>
        );
      }
      export function First() {
        const { shared } = useShared();
        return <span>{shared}</span>;
      }
      export function Second() {
        const { shared } = useShared();
        return <span>{shared}</span>;
      }
      export function useOuter() {
        const { inner, setInner } = useChained();
        return { inner, setInner };
      }
      export function Reference() {
        const hook = useCounter;
        return <span>{String(hook)}</span>;
      }
    `,
    "Field.tsx": `
      export function Field({ value, onChange }: { value: string; onChange: (value: string) => void }) {
        return <input value={value} onChange={(event) => onChange(event.target.value)} />;
      }
    `,
  });
  for (const name of ["count", "value", "label", "shared", "inner"]) {
    assert.match(verdict(findings, name), /^review-state:/u, name);
  }
});

test("publishes render-only hook state as an observable for one broad consumer", async () => {
  const findings = await scan({
    "hooks.ts": `
      import { useCallback, useState } from "react";
      export function useUploadStatus() {
        const [status, setStatus] = useState<"idle" | "pending" | "done">("idle");
        const upload = useCallback(() => {
          setStatus("pending");
          queueMicrotask(() => setStatus("done"));
        }, []);
        return { status, upload };
      }
    `,
    "Broad.tsx": `
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
    `,
    "UploadButton.tsx": `
      export function UploadButton({ status, upload }: {
        status: "idle" | "pending" | "done";
        upload: () => void;
      }) {
        return <button disabled={status === "pending"} onClick={upload}>{status}</button>;
      }
    `,
  });
  assert.equal(verdict(findings, "status"), "use-observable");
  assert.match(
    findings.find((finding) => finding.name === "status")?.message ?? "",
    /publish the observable from `useUploadStatus`/u,
  );
});

test("publishes hook state only when every broad consumer has stable presentation sites", async () => {
  const findings = await scan({
    "hooks.ts": `
      import { useCallback, useState } from "react";
      export function useSharedStatus() {
        const [sharedStatus, setSharedStatus] = useState(false);
        const activate = useCallback(() => setSharedStatus(true), []);
        return { sharedStatus, activate };
      }
      export function useMixedStatus() {
        const [mixedStatus, setMixedStatus] = useState(false);
        const activate = useCallback(() => setMixedStatus(true), []);
        return { mixedStatus, activate };
      }
    `,
    "First.tsx": `
      import { useSharedStatus, useMixedStatus } from "./hooks";
      export function First() {
        const { sharedStatus } = useSharedStatus();
        const { mixedStatus } = useMixedStatus();
        return <main><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/>
          <button disabled={sharedStatus || mixedStatus}>Go</button>
        </main>;
      }
    `,
    "Second.tsx": `
      import { useSharedStatus } from "./hooks";
      export function Second() {
        const { sharedStatus } = useSharedStatus();
        return <main><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/>
          <button aria-pressed={sharedStatus}>Go</button>
        </main>;
      }
    `,
    "Unsafe.tsx": `
      import { useEffect } from "react";
      import { useMixedStatus } from "./hooks";
      declare function report(value: boolean): void;
      export function Unsafe() {
        const { mixedStatus } = useMixedStatus();
        useEffect(() => report(mixedStatus), [mixedStatus]);
        return <main><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/></main>;
      }
    `,
  });
  assert.equal(verdict(findings, "sharedStatus"), "use-observable");
  assert.match(verdict(findings, "mixedStatus"), /^review-state:/u);
});

test("keeps a hook-owned derivation under review instead of changing its snapshot timing", async () => {
  const findings = await scan({
    "hooks.ts": `
      import { useState } from "react";
      export function useUploadStatus() {
        const [status, setStatus] = useState<"idle" | "done">("idle");
        const complete = status === "done";
        return { complete, status, finish: () => setStatus("done") };
      }
    `,
    "Broad.tsx": `
      import { useUploadStatus } from "./hooks";
      export function Broad() {
        const { status, finish } = useUploadStatus();
        return (
          <main>
            <header><h1>Files</h1><p>Upload center</p></header>
            <section><p>One</p><p>Two</p><p>Three</p><p>Four</p></section>
            <aside><p>Tips</p><p>Limits</p></aside>
            <footer><button onClick={finish}>{status}</button></footer>
          </main>
        );
      }
    `,
  });
  assert.match(verdict(findings, "status"), /^review-state:/u);
});

test("publishes a closed co-written hook model without splitting its transition", async () => {
  const findings = await scan({
    "hooks.ts": `
      import { useCallback, useState } from "react";
      export function useImage() {
        const [source, setSource] = useState("preview");
        const [loaded, setLoaded] = useState(false);
        const finish = useCallback(() => {
          setSource("full");
          setLoaded(true);
        }, []);
        return { finish, loaded, source };
      }
    `,
    "Broad.tsx": `
      import { memo } from "react";
      import { useImage } from "./hooks";
      export default memo(function Broad() {
        const { finish, loaded, source } = useImage();
        return (
          <main>
            <header><h1>Gallery</h1><p>Current image</p></header>
            <section><p>One</p><p>Two</p><p>Three</p><p>Four</p></section>
            <aside><p>Tips</p><p>Metadata</p></aside>
            <footer>
              <button onClick={finish}>Load</button>
              <img alt="" src={source} style={{ opacity: loaded ? 1 : 0.5 }} />
            </footer>
          </main>
        );
      });
    `,
  });
  assert.equal(verdict(findings, "source"), "use-observable");
  assert.equal(verdict(findings, "loaded"), "use-observable");
  const source = findings.find((finding) => finding.name === "source");
  assert.deepEqual(source?.group?.members, ["source", "loaded"]);
});
