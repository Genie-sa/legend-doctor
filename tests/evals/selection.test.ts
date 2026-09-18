import { parseSelection, selectionLines, validateSelection } from "../../evals/runner/selection.js";
import type { CorpusRepository } from "../../evals/corpus/contracts.js";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const corpus: CorpusRepository[] = ["public", "private"].map((name) => ({
  name,
  commit: "pin",
  url: "unused",
  targets: [],
}));

test("complete selection includes the loaded private slice and preserves paths with equals and spaces", () => {
  const selection = parseSelection(
    ["--repo", "public=./folder with spaces=x", "--complete", "--repo", "private=./private"],
    corpus,
  );
  validateSelection(selection, corpus);
  assert.equal(selection.complete, true);
  assert.equal(selection.roots.get("public"), path.resolve("./folder with spaces=x"));
  assert.deepEqual(selectionLines(selection, corpus), [
    "Complete corpus required: 2/2 repositories supplied.",
  ]);
  const missingPrivate = parseSelection(["--complete", "--repo", "public=./public"], corpus);
  assert.throws(
    () => validateSelection(missingPrivate, corpus),
    /Complete corpus requires every repository/u,
  );
});

test("default and explicit partial selection disclose omissions while allowing a nonempty subset", () => {
  for (const mode of [[], ["--partial"]]) {
    const selection = parseSelection([...mode, "--repo", "private=./private"], corpus);
    validateSelection(selection, corpus);
    assert.equal(selection.complete, false);
    assert.deepEqual(selectionLines(selection, corpus), [
      "Partial corpus: 1/2 repositories supplied.",
      "Omitted repository: public",
    ]);
  }
  const empty = parseSelection([], corpus);
  assert.deepEqual(selectionLines(empty, corpus), [
    "Partial corpus: 0/2 repositories supplied.",
    "Omitted repository: public",
    "Omitted repository: private",
  ]);
  assert.throws(() => validateSelection(empty, corpus), /No repositories supplied/u);
});

test("selection is independent of argument order and repeated identical modes without mutating caller arguments", () => {
  for (const args of [
    ["--complete", "--repo", "private=./private", "--repo", "public=./public", "--complete"],
    ["--repo", "public=./public", "--complete", "--repo", "private=./private"],
  ]) {
    const original = [...args];
    const selection = parseSelection(args, corpus);
    validateSelection(selection, corpus);
    assert.equal(selection.complete, true);
    assert.deepEqual([...selection.roots.keys()].toSorted(), ["private", "public"]);
    assert.deepEqual(args, original);
  }
});
