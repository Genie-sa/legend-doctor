import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

test("finds aliased React hooks through the ordinary path scan", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-aliased-hooks-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "component.tsx"),
    'import { useState as state } from "react"; export function C() { const [value] = state(1); return <>{value}</>; }',
    "utf8",
  );

  const report = await analyzePath(root);

  assert.equal(report.hooks.states, 1);
  assert.equal(requireValue(report.findings[0]).name, "value");
});

test("surfaces legacy hook practices in read-only files through the path prefilter", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-practice-eligibility-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "legacy.ts"),
    `
      import { useSelector } from "@legendapp/state/react";
      export function read(value: string) { return useSelector(() => value); }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "use-t.ts"),
    `
      import { use$ } from "@legendapp/state/react";
      import { i18n$ } from "./legacy.js";
      export function useT() { return use$(i18n$.strings); }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "plain.ts"),
    "export function useT(value: string) { return value.trim(); }",
    "utf8",
  );

  const report = await analyzePath(root);

  assert.deepEqual(
    report.practices.map((practice) => [practice.location.file, practice.action]),
    [
      ["legacy.ts", "replace-legacy-use-value"],
      ["use-t.ts", "replace-legacy-use-value"],
    ],
  );
});

test("replaces an exact React mirror of a one-hop Legend value hook", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-value-bridge-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "state.ts"),
    `
      import { observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      const name$ = observable("");
      const other$ = observable("");
      export function useName() { return useValue(name$) ?? ""; }
      export function setName(next: string) { name$.set(next); }
      export function setOther(next: string) { other$.set(next); }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useEffect, useState } from "react";
      import { setName as writeName, setOther as writeOther, useName as useSavedName } from "./state";
      export function Screen() {
        const saved = useSavedName();
        const otherSaved = useSavedName();
        const wrongSaved = useSavedName();
        const [name, setDraftName] = useState(saved);
        const [mismatch, setMismatch] = useState(otherSaved);
        const [wrongSource, setWrongSource] = useState(wrongSaved);
        const onName = (next: string) => { setDraftName(next); writeName(next); };
        const onMismatch = (next: string) => { setMismatch(next); writeName(next.trim()); };
        const onWrongSource = (next: string) => { setWrongSource(next); writeOther(next); };
        return <><input value={name} onChange={event => onName(event.target.value)} />
          <input value={mismatch} onChange={event => onMismatch(event.target.value)} />
          <input value={wrongSource} onChange={event => onWrongSource(event.target.value)} /></>;
      }
    `,
    "utf8",
  );

  const report = await analyzePath(root);
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "name")).action,
    "use-value",
  );
  assert.notEqual(
    requireValue(report.findings.find((finding) => finding.name === "mismatch")).action,
    "use-value",
  );
  assert.notEqual(
    requireValue(report.findings.find((finding) => finding.name === "wrongSource")).action,
    "use-value",
  );
});

test("a legacy rename alone leaves the subscription inventory unresolved with its reasons", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-legacy-inventory-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "screen.tsx"),
    `
      import { use$, useObservable } from "@legendapp/state/react";
      import { useEffect } from "react";
      export function Screen({ load }: { load: () => string }) {
        const selected$ = useObservable(load);
        const selected = use$(selected$);
        useEffect(() => sync(selected), []);
        return <main/>;
      }
    `,
    "utf8",
  );

  const report = await analyzePath(root);

  assert.deepEqual(
    report.practices.map((practice) => practice.action),
    ["replace-legacy-use-value"],
  );
  const entry = requireValue(
    report.subscriptionAnalysis?.inventory.find((item) => item.binding === "selected"),
  );
  assert.equal(entry.status, "unresolved");
  assert.deepEqual(entry.reasons, ["effect-consumer", "no-render-consumer"]);
});
