import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

test("isolates pure controlled projections owned by one source component call site", async (testContext) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "legend-doctor-controlled-callsite-projection-"),
  );
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "Details.tsx"),
    `
      export function Dashboard() {
        return <section>Independent content</section>;
      }
      export function DetailDialog({ open, resourceId, onOpenChange }: {
        open: boolean;
        resourceId: string | null;
        onOpenChange: (open: boolean) => void;
      }) {
        return <dialog open={open} data-resource={resourceId} onClose={() => onOpenChange(false)} />;
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { Dashboard, DetailDialog } from "./Details";
      declare function normalize(open: boolean): string | null;
      export function SafeScreen({ id }: { id: string }) {
        const [open, setOpen] = useState(false);
        return <main>
          <Dashboard />
          <span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span />
          <button onClick={() => setOpen(true)}>Open</button>
          <DetailDialog resourceId={open ? id : null} open={open} onOpenChange={setOpen} />
        </main>;
      }
      export function UnsafeScreen() {
        const [open, setOpen] = useState(false);
        return <main>
          <Dashboard />
          <span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span />
          <button onClick={() => setOpen(true)}>Open</button>
          <DetailDialog resourceId={normalize(open)} open={open} onOpenChange={setOpen} />
        </main>;
      }
    `,
    "utf8",
  );

  const report = await analyzePath(root);
  const states = report.findings.filter((finding) => finding.hook === "useState");
  assert.equal(requireValue(states[0]).action, "use-observable");
  assert.equal(requireValue(states[1]).action, "review-state");
});

test("wraps a shared primitive locally without changing its API", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-shared-primitive-"));
  await mkdir(path.join(root, "components", "ui"), { recursive: true });
  await writeFile(
    path.join(root, "components", "ui", "Dialog.tsx"),
    "export function Dialog({ open }: { open: boolean }) { return open ? <aside /> : null; }",
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
    `,
  );

  const report = await analyzePath(root);
  const finding = report.findings.find((candidate) => candidate.name === "open");
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /call-site leaf wrapper/u);
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
    `,
  );

  const report = await analyzePath(root);
  const finding = report.findings.find((candidate) => candidate.name === "tab");
  assert.equal(requireValue(finding).action, "move-state-down");
  assert.match(requireValue(finding).message ?? "", /stable local wrapper/u);
});

test("isolates immediate controlled state from delayed repeated owner work", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-delayed-controlled-leaf-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "Input.tsx"),
    `
      export function Input({ value, onChange }: { value: string; onChange: (value: string) => void }) {
        return <input value={value} onChange={event => onChange(event.target.value)} />;
      }
    `,
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useRef, useState } from "react";
      import { Input } from "./Input";
      export function Screen({ rows }: { rows: string[] }) {
        const [query, setQuery] = useState("");
        const [settledQuery, setSettledQuery] = useState("");
        const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
        const onChange = (value: string) => {
          setQuery(value);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setSettledQuery(value), 300);
        };
        return <main>
          <Input value={query} onChange={onChange} />
          <p>{settledQuery}</p>
          {rows.map(row => <article key={row}>{row}</article>)}
        </main>;
      }
    `,
  );

  const report = await analyzePath(root);
  const finding = report.findings.find((candidate) => candidate.name === "query");
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /repeated render work/u);
});

test("keeps delayed controlled state when its immediate update is atomic with owner state", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-delayed-controlled-atomic-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "Input.tsx"),
    `
      export function Input({ value, onChange }: { value: string; onChange: (value: string) => void }) {
        return <input value={value} onChange={event => onChange(event.target.value)} />;
      }
    `,
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { Input } from "./Input";
      export function Screen({ rows }: { rows: string[] }) {
        const [query, setQuery] = useState("");
        const [page, setPage] = useState(1);
        const onChange = (value: string) => {
          setQuery(value);
          setPage(1);
        };
        return <main>
          <Input value={query} onChange={onChange} />
          <p>{page}</p>
          {rows.map(row => <article key={row}>{row}</article>)}
        </main>;
      }
    `,
  );

  const report = await analyzePath(root);
  const finding = report.findings.find((candidate) => candidate.name === "query");
  assert.equal(requireValue(finding).action, "review-state");
});

test("does not count repeated work inside the leaf or a conditional sibling", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-repeated-inside-leaf-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "Panel.tsx"),
    `
      import type { ReactNode } from "react";
      export function Panel({ value, children }: { value: string; children: ReactNode }) {
        return <section data-value={value}>{children}</section>;
      }
    `,
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { Panel } from "./Panel";
      export function Screen({ rows, showRows }: { rows: string[]; showRows: boolean }) {
        const [query, setQuery] = useState("");
        return <main>
          <button onClick={() => setQuery("next")} />
          <Panel value={query}>
            {rows.map(row => <article key={row}>{row}</article>)}
          </Panel>
          {showRows ? rows.map(row => <aside key={row}>{row}</aside>) : null}
        </main>;
      }
    `,
  );

  const report = await analyzePath(root);
  const finding = report.findings.find((candidate) => candidate.name === "query");
  assert.equal(requireValue(finding).action, "review-state");
});
