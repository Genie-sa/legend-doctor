import type { TextEdit } from "../../src/core/types.js";
import { applyTextEdits } from "../../src/core/text-edits.js";
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { typecheckDiagnostics } from "./typecheck.js";

const SOURCE = "const a = 1;\nconst b = 2;\n";

function sourceFile(): ts.SourceFile {
  return ts.createSourceFile("fixture.ts", SOURCE, ts.ScriptTarget.Latest, true);
}

function edit(line: number, [start, end]: readonly [number, number], newText: string): TextEdit {
  return {
    end: { column: end, line },
    file: "fixture.ts",
    newText,
    start: { column: start, line },
  };
}

test("applies edits in source coordinates and applies identical copies once", () => {
  const rename = edit(1, [7, 8], "first");
  assert.equal(
    applyTextEdits(sourceFile(), [edit(2, [11, 12], "3"), rename, rename]),
    "const first = 1;\nconst b = 3;\n",
  );
});

test("accepts adjacent replacements and rejects overlaps and ambiguous insertions", () => {
  assert.equal(
    applyTextEdits(sourceFile(), [edit(1, [1, 6], "let"), edit(1, [6, 8], " z")]),
    "let z = 1;\nconst b = 2;\n",
  );
  assert.throws(() => applyTextEdits(sourceFile(), [edit(1, [1, 8], ""), edit(1, [7, 9], "")]));
  assert.throws(() => applyTextEdits(sourceFile(), [edit(1, [7, 7], "x"), edit(1, [7, 8], "y")]));
});

test("the typecheck harness resolves the installed Legend State types", () => {
  assert.deepEqual(
    typecheckDiagnostics(`import { observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";

const counter$ = observable({ count: 0 });

export function useCount(): string {
  const count: string = useValue(counter$.count);
  return count;
}
`),
    ["Type 'number' is not assignable to type 'string'."],
  );
});
