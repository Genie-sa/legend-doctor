import { CLONE_WRITE_COMPONENT, cloneWriteRoot } from "./harness.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("react compiler packages keep identity-changing clone writes", async (testContext) => {
  const root = await cloneWriteRoot("legend-doctor-compiler-", {
    devDependencies: { "babel-plugin-react-compiler": "1.0.0" },
    name: "app",
  });
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const report = await analyzePath(root);
  const actions = new Set(report.practices.map((practice) => practice.action));

  assert.ok(actions.has("toggle-observable"));
  assert.ok(!actions.has("narrow-observable-write"));
});

test("clone writes stay narrowed without an explicit react compiler marker", async (testContext) => {
  const root = await cloneWriteRoot("legend-doctor-no-compiler-", {
    dependencies: { "react-native": "0.86.2" },
    name: "app",
  });
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "app.json"),
    JSON.stringify({ expo: { experiments: { reactCompiler: false } } }),
    "utf8",
  );

  const report = await analyzePath(root);

  assert.ok(report.practices.some((practice) => practice.action === "narrow-observable-write"));
});

test("expo experiments enable the react compiler gate", async (testContext) => {
  const root = await cloneWriteRoot("legend-doctor-expo-compiler-", { name: "app" });
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "app.json"),
    JSON.stringify({ expo: { experiments: { reactCompiler: true } } }),
    "utf8",
  );

  const report = await analyzePath(root);
  const actions = new Set(report.practices.map((practice) => practice.action));

  assert.ok(actions.has("toggle-observable"));
  assert.ok(!actions.has("narrow-observable-write"));
});

test("a code-based expo config enabling the compiler gates clone writes", async (testContext) => {
  const root = await cloneWriteRoot("legend-doctor-expo-config-", { name: "app" });
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "app.config.ts"),
    "export default { experiments: { reactCompiler: true } };\n",
    "utf8",
  );

  const report = await analyzePath(root);

  assert.ok(!report.practices.some((practice) => practice.action === "narrow-observable-write"));
});

test("a babel config naming the compiler plugin gates clone writes", async (testContext) => {
  const root = await cloneWriteRoot("legend-doctor-babel-compiler-", { name: "app" });
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "babel.config.js"),
    'module.exports = { plugins: [["babel-plugin-react-compiler", { target: "19" }]] };\n',
    "utf8",
  );

  const report = await analyzePath(root);

  assert.ok(!report.practices.some((practice) => practice.action === "narrow-observable-write"));
});

test("a vite config using reactCompilerPreset gates clone writes", async (testContext) => {
  const root = await cloneWriteRoot("legend-doctor-vite-compiler-", { name: "app" });
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "vite.config.js"),
    'import react, { reactCompilerPreset } from "@vitejs/plugin-react";\nexport default { plugins: [react({ babel: { presets: [reactCompilerPreset()] } })] };\n',
    "utf8",
  );

  const report = await analyzePath(root);

  assert.ok(!report.practices.some((practice) => practice.action === "narrow-observable-write"));
});

test("a next config enabling reactCompiler gates clone writes", async (testContext) => {
  const root = await cloneWriteRoot("legend-doctor-next-compiler-", { name: "app" });
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "next.config.mjs"),
    "export default { experimental: { reactCompiler: true } };\n",
    "utf8",
  );

  const report = await analyzePath(root);

  assert.ok(!report.practices.some((practice) => practice.action === "narrow-observable-write"));
});

test("a next config with reactCompiler disabled keeps clone writes narrowed", async (testContext) => {
  const root = await cloneWriteRoot("legend-doctor-next-off-", { name: "app" });
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "next.config.mjs"),
    "export default { experimental: { reactCompiler: false } };\n",
    "utf8",
  );

  const report = await analyzePath(root);

  assert.ok(report.practices.some((practice) => practice.action === "narrow-observable-write"));
});

test("compiler ownership walks up from each file's nearest package", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-compiler-workspace-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, "apps", "web"), { recursive: true });
  await mkdir(path.join(root, "packages", "ui"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "workspace" }), "utf8");
  await writeFile(
    path.join(root, "apps", "web", "package.json"),
    JSON.stringify({ dependencies: { "react-compiler-runtime": "19.0.0" }, name: "web" }),
    "utf8",
  );
  await writeFile(
    path.join(root, "packages", "ui", "package.json"),
    JSON.stringify({ name: "ui" }),
    "utf8",
  );
  await writeFile(path.join(root, "apps", "web", "pages.tsx"), CLONE_WRITE_COMPONENT, "utf8");
  await writeFile(path.join(root, "packages", "ui", "pages.tsx"), CLONE_WRITE_COMPONENT, "utf8");

  const report = await analyzePath(root);
  const narrowWriteFiles = report.practices
    .filter((practice) => practice.action === "narrow-observable-write")
    .map((practice) => practice.location.file);

  assert.deepEqual(narrowWriteFiles, [path.join("packages", "ui", "pages.tsx")]);
});
