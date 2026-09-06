import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

test("does not create a second observable for state initialized from a hook result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-hook-initializer-"));
  await writeFile(
    path.join(root, "Input.tsx"),
    "export function Input({ value, onChange }: { value: string; onChange: (value: string) => void }) { return <input value={value} onChange={event => onChange(event.target.value)} />; }",
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
    `,
  );

  const report = await analyzePath(root);
  const finding = report.findings.find((candidate) => candidate.name === "name");
  assert.notEqual(requireValue(finding).action, "use-observable");
});

test("keeps observable ownership stable when its one leaf subscription mounts conditionally", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-contract-conditional-"));
  await writeFile(
    path.join(root, "StatusLeaf.tsx"),
    'export function StatusLeaf({ busy, onRun }: { busy: boolean; onRun: () => void }) { return <button onClick={onRun}>{busy ? "Busy" : "Ready"}</button>; }',
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
    `,
  );

  const report = await analyzePath(root);
  const finding = report.findings.find((candidate) => candidate.name === "busy");
  assert.equal(requireValue(finding).action, "use-observable");
});

test("migrates an imported-child state with the companion whose writes invalidate the owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-contract-cluster-"));
  await writeFile(
    path.join(root, "DialogLeaf.tsx"),
    "export function DialogLeaf({ open }: { open: boolean }) { return open ? <aside /> : null; }",
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
    `,
  );

  const report = await analyzePath(root);
  const open = report.findings.find((candidate) => candidate.name === "open");
  const selection = report.findings.find((candidate) => candidate.name === "selection");
  assert.equal(requireValue(open).action, "use-observable");
  assert.equal(requireValue(open).group?.id, requireValue(selection).group?.id);
});

test("does not promote imported-child state written by an effect", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-contract-effect-"));
  await writeFile(
    path.join(root, "StatusLeaf.tsx"),
    'export function StatusLeaf({ busy }: { busy: boolean }) { return <span>{busy ? "Busy" : "Ready"}</span>; }',
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
    `,
  );

  const report = await analyzePath(root);
  const finding = report.findings.find((candidate) => candidate.name === "busy");
  assert.doesNotMatch(requireValue(finding).message ?? "", /child contract is verified/u);
});

test("does not promote a leaf call site when commands share reactive mutation ownership", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-leaf-mutation-"));
  await writeFile(
    path.join(root, "StatusLeaf.tsx"),
    'export function StatusLeaf({ busy }: { busy: boolean }) { return <span>{busy ? "Busy" : "Ready"}</span>; }',
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
    `,
  );

  const report = await analyzePath(root);
  const finding = report.findings.find((candidate) => candidate.name === "busy");
  assert.doesNotMatch(requireValue(finding).message ?? "", /child contract is verified/u);
});

test("does not promote a leaf call site inside an opaque render callback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-render-callback-"));
  await writeFile(
    path.join(root, "StatusLeaf.tsx"),
    "export function StatusLeaf({ busy }: { busy: boolean }) { return <span>{String(busy)}</span>; }",
  );
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
    `,
  );
  const report = await analyzePath(root);
  const finding = report.findings.find((candidate) => candidate.name === "busy");
  assert.notEqual(requireValue(finding).action, "use-observable");
});

test("resolves event producers before isolating projections inside JSX child callbacks", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-child-callback-projection-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "Surfaces.tsx"),
    `
      export function DeferredSurface({ onHover, children }) {
        return <div onMouseEnter={onHover}>{children}</div>;
      }
      export function EagerSurface({ onHover, children }) {
        onHover();
        return <div>{children}</div>;
      }
    `,
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { DeferredSurface, EagerSurface } from "./Surfaces";
      export function Screen() {
        const [safe, setSafe] = useState(false);
        const [unsafe, setUnsafe] = useState(false);
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <Picker>{() => <DeferredSurface onHover={() => setSafe(true)}><Icon fill={safe ? "green" : "gray"} /></DeferredSurface>}</Picker>
          <Picker>{() => <EagerSurface onHover={() => setUnsafe(true)}><Icon fill={unsafe ? "green" : "gray"} /></EagerSurface>}</Picker>
        </main>;
      }
    `,
  );

  const report = await analyzePath(root);
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "safe")).action,
    "use-observable",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "unsafe")).action,
    "review-state",
  );
});

test("does not miss reactive mutation ownership through a hook result object", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-object-mutation-"));
  await writeFile(
    path.join(root, "StatusLeaf.tsx"),
    "export function StatusLeaf({ busy }: { busy: boolean }) { return <span>{String(busy)}</span>; }",
  );
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
    `,
  );
  const report = await analyzePath(root);
  const finding = report.findings.find((candidate) => candidate.name === "busy");
  assert.notEqual(requireValue(finding).action, "use-observable");
});

test("does not put nullable callable state into a leaf observable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-callable-leaf-"));
  await writeFile(
    path.join(root, "Slot.tsx"),
    "export function Slot({ value }: { value: (() => void) | null }) { return <button onClick={value ?? undefined} />; }",
  );
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
    `,
  );
  const report = await analyzePath(root);
  const finding = report.findings.find((candidate) => candidate.name === "callback");
  assert.notEqual(requireValue(finding).action, "use-observable");
});
