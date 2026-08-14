import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzePath, createAnalysisContext } from "../src/analyze-path.js";

test("scans source files deterministically and ignores generated directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-test-"));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "node_modules"));
  await writeFile(
    path.join(root, "src", "component.tsx"),
    'import { useState } from "react"; export function C() { const [x] = useState(1); return <>{x}</>; }'
  );
  await writeFile(
    path.join(root, "node_modules", "ignored.tsx"),
    'import { useState } from "react"; export function C() { const [x] = useState(1); return <>{x}</>; }'
  );

  const report = await analyzePath(root);

  assert.equal(report.files, 1);
  assert.equal(report.hooks.states, 1);
  assert.equal(report.findings[0]?.location.file, path.join("src", "component.tsx"));
});

test("shares application import provenance with a focused file analysis", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-context-"));
  const components = path.join(root, "components");
  const screens = path.join(root, "screens");
  await mkdir(components);
  await mkdir(screens);
  await writeFile(
    path.join(components, "Leaf.tsx"),
    'export function Leaf({ value }: { value: string }) { return <output>{value}</output>; }'
  );
  const screen = path.join(screens, "Screen.tsx");
  await writeFile(
    screen,
    `
      import { useState } from "react";
      import { Leaf } from "../components/Leaf";
      export function Screen() {
        const [value, setValue] = useState("idle");
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
          <button onClick={() => setValue("done")}>Done</button><Leaf value={value} /></main>;
      }
    `
  );

  const focused = await analyzePath(screen);
  assert.equal(focused.findings[0]?.action, "review-state");

  const context = await createAnalysisContext(root);
  const contextual = await analyzePath(screen, context);
  assert.equal(contextual.files, 1);
  assert.equal(contextual.findings[0]?.location.file, "Screen.tsx");
  assert.equal(contextual.findings[0]?.action, "use-observable");
});

test("uses cross-file observable provenance for batching findings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-observable-import-"));
  try {
    await mkdir(path.join(root, "state"), { recursive: true });
    await writeFile(
      path.join(root, "state", "player.ts"),
      `
        import { observable } from "@legendapp/state";
        export const player$ = observable({ loading: false, error: null as string | null });
      `,
      "utf8"
    );
    await writeFile(
      path.join(root, "screen.ts"),
      `
        import { player$ } from "./state/player";
        export function fail(message: string) {
          player$.error.set(message);
          player$.loading.set(false);
        }
      `,
      "utf8"
    );

    const report = await analyzePath(root);
    assert.equal(report.practices.length, 1);
    assert.equal(report.practices[0]?.action, "assign-observable-fields");
    assert.equal(report.practices[0]?.location.file, "screen.ts");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("uses cross-file observable provenance for direct useValue findings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-observable-read-"));
  try {
    await mkdir(path.join(root, "state"), { recursive: true });
    await writeFile(
      path.join(root, "state", "theme.ts"),
      `
        import { observable } from "@legendapp/state";
        export const theme$ = observable({ accent: "blue" });
      `,
      "utf8"
    );
    await writeFile(
      path.join(root, "screen.tsx"),
      `
        import { useValue as observe } from "@legendapp/state/react";
        import { theme$ } from "./state/theme";
        export function Screen() {
          return <span>{observe(() => theme$.accent.get())}</span>;
        }
      `,
      "utf8"
    );

    const report = await analyzePath(root);
    assert.equal(report.practices.length, 1);
    assert.equal(report.practices[0]?.action, "pass-observable-to-use-value");
    assert.equal(report.practices[0]?.location.file, "screen.tsx");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("places an observable subscription at one resolved child call site", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-contract-"));
  await writeFile(
    path.join(root, "StatusLeaf.tsx"),
    'export function StatusLeaf({ busy }: { busy: boolean }) { return <span>{busy ? "Busy" : "Ready"}</span>; }'
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { StatusLeaf } from "./StatusLeaf";
      export function Screen() {
        const [busy, setBusy] = useState(false);
        const run = async () => { setBusy(true); await work(); setBusy(false); };
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><StatusLeaf busy={busy} onRun={run} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "busy");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /stable `StatusLeaf` call site/);
});

test("does not require child prop semantics for a call-site subscription wrapper", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-call-site-"));
  await writeFile(
    path.join(root, "Leaf.tsx"),
    `
      import { useEffect } from "react";
      export function Leaf({ open }: { open: boolean }) {
        useEffect(() => report(open), [open]);
        return <aside />;
      }
    `
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { Leaf } from "./Leaf";
      export function Screen() {
        const [open, setOpen] = useState(false);
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={() => setOpen(true)} /><Leaf open={open} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "open");
  assert.equal(finding?.action, "use-observable");
});

test("wraps a shared primitive locally without changing its API", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-shared-primitive-"));
  await mkdir(path.join(root, "components", "ui"), { recursive: true });
  await writeFile(
    path.join(root, "components", "ui", "Dialog.tsx"),
    'export function Dialog({ open }: { open: boolean }) { return open ? <aside /> : null; }'
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { Dialog } from "./components/ui/Dialog";
      export function Screen() {
        const [open, setOpen] = useState(false);
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={() => setOpen(true)} /><Dialog open={open} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "open");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /call-site leaf wrapper/);
});

test("moves non-boolean controlled state into a stable local wrapper", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-controlled-call-site-"));
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { Tabs } from "some-ui-library";
      export function Screen() {
        const [tab, setTab] = useState("summary");
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><Tabs value={tab} onValueChange={setTab} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "tab");
  assert.equal(finding?.action, "move-state-down");
  assert.match(finding?.message ?? "", /stable local wrapper/);
});

test("does not create a second observable for state initialized from a hook result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-hook-initializer-"));
  await writeFile(
    path.join(root, "Input.tsx"),
    'export function Input({ value, onChange }: { value: string; onChange: (value: string) => void }) { return <input value={value} onChange={event => onChange(event.target.value)} />; }'
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { Input } from "./Input";
      export function Screen() {
        const saved = useWriterName();
        const [name, setName] = useState(saved);
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><Input value={name} onChange={setName} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "name");
  assert.notEqual(finding?.action, "use-observable");
});

test("allows repeated row commands when the value has one stable leaf consumer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-repeated-command-"));
  await writeFile(
    path.join(root, "Leaves.tsx"),
    `
      export function Row({ onSelect }: { onSelect: (id: string) => void }) { return <button onClick={() => onSelect("x")} />; }
      export function Dialog({ selected }: { selected: string | null }) { return selected ? <aside /> : null; }
    `
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { Dialog, Row } from "./Leaves";
      export function Screen({ rows }: { rows: string[] }) {
        const [selected, setSelected] = useState<string | null>(null);
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview />{rows.map(row => <Row key={row} onSelect={setSelected} />)}
          <Dialog selected={selected} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "selected");
  assert.equal(finding?.action, "use-observable");
});

test("keeps observable ownership stable when its one leaf subscription mounts conditionally", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-contract-conditional-"));
  await writeFile(
    path.join(root, "StatusLeaf.tsx"),
    'export function StatusLeaf({ busy }: { busy: boolean }) { return <span>{busy ? "Busy" : "Ready"}</span>; }'
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { StatusLeaf } from "./StatusLeaf";
      export function Screen({ visible }: { visible: boolean }) {
        const [busy, setBusy] = useState(false);
        const run = async () => { setBusy(true); await work(); setBusy(false); };
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview />{visible ? <StatusLeaf busy={busy} onRun={run} /> : null}</main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "busy");
  assert.equal(finding?.action, "use-observable");
});

test("does not promote one imported-child state when its writes still invalidate the owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-contract-cluster-"));
  await writeFile(
    path.join(root, "DialogLeaf.tsx"),
    'export function DialogLeaf({ open }: { open: boolean }) { return open ? <aside /> : null; }'
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { DialogLeaf } from "./DialogLeaf";
      export function Screen() {
        const [open, setOpen] = useState(false);
        const [selection, setSelection] = useState<string | null>(null);
        const show = (id: string) => { setSelection(id); setOpen(true); };
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={() => show("a")} />
          <span>{selection}</span><DialogLeaf open={open} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "open");
  assert.notEqual(finding?.action, "use-observable");
});

test("does not promote imported-child state written by an effect", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-contract-effect-"));
  await writeFile(
    path.join(root, "StatusLeaf.tsx"),
    'export function StatusLeaf({ busy }: { busy: boolean }) { return <span>{busy ? "Busy" : "Ready"}</span>; }'
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useEffect, useState } from "react";
      import { StatusLeaf } from "./StatusLeaf";
      export function Screen({ running }: { running: boolean }) {
        const [busy, setBusy] = useState(false);
        useEffect(() => setBusy(running), [running]);
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><StatusLeaf busy={busy} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "busy");
  assert.notEqual(finding?.action, "use-observable");
});

test("does not promote a leaf call site when commands share reactive mutation ownership", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-leaf-mutation-"));
  await writeFile(
    path.join(root, "StatusLeaf.tsx"),
    'export function StatusLeaf({ busy }: { busy: boolean }) { return <span>{busy ? "Busy" : "Ready"}</span>; }'
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { StatusLeaf } from "./StatusLeaf";
      export function Screen() {
        const { mutateAsync: save } = useSave();
        const [busy, setBusy] = useState(false);
        const run = async () => { setBusy(true); try { await save(); } finally { setBusy(false); } };
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={run} /><StatusLeaf busy={busy} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "busy");
  assert.notEqual(finding?.action, "use-observable");
});

test("does not promote a leaf call site inside an opaque render callback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-render-callback-"));
  await writeFile(path.join(root, "StatusLeaf.tsx"), 'export function StatusLeaf({ busy }: { busy: boolean }) { return <span>{String(busy)}</span>; }');
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { StatusLeaf } from "./StatusLeaf";
      export function Screen() {
        const [busy, setBusy] = useState(false);
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={() => setBusy(true)} />
          <VirtualList renderItem={() => <StatusLeaf busy={busy} />} /></main>;
      }
    `
  );
  const finding = (await analyzePath(root)).findings.find(candidate => candidate.name === "busy");
  assert.notEqual(finding?.action, "use-observable");
});

test("does not miss reactive mutation ownership through a hook result object", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-object-mutation-"));
  await writeFile(path.join(root, "StatusLeaf.tsx"), 'export function StatusLeaf({ busy }: { busy: boolean }) { return <span>{String(busy)}</span>; }');
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { StatusLeaf } from "./StatusLeaf";
      export function Screen() {
        const save = useSave();
        const [busy, setBusy] = useState(false);
        const run = async () => { setBusy(true); try { await save.mutateAsync(); } finally { setBusy(false); } };
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={run} /><StatusLeaf busy={busy} /></main>;
      }
    `
  );
  const finding = (await analyzePath(root)).findings.find(candidate => candidate.name === "busy");
  assert.notEqual(finding?.action, "use-observable");
});

test("does not put nullable callable state into a leaf observable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-callable-leaf-"));
  await writeFile(path.join(root, "Slot.tsx"), 'export function Slot({ value }: { value: (() => void) | null }) { return <button onClick={value ?? undefined} />; }');
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { Slot } from "./Slot";
      export function Screen() {
        const [callback, setCallback] = useState<(() => void) | null>(null);
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={() => setCallback(() => work)} /><Slot value={callback} /></main>;
      }
    `
  );
  const finding = (await analyzePath(root)).findings.find(candidate => candidate.name === "callback");
  assert.notEqual(finding?.action, "use-observable");
});
