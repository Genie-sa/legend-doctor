import { act, createElement as jsx, useMemo } from "react";
import { count, mountDom } from "../../src/runtime/dom.js";
import type { Observable } from "@legendapp/state";
import type { ReactElement } from "react";
import assert from "node:assert/strict";
import { observable } from "@legendapp/state";
import test from "node:test";
import { useValue } from "@legendapp/state/react";

interface Library {
  folders: { name: string }[];
  counts: Record<string, number>;
}

interface WriteCase {
  name: string;
  derive: (library: Library) => string;
  write: (library$: Observable<Library>) => void;
  before: string;
  after: string;
}

type Selection = "raw" | "snapshot";

const folderNames = (library: Library): string =>
  library.folders.map((folder) => folder.name).join(",");
const countKeys = (library: Library): string => Object.keys(library.counts).join(",");

const CASES = [
  {
    name: "push",
    derive: folderNames,
    write: (library$): void => {
      library$.folders.push({ name: "b" });
    },
    before: "a",
    after: "a,b",
  },
  {
    name: "splice",
    derive: folderNames,
    write: (library$): void => {
      library$.folders.splice(0, 1);
    },
    before: "a",
    after: "",
  },
  {
    name: "element field set",
    derive: folderNames,
    write: (library$): void => {
      library$.folders[0]!.name.set("z");
    },
    before: "a",
    after: "z",
  },
  {
    name: "assign",
    derive: countKeys,
    write: (library$): void => {
      library$.counts.assign({ jazz: 2 });
    },
    before: "rock",
    after: "rock,jazz",
  },
  {
    name: "member delete",
    derive: countKeys,
    write: (library$): void => {
      library$.counts.rock!.delete();
    },
    before: "rock",
    after: "",
  },
] satisfies WriteCase[];

interface LibraryProps {
  library$: Observable<Library>;
  selection: Selection;
  writeCase: WriteCase;
  renders: Map<string, number>;
}

function useLibrary(library$: Observable<Library>, selection: Selection): Library {
  const folders = useValue(
    selection === "raw" ? library$.folders : (): Library["folders"] => [...library$.folders.get()],
  );
  const counts = useValue(
    selection === "raw" ? library$.counts : (): Library["counts"] => ({ ...library$.counts.get() }),
  );
  return { counts, folders };
}

function LibrarySummary({ library$, selection, writeCase, renders }: LibraryProps): ReactElement {
  count(renders, "summary");
  const { folders, counts } = useLibrary(library$, selection);
  const summary = useMemo(
    () => writeCase.derive({ counts, folders }),
    [folders, counts, writeCase],
  );
  return jsx("output", null, summary);
}

async function renderAfterWrite(
  context: test.TestContext,
  strict: boolean,
  props: Omit<LibraryProps, "library$" | "renders">,
): Promise<{ renders: number; text: string }> {
  const ui = mountDom(context, strict);
  const library$ = observable<Library>({ counts: { rock: 1 }, folders: [{ name: "a" }] });
  const renders = new Map<string, number>();
  await ui.render(jsx(LibrarySummary, { ...props, library$, renders }));
  assert.equal(ui.element("output").textContent, props.writeCase.before);
  renders.clear();
  await act(() => props.writeCase.write(library$));
  return { renders: renders.get("summary") ?? 0, text: ui.element("output").textContent ?? "" };
}

for (const strict of [false, true]) {
  for (const writeCase of CASES) {
    test(`an in-place ${writeCase.name} rerenders a raw useValue but keeps its memo stale (strict=${strict})`, async (context) => {
      const raw = await renderAfterWrite(context, strict, { selection: "raw", writeCase });
      assert.ok(raw.renders > 0, "the owner rerenders on the in-place write");
      assert.equal(raw.text, writeCase.before, "the memo keyed on the kept reference is stale");
    });

    test(`a selected copy recomputes the memo after an in-place ${writeCase.name} (strict=${strict})`, async (context) => {
      const snapshot = await renderAfterWrite(context, strict, {
        selection: "snapshot",
        writeCase,
      });
      assert.equal(snapshot.text, writeCase.after);
    });
  }
}
