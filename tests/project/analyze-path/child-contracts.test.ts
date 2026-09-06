import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import { createAnalysisContext } from "../../../src/project/analyze-path/analysis-context.js";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

test("does not require application component provenance for a focused call-site wrapper", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-context-"));
  const components = path.join(root, "components");
  const screens = path.join(root, "screens");
  await mkdir(components);
  await mkdir(screens);
  await writeFile(
    path.join(components, "Leaf.tsx"),
    "export function Leaf({ value }: { value: string }) { return <output>{value}</output>; }",
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
    `,
  );

  const focused = await analyzePath(screen);
  assert.equal(requireValue(focused.findings[0]).action, "use-observable");

  const context = await createAnalysisContext(root);
  const contextual = await analyzePath(screen, { sharedContext: context });
  assert.equal(contextual.files, 1);
  assert.equal(requireValue(contextual.findings[0]).location.file, "Screen.tsx");
  assert.equal(requireValue(contextual.findings[0]).action, "use-observable");
});

test("verifies a leaf child contract before promoting the transport", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-child-leaf-"));
  await writeFile(
    path.join(root, "StatusLeaf.tsx"),
    `
      export function StatusLeaf({ busy }: { busy: boolean }) {
        const label = busy ? "Busy" : "Ready";
        return <section data-busy={busy}><span>{label}</span></section>;
      }
    `,
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { StatusLeaf } from "./StatusLeaf";
      export function Screen() {
        const [busy, setBusy] = useState(true);
        const run = async () => { setBusy(false); await work(); };
        ${"\n".repeat(150)}
        const content = (
          <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
            <Actions /><Preview /><button onClick={run} /><StatusLeaf busy={busy} /></main>
        );
        return <Shell>{content}</Shell>;
      }
    `,
  );

  const report = await analyzePath(root);
  const finding = report.findings.find((candidate) => candidate.name === "busy");
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /child contract is verified/u);
  assert.match(requireValue(finding).message ?? "", /renders the `busy` value directly/u);
});

test("abstains when the resolved child stores the prop in its own state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-child-state-"));
  await writeFile(
    path.join(root, "StatusLeaf.tsx"),
    `
      import { useState } from "react";
      export function StatusLeaf({ busy }: { busy: boolean }) {
        const [seen, setSeen] = useState(busy);
        return <span>{String(seen)}</span>;
      }
    `,
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { StatusLeaf } from "./StatusLeaf";
      export function Screen() {
        const [busy, setBusy] = useState(true);
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={() => setBusy(false)} /><button onClick={() => setBusy(true)} />
          <StatusLeaf busy={busy} /></main>;
      }
    `,
  );

  const report = await analyzePath(root);
  const finding = report.findings.find((candidate) => candidate.name === "busy");
  assert.doesNotMatch(requireValue(finding).message ?? "", /child contract is verified/u);
});

test("abstains when the resolved child forwards the prop to another component", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-child-fwd-"));
  await writeFile(
    path.join(root, "StatusLeaf.tsx"),
    `
      import { Inner } from "./Inner";
      export function StatusLeaf({ busy }: { busy: boolean }) {
        return <Inner busy={busy} />;
      }
    `,
  );
  await writeFile(path.join(root, "Inner.tsx"), "export const Inner = () => null;");
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { StatusLeaf } from "./StatusLeaf";
      export function Screen() {
        const [busy, setBusy] = useState(true);
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={() => setBusy(false)} /><button onClick={() => setBusy(true)} />
          <StatusLeaf busy={busy} /></main>;
      }
    `,
  );

  const report = await analyzePath(root);
  const finding = report.findings.find((candidate) => candidate.name === "busy");
  assert.doesNotMatch(requireValue(finding).message ?? "", /child contract is verified/u);
});

test("abstains when the resolved child reads the prop inside effects or callbacks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-child-effect-"));
  await writeFile(
    path.join(root, "StatusLeaf.tsx"),
    `
      import { useEffect } from "react";
      export function StatusLeaf({ busy }: { busy: boolean }) {
        useEffect(() => report(busy), [busy]);
        return <span>{String(busy)}</span>;
      }
    `,
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { StatusLeaf } from "./StatusLeaf";
      export function Screen() {
        const [busy, setBusy] = useState(true);
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={() => setBusy(false)} /><button onClick={() => setBusy(true)} />
          <StatusLeaf busy={busy} /></main>;
      }
    `,
  );

  const report = await analyzePath(root);
  const finding = report.findings.find((candidate) => candidate.name === "busy");
  assert.doesNotMatch(requireValue(finding).message ?? "", /child contract is verified/u);
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
    `,
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
    `,
  );

  const report = await analyzePath(root);
  const finding = report.findings.find((candidate) => candidate.name === "open");
  assert.equal(requireValue(finding).action, "use-observable");
});
