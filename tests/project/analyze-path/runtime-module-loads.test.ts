import assert from "node:assert/strict";
import { mayLoadModuleAtRuntime } from "../../../src/project/analyze-path/hook-closure-index.js";
import test from "node:test";

test("keeps every spelling of a runtime module load for the call walk", () => {
  const loads = [
    'const page = import("./page");',
    'const page = import /* chunk */ ("./page");',
    'const page = import // chunk\n("./page");',
    'const page = import\u0085("./page");',
    'const page = import\u200B("./page");',
    'const page = import<Page>("./page");',
    'const config = require("./config");',
    String.raw`const config = \u0072equire("./config");`,
    'jest.mock("./config");',
    'vi.doMock("./config");',
    'jest.createMockFromModule("./config");',
    'registry.unstable_mockModule("./config");',
  ];
  for (const text of loads) {
    assert.equal(mayLoadModuleAtRuntime(text), true, text);
  }
});

test("skips the call walk for files with only static imports and ordinary calls", () => {
  const text = [
    'import React from "react";',
    'import type { Page } from "./page";',
    'import { importPage } from "./pages";',
    'export { load } from "./load";',
    "const meta = import.meta.url;",
    "importPage(meta);",
  ].join("\n");
  assert.equal(mayLoadModuleAtRuntime(text), false);
});
