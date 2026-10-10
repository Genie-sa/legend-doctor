import { CLONE_WRITE_COMPONENT, cloneWriteRoot } from "./harness.js";
import {
  disabledPracticeRules,
  enabledPracticeRules,
} from "../../../src/practices/practice-rules.js";
import { rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

test("the report names the toolchain facts and the practice rules they switched off", async (testContext) => {
  const root = await cloneWriteRoot("legend-doctor-capabilities-compiler-", {
    devDependencies: { "babel-plugin-react-compiler": "1.0.0" },
    name: "app",
  });
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const report = await analyzePath(root);

  assert.equal(report.capabilities.reactCompiler, true);
  assert.deepEqual(
    report.capabilities.disabledRules.map(({ files, reason, rule }) => ({ files, reason, rule })),
    [{ files: 1, reason: "react-compiler", rule: "observable-clone-writes" }],
  );
  assert.ok(!report.practices.some((practice) => practice.action === "narrow-observable-write"));
});

test("a root without gates reports every practice rule as active", async (testContext) => {
  const root = await cloneWriteRoot("legend-doctor-capabilities-plain-", { name: "app" });
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const report = await analyzePath(root);

  assert.deepEqual(report.capabilities, { disabledRules: [], reactCompiler: false });
  assert.equal(report.scope, undefined);
  assert.ok(report.practices.some((practice) => practice.action === "narrow-observable-write"));
});

test("a file filter narrows analysis while the context keeps every target file", async (testContext) => {
  const root = await cloneWriteRoot("legend-doctor-capabilities-filter-", { name: "app" });
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(path.join(root, "other.tsx"), CLONE_WRITE_COMPONENT, "utf8");

  const report = await analyzePath(root, {
    fileFilter: (file) => path.basename(file) === "other.tsx",
  });

  assert.equal(report.files, 1);
  assert.deepEqual(report.scope, { contextFiles: 2 });
  assert.ok(report.practices.length > 0);
  assert.ok(report.practices.every((practice) => practice.location.file === "other.tsx"));
});

test("only the React Compiler flag gates a practice rule", () => {
  assert.deepEqual(
    disabledPracticeRules({ legendBabel: false, reactCompiler: true }).map(({ reason, rule }) => ({
      reason,
      rule,
    })),
    [{ reason: "react-compiler", rule: "observable-clone-writes" }],
  );
  assert.deepEqual(
    enabledPracticeRules({ legendBabel: false, reactCompiler: false }).map((rule) => rule.id),
    [
      "plain-primitive-projection",
      "fresh-selector-results",
      "legacy-use-value",
      "observable-transactions",
      "observable-reads",
      "observable-clone-writes",
      "observable-toggle",
      "observable-tracking",
      "in-place-memo-keys",
      "memo-parent-captures",
      "observable-ownership",
    ],
  );
});
