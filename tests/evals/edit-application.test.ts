import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Evaluation } from "../../evals/runner/model.js";
import type { LegendPracticeFinding } from "../../src/core/types.js";
import assert from "node:assert/strict";
import { editApplicationLines } from "../../evals/runner/edit-application.js";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function peekFinding(line: number, newText: string): LegendPracticeFinding {
  return {
    action: "use-peek-for-snapshot",
    confidence: "probable",
    disposition: "style",
    edits: [
      {
        end: { column: 14, line },
        file: "screen.ts",
        newText,
        start: { column: 11, line },
      },
    ],
    evidence: [],
    location: { column: 7, file: "screen.ts", line },
    message: "",
    practice: "reactivity",
  };
}

function evaluation(root: string, practices: LegendPracticeFinding[]): Evaluation {
  return {
    failures: [],
    hooks: 0,
    targets: new Map([
      [
        "feature",
        {
          application: "app",
          repository: "repo",
          root,
          report: {
            capabilities: {
              concurrentRoot: false,
              disabledRules: [],
              legendState: null,
              reactCompiler: false,
            },
            files: 1,
            findings: [],
            hooks: { effects: 0, states: 0, total: 0 },
            practices,
            schemaVersion: 4,
          },
        },
      ],
    ]),
  };
}

test("applies corpus edits in memory and fails any edit whose result does not parse", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-edits-"));
  try {
    await writeFile(path.join(root, "screen.ts"), "read(a$.x.get());\nread(b$.x.get());\n");
    const run = evaluation(root, [peekFinding(1, "peek"), peekFinding(2, "(((")]);
    assert.deepEqual(await editApplicationLines(run), [
      "Verified edits [app]: use-peek-for-snapshot 2/2; 1 edited files checked.",
    ]);
    assert.equal(run.failures.length, 2);
    assert.match(run.failures[0] ?? "", /^feature\/screen\.ts:2 use-peek-for-snapshot edits: /u);
    assert.match(run.failures[1] ?? "", /^feature\/screen\.ts combined edits: /u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
