import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

test("moves a transported useValue subscription into one source-proven child", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-child-subscription-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "state.ts"),
    `
      import { observable } from "@legendapp/state";
      export const paletteOpen$ = observable(false);
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "palette.tsx"),
    `
      export function Palette({ open }: { open: boolean }) {
        return <dialog open={open}>Commands</dialog>;
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "screen.tsx"),
    `
      import { useValue } from "@legendapp/state/react";
      import { Palette } from "./palette";
      import { paletteOpen$ } from "./state";
      export function Screen({ children }: { children: React.ReactNode }) {
        const open = useValue(paletteOpen$);
        useGlobalShortcuts();
        return <>{children}<Palette open={open} /></>;
      }
    `,
    "utf8",
  );

  const report = await analyzePath(root);
  const finding = report.practices.find(
    (candidate) => candidate.action === "move-use-value-into-child",
  );
  assert.equal(requireValue(finding).location.file, "screen.tsx");
  assert.equal(requireValue(finding).location.line, 6);
  assert.match(requireValue(finding).message ?? "", /pass `paletteOpen\$` to `Palette`/u);
  assert.match(requireValue(finding).message ?? "", /subscribe inside the child/u);
});

test("keeps transported useValue subscriptions without one stable primitive child contract", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-child-subscription-negative-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "state.ts"),
    `
      import { observable } from "@legendapp/state";
      export const open$ = observable(false);
      export const panel$ = observable({ open: false });
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "palette.tsx"),
    `
      import { memo } from "react";
      export function Palette({ open }: { open: boolean }) { return <dialog open={open} />; }
      export const MemoPalette = memo(function MemoPalette({ open }: { open: boolean }) {
        return <dialog open={open} />;
      });
      export function ObjectPalette({ panel }: { panel: { open: boolean } }) {
        return <dialog open={panel.open} />;
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "screen.tsx"),
    `
      import { useValue } from "@legendapp/state/react";
      import { MemoPalette, ObjectPalette, Palette } from "./palette";
      import { open$, panel$ } from "./state";
      export function Conditional({ enabled }: { enabled: boolean }) {
        const open = useValue(open$);
        return enabled ? <Palette open={open} /> : null;
      }
      export function Keyed({ id }: { id: string }) {
        const open = useValue(open$);
        return <Palette key={id} open={open} />;
      }
      export function Repeated({ rows }: { rows: string[] }) {
        const open = useValue(open$);
        return <>{rows.map(row => <Palette key={row} open={open} />)}</>;
      }
      export function Shared() {
        const open = useValue(open$);
        return <><span>{String(open)}</span><Palette open={open} /></>;
      }
      export function DirectRead() {
        const open = useValue(open$);
        open$.get();
        return <Palette open={open} />;
      }
      export function Memoized() {
        const open = useValue(open$);
        return <MemoPalette open={open} />;
      }
      export function NonPrimitive() {
        const panel = useValue(panel$);
        return <ObjectPalette panel={panel} />;
      }
    `,
    "utf8",
  );

  const report = await analyzePath(root);
  assert.deepEqual(
    report.practices.filter((candidate) => candidate.action === "move-use-value-into-child"),
    [],
  );
});

test("analyzes useValue-only files for the narrowest observable child", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-observable-child-read-"));
  try {
    await mkdir(path.join(root, "state"), { recursive: true });
    await writeFile(
      path.join(root, "state", "profile.ts"),
      `
        import { observable } from "@legendapp/state";
        export const profile$ = observable({ name: "Ada", email: "ada@example.com" });
      `,
      "utf8",
    );
    await writeFile(
      path.join(root, "screen.tsx"),
      `
        import { useValue } from "@legendapp/state/react";
        import { profile$ } from "./state/profile";
        export function Screen() {
          const profile = useValue(profile$);
          return <span>{profile.name}</span>;
        }
      `,
      "utf8",
    );

    const report = await analyzePath(root);
    assert.equal(report.practices.length, 1);
    assert.equal(requireValue(report.practices[0]).action, "narrow-use-value-subscription");
    assert.equal(requireValue(report.practices[0]).location.file, "screen.tsx");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("places an observable subscription at one resolved child call site", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-contract-"));
  await writeFile(
    path.join(root, "StatusLeaf.tsx"),
    'export function StatusLeaf({ busy, onRun }: { busy: boolean; onRun: () => void }) { return <button onClick={onRun}>{busy ? "Busy" : "Ready"}</button>; }',
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
    `,
  );

  const report = await analyzePath(root);
  const finding = report.findings.find((candidate) => candidate.name === "busy");
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /stable `StatusLeaf` call site/u);
});
