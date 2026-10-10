import type { FileCapabilities } from "../../src/project/capabilities.js";
import type { LegendPracticeFinding } from "../../src/core/types.js";
import { NO_CAPABILITIES } from "../../src/project/capabilities.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

const COMPILED: FileCapabilities = { ...NO_CAPABILITIES, reactCompiler: true };

const SOURCE = `
  import { observable } from "@legendapp/state";
  import { useValue } from "@legendapp/state/react";
  interface Folder { id: string; name: string; deleted: boolean }
  declare function useFolderCount(folders: Folder[]): number;
  declare function sortFolders(folders: Folder[]): Folder[];
  export const library$ = observable({ folders: [] as Folder[] });
  export function addFolder(folder: Folder) { library$.folders.unshift(folder); }
  export function hideFirst() { library$.folders[0]!.deleted.set(true); }
`;

function findings(
  body: string,
  capabilities: FileCapabilities = COMPILED,
): LegendPracticeFinding[] {
  return analyzeLegendPractices({
    capabilities,
    fileName: "fixture.tsx",
    sourceText: `${SOURCE}\nexport function Library({ tab }: { tab: string }) {\n${body}\n}`,
  }).filter((finding) => finding.action === "snapshot-mutated-use-value");
}

const RENDERED_MAP = `
  const folders = useValue(library$.folders);
  return <ul>{folders.map((folder) => <li key={folder.id}>{folder.name}</li>)}</ul>;
`;

test("a compiled render that maps the snapshot is memoized on its reference", () => {
  const finding = requireValue(findings(RENDERED_MAP)[0]);
  assert.equal(finding.disposition, "change");
  assert.match(
    finding.message,
    /the call the React Compiler memoizes at line \d+ keyed on `folders`/u,
  );
  assert.match(finding.message, /`useValue\(\(\) => \[\.\.\.library\$\.folders\.get\(\)\]\)`/u);
  assert.doesNotMatch(finding.message, /without useMemo/u);
  assert.deepEqual(findings(RENDERED_MAP, NO_CAPABILITIES), []);
});

test("a derived constant that reaches the output is memoized too", () => {
  const [finding] = findings(`
    const folders = useValue(library$.folders);
    const sorted = sortFolders(folders);
    return <ul>{sorted.length}<Rows rows={sorted} /></ul>;
  `);
  assert.equal(requireValue(finding).disposition, "change");
});

test("a captured value that can change between renders leaves a candidate", () => {
  const [finding] = findings(`
    const folders = useValue(library$.folders);
    return <ul>{folders.filter((folder) => folder.id !== tab).map((folder) => folder.name)}</ul>;
  `);
  assert.equal(requireValue(finding).disposition, "candidate");
  assert.match(requireValue(finding).message, /recomputes only when `tab` also changes/u);
});

test("reads the Compiler does not cache on the snapshot reference stay silent", () => {
  for (const body of [
    `const folders = useValue(library$.folders); return <ul>{folders.length}</ul>;`,
    `const folders = useValue(library$.folders); const count = folders.filter((folder) => !folder.deleted).length; return <ul>{count}</ul>;`,
    `const folders = useValue(library$.folders); const count = useFolderCount(folders); return <ul>{count}</ul>;`,
    `const folders = useValue(library$.folders); const names = folders.map((folder) => folder.name); return null;`,
    `"use no memo"; const folders = useValue(library$.folders); return <ul>{folders.map((folder) => folder.id)}</ul>;`,
    `const folders = useValue(library$.folders); return <ul>{folders.map((folder) => <li key={folder.id}>{folder.name}</li>)}</ul>;`.replace(
      "library$.folders);",
      "library$.folders); // eslint-disable-next-line react-hooks/exhaustive-deps\n",
    ),
  ]) {
    assert.deepEqual(findings(body), [], body);
  }
});

test("a write below an unread member does not make the cached call stale", () => {
  const writes = findings(RENDERED_MAP);
  assert.deepEqual(
    writes.map(
      (finding) =>
        finding.message.match(/fixture\.tsx:\d+ \(`(?<method>\w+)`\)/u)?.groups?.["method"],
    ),
    ["unshift"],
  );
});
