import type { LegendPracticeFinding } from "../../src/core/types.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

const header = `
  import { useCallback, useMemo, useRef, useState } from "react";
  import { observable } from "@legendapp/state";
  import { useValue } from "@legendapp/state/react";
  interface Folder { id: string; name: string; deleted: boolean }
  declare function merge(value: unknown): string[];
  const LIMIT = 10;
`;

const store = `
  export const library$ = observable({
    folders: [] as Folder[],
    byAccount: {} as Record<string, Folder[]>,
    selectedId: "",
  });
`;

function findings(body: string, writes: string, preamble = header): LegendPracticeFinding[] {
  return analyzeLegendPractices({
    fileName: "fixture.tsx",
    sourceText: `${preamble}\n${store}\n${writes}\nexport function Library({ tab }: { tab: string }) {\n${body}\n}`,
  }).filter((finding) => finding.action === "snapshot-mutated-use-value");
}

const addFolder = `export function addFolder(folder: Folder) { library$.folders.unshift(folder); }`;

test("snapshots a useValue array that a membership write mutates in place", () => {
  const finding = requireValue(
    findings(
      `
        const folders = useValue(library$.folders);
        const visible = useMemo(() => folders.filter((folder) => !folder.deleted), [folders]);
        return <ul>{visible.length}</ul>;
      `,
      addFolder,
    )[0],
  );
  assert.equal(finding.disposition, "change");
  assert.equal(finding.confidence, "certain");
  assert.equal(finding.practice, "reactivity");
  assert.equal(finding.location.line, 19);
  assert.match(
    finding.message,
    /replace `useValue\(library\$\.folders\)` with `useValue\(\(\) => \[\.\.\.library\$\.folders\.get\(\)\]\)`/u,
  );
  assert.match(finding.message, /fixture\.tsx:16 \(`unshift`\)/u);
  assert.match(finding.message, /the useMemo at line 20 keyed on `folders` keeps a stale result/u);
});

test("proves the selector form and stable dependencies that cannot recompute the memo", () => {
  const finding = requireValue(
    findings(
      `
        const folders = useValue(() => library$.folders.get());
        const seen = useRef(0);
        const [, setOpen] = useState(false);
        const top = useMemo(() => folders.slice(0, LIMIT), [folders, seen, setOpen, LIMIT]);
        return <ul onClick={() => setOpen(true)}>{top.length}</ul>;
      `,
      addFolder,
    )[0],
  );
  assert.equal(finding.disposition, "change");
  assert.match(finding.message, /`useValue\(\(\) => \[\.\.\.library\$\.folders\.get\(\)\]\)`/u);
});

test("proves a record whose child is replaced in place and suggests an object copy", () => {
  const finding = requireValue(
    findings(
      `
        const byAccount = useValue(library$.byAccount);
        const merged = useMemo(() => merge(byAccount), [byAccount]);
        return <ul>{merged.length}</ul>;
      `,
      `export function load(id: string, list: Folder[]) { library$.byAccount[id].set(list); }`,
    )[0],
  );
  assert.equal(finding.disposition, "change");
  assert.match(
    finding.message,
    /`useValue\(\(\) => \(\{ \.\.\.library\$\.byAccount\.get\(\) \}\)\)`/u,
  );
});

const loadAccount = `export function load(id: string, list: Folder[]) { library$.byAccount[id].set(list); }`;
const longestMemo = `const longest = useMemo(() => Math.max(0, ...Object.values(byAccount).map((list) => list?.length ?? 0)), [byAccount]);`;

test("selects a primitive when one side-effect-free memo is the snapshot's only reader", () => {
  const finding = requireValue(
    findings(
      `
        const byAccount = useValue(library$.byAccount);
        ${longestMemo}
        return <ul>{longest}</ul>;
      `,
      loadAccount,
    )[0],
  );
  assert.equal(finding.disposition, "change");
  assert.equal(
    finding.message,
    "Select the primitive instead of a snapshot: replace the useMemo at line 20 with `const longest = useValue(() => …)` computing the same expression from `library$.byAccount.get()` in place of `byAccount`, and delete `const byAccount = useValue(library$.byAccount)`. The in-place write at fixture.tsx:16 (`set`) keeps the reference, so the memo keeps a stale result; the selector reruns on every render, and an observable write rerenders the component only when `longest` changes.",
  );
});

test("keeps the copy advice when the memo returns a reference or the snapshot has other readers", () => {
  for (const body of [
    `const byAccount = useValue(library$.byAccount);
     const lists = useMemo(() => Object.values(byAccount).map((list) => list?.length ?? 0), [byAccount]);
     return <ul>{lists.length}</ul>;`,
    `const byAccount = useValue(library$.byAccount);
     ${longestMemo}
     return <ul data-accounts={Object.keys(byAccount).length}>{longest}</ul>;`,
    `const byAccount = useValue(library$.byAccount);
     const longest = useMemo(() => Math.max(0, ...Object.values(byAccount).map((list) => merge(list).length)), [byAccount]);
     return <ul>{longest}</ul>;`,
  ]) {
    const finding = requireValue(findings(body, loadAccount)[0]);
    assert.equal(finding.disposition, "change", body);
    assert.match(
      finding.message,
      /^Select a copy so the reference changes with the contents: replace `useValue\(library\$\.byAccount\)` with `useValue\(\(\) => \(\{ \.\.\.library\$\.byAccount\.get\(\) \}\)\)`/u,
      body,
    );
  }
});

test("asks for review when another reactive dependency may change with the write", () => {
  for (const other of ["tab", "folders.length"]) {
    const finding = requireValue(
      findings(
        `
          const folders = useValue(library$.folders);
          const visible = useMemo(() => folders.filter((folder) => folder.name === tab), [folders, ${other}]);
          return <ul>{visible.length}</ul>;
        `,
        addFolder,
      )[0],
    );
    assert.equal(finding.disposition, "candidate", other);
    assert.equal(finding.confidence, "probable");
    assert.ok(
      finding.message.startsWith(
        `The in-place write at fixture.tsx:16 (\`unshift\`) keeps the reference of \`folders\`, so the useMemo at line 20 recomputes only when \`${other}\` also changes.`,
      ),
      finding.message,
    );
  }
});

test("matches element field writes only against the fields the memo reads", () => {
  const rename = `export function rename(index: number, name: string) { library$.folders[index].name.set(name); }`;
  const readsName = findings(
    `
      const folders = useValue(library$.folders);
      const names = useMemo(() => folders.map(({ name }) => name.toUpperCase()), [folders]);
      return <ul>{names.length}</ul>;
    `,
    rename,
  );
  assert.equal(requireValue(readsName[0]).disposition, "change");
  const readsDeleted = findings(
    `
      const folders = useValue(library$.folders);
      const visible = useMemo(() => folders.filter((folder) => !folder.deleted), [folders]);
      return <ul>{visible.map((folder) => <li key={folder.id}>{folder.name}</li>)}</ul>;
    `,
    rename,
  );
  assert.deepEqual(readsDeleted, []);
});

test("ignores writes that replace the reference the memo compares", () => {
  for (const writes of [
    `export function reset(list: Folder[]) { library$.folders.set(list); }`,
    `export function load(list: Folder[]) { library$.set({ folders: list, byAccount: {}, selectedId: "" }); }`,
    `export function select(id: string) { library$.selectedId.set(id); }`,
    `export function raw(folder: Folder) { library$.folders.get().push(folder); }`,
    `export function shadowed(library$: { folders: Folder[] }, folder: Folder) { library$.folders.push(folder); }`,
    `const other$ = observable({ folders: [] as Folder[] });
     export function elsewhere(folder: Folder) { other$.folders.push(folder); }`,
  ]) {
    assert.deepEqual(
      findings(
        `
          const folders = useValue(library$.folders);
          const visible = useMemo(() => folders.filter((folder) => !folder.deleted), [folders]);
          return <ul>{visible.length}</ul>;
        `,
        writes,
      ),
      [],
      writes,
    );
  }
});

test("ignores bindings and memos that do not compare the raw useValue reference", () => {
  for (const body of [
    `const folders = useValue(() => [...library$.folders.get()]);
     const visible = useMemo(() => folders.filter((folder) => !folder.deleted), [folders]);
     return <ul>{visible.length}</ul>;`,
    `const folders = useValue(library$.folders);
     const visible = useMemo(() => folders.filter((folder) => !folder.deleted), [tab]);
     return <ul>{visible.length}</ul>;`,
    `const folders = useValue(library$.folders);
     const pick = useCallback(() => folders.filter((folder) => !folder.deleted), [folders]);
     return <ul onClick={pick} />;`,
    `const folders = useValue(library$.folders);
     const visible = useMemo(() => { const folders: Folder[] = []; return folders.length; }, [folders]);
     return <ul>{visible}</ul>;`,
    `let folders = useValue(library$.folders);
     const visible = useMemo(() => folders.filter((folder) => !folder.deleted), [folders]);
     return <ul>{visible.length}</ul>;`,
    `const folders = useValue(library$.folders, { suspense: true });
     const visible = useMemo(() => folders.filter((folder) => !folder.deleted), [folders]);
     return <ul>{visible.length}</ul>;`,
    `const folders = useValue(library$.folders);
     const first = useMemo(() => folders, [folders]);
     return <ul>{first.length}</ul>;`,
  ]) {
    assert.deepEqual(findings(body, addFolder), [], body);
  }
});
