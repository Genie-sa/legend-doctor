import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { analyzePathDetailed } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import { createAnalysisContext } from "../../../src/project/analyze-path/analysis-context.js";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SCREEN = `
import { useState } from "react";
import { Button } from "@fixture/ui/button";
export function Screen() {
  const [pending, setPending] = useState(false);
  const submit = async () => {
    setPending(true);
    try { await save(); } finally { setPending(false); }
  };
  return <main><header /><nav /><aside /><section /><article /><footer />
    <hr /><p /><p /><p /><p /><p /><Button disabled={pending} onClick={submit} /></main>;
}`;
const BUTTON = `
import { useRender } from "@base-ui/react/use-render";
import { mergeProps } from "@base-ui/react/merge-props";
export function Button({ render, ...props }) {
  return useRender({ defaultTagName: "button", props: mergeProps({}, props), render });
}`;
const CASES = [
  {
    name: "declared workspace export",
    exports: { "./button": "./src/button.tsx" },
    dependency: "workspace:*",
    button: BUTTON,
    action: "use-observable",
  },
  {
    name: "private source",
    exports: { "./other": "./src/button.tsx" },
    dependency: "workspace:*",
    button: BUTTON,
    action: "review-state",
  },
  {
    name: "registry version",
    exports: { "./button": "./src/button.tsx" },
    dependency: "^1.0.0",
    button: BUTTON,
    action: "review-state",
  },
  {
    name: "declaration-only export",
    exports: { "./button": "./src/button.d.ts" },
    dependency: "workspace:*",
    button: BUTTON,
    action: "review-state",
  },
  {
    name: "eager workspace wrapper",
    exports: { "./button": "./src/button.tsx" },
    dependency: "workspace:*",
    button: BUTTON.replace("return useRender", "props.onClick(); return useRender"),
    action: "review-state",
  },
  {
    name: "barrel export",
    exports: { "./button": "./src/index.ts" },
    dependency: "workspace:*",
    button: BUTTON,
    action: "use-observable",
    extraFiles: [["packages/ui/src/index.ts", 'export { Button } from "./button";']],
  },
  {
    name: "cyclic barrel",
    exports: { "./button": "./src/index.ts" },
    dependency: "workspace:*",
    button: BUTTON,
    action: "use-observable",
    extraFiles: [
      ["packages/ui/src/index.ts", 'export * from "./cycle"; export { Button } from "./button";'],
      ["packages/ui/src/cycle.ts", 'export * from "./index";'],
    ],
  },
  {
    name: "types condition wins",
    exports: { "./button": { types: "./src/button.d.ts", default: "./src/button.tsx" } },
    dependency: "workspace:*",
    button: BUTTON,
    action: "review-state",
  },
  {
    name: "null export",
    exports: { "./button": null },
    dependency: "workspace:*",
    button: BUTTON,
    action: "review-state",
  },
  {
    name: "duplicate package identity",
    exports: { "./button": "./src/button.tsx" },
    dependency: "workspace:*",
    button: BUTTON,
    action: "review-state",
    extraFiles: [
      [
        "packages/duplicate/package.json",
        '{"name":"@fixture/ui","exports":{"./button":"./button.tsx"}}',
      ],
      ["packages/duplicate/button.tsx", BUTTON],
    ],
  },
  {
    name: "undeclared dependency",
    exports: { "./button": "./src/button.tsx" },
    dependency: "",
    button: BUTTON,
    action: "review-state",
  },
  {
    name: "existing installed dependency",
    exports: { "./button": "./src/button.tsx" },
    dependency: "workspace:*",
    button: BUTTON,
    action: "review-state",
    extraFiles: [
      [
        "node_modules/@fixture/ui/package.json",
        '{"name":"@fixture/ui","exports":{"./button":"./button.tsx"}}',
      ],
      [
        "node_modules/@fixture/ui/button.tsx",
        BUTTON.replace("return useRender", "props.onClick(); return useRender"),
      ],
    ],
  },
  {
    name: "NodeNext ESM condition",
    exports: { "./button": { import: "./src/button.tsx", require: "./src/eager.tsx" } },
    dependency: "workspace:*",
    button: BUTTON,
    action: "use-observable",
    extraFiles: [
      [
        "apps/web/package.json",
        '{"name":"@fixture/web","type":"module","dependencies":{"@fixture/ui":"workspace:*"}}',
      ],
      [
        "apps/web/tsconfig.json",
        '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"}}',
      ],
      [
        "packages/ui/src/eager.tsx",
        BUTTON.replace("return useRender", "props.onClick(); return useRender"),
      ],
    ],
  },
  {
    name: "NodeNext ESM eager condition",
    exports: { "./button": { import: "./src/eager.tsx", require: "./src/button.tsx" } },
    dependency: "workspace:*",
    button: BUTTON,
    action: "review-state",
    extraFiles: [
      [
        "apps/web/package.json",
        '{"name":"@fixture/web","type":"module","dependencies":{"@fixture/ui":"workspace:*"}}',
      ],
      [
        "apps/web/tsconfig.json",
        '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"}}',
      ],
      [
        "packages/ui/src/eager.tsx",
        BUTTON.replace("return useRender", "props.onClick(); return useRender"),
      ],
    ],
  },
  {
    name: "installed workspace symlink",
    exports: { "./button": "./src/button.tsx" },
    dependency: "workspace:*",
    button: BUTTON,
    action: "use-observable",
    extraLinks: [["apps/web/node_modules/@fixture/ui", "packages/ui"]],
  },
  {
    name: "malformed implementation",
    exports: { "./button": "./src/button.tsx" },
    dependency: "workspace:*",
    button: `${BUTTON}\nconst broken = (`,
    action: "review-state",
  },
] as const;

for (const scenario of CASES) {
  test(`workspace callback proof: ${scenario.name}`, async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-workspace-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const extraFiles: readonly (readonly [string, string])[] = [];
    const extraLinks: readonly (readonly [string, string])[] = [];
    const variant = { extraFiles, extraLinks, ...scenario };
    const files = new Map([
      ["package.json", JSON.stringify({ name: "fixture", private: true })],
      ["pnpm-workspace.yaml", "packages:\n  - apps/*\n  - packages/*\n"],
      [
        "apps/web/package.json",
        JSON.stringify({
          name: "@fixture/web",
          dependencies: { "@fixture/ui": scenario.dependency },
        }),
      ],
      ["apps/web/src/Screen.tsx", SCREEN],
      [
        "packages/ui/package.json",
        JSON.stringify({ name: "@fixture/ui", exports: scenario.exports }),
      ],
      ["packages/ui/src/button.tsx", scenario.button],
      ["packages/ui/src/button.d.ts", "export declare function Button(props: any): any;"],
      [
        "packages/ui/src/unrelated.tsx",
        "export function Unrelated() { const [x, setX] = useState(0); return <p>{x}</p>; }",
      ],
    ]);
    for (const [file, source] of variant.extraFiles) {
      files.set(file, source);
    }
    for (const [file, source] of files) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), source);
    }
    for (const [link, destination] of variant.extraLinks) {
      await mkdir(path.dirname(path.join(root, link)), { recursive: true });
      await symlink(path.join(root, destination), path.join(root, link), "dir");
    }
    const target = path.join(root, "apps/web/src");
    const sharedContext = await createAnalysisContext(target);
    assert.ok(
      sharedContext.project.files.every((file) => !file.identityPath.endsWith(".d.ts")),
      "declarations cannot enter implementation proofs",
    );
    const detailed = await analyzePathDetailed(target, { sharedContext });
    const { report } = detailed;
    const unavailable = detailed.coverage.sourceContext
      ?.find((entry) => entry.file === "Screen.tsx")
      ?.unavailable.filter((edge) => edge.specifier === "@fixture/ui/button");
    const expectedReason = new Map([
      ["private source", "module-unresolved"],
      ["registry version", "module-unresolved"],
      ["declaration-only export", "declaration-only"],
      ["types condition wins", "declaration-only"],
      ["null export", "module-unresolved"],
      ["duplicate package identity", "module-unresolved"],
      ["undeclared dependency", "module-unresolved"],
      ["existing installed dependency", "source-not-indexed"],
      ["malformed implementation", "source-not-indexed"],
    ]).get(scenario.name);
    assert.deepEqual(
      unavailable?.map((edge) => edge.reason),
      expectedReason ? [expectedReason] : [],
    );
    assert.equal(report.findings.length, 1, "dependency files must not become scan targets");
    assert.equal(report.findings[0]?.action, scenario.action);
  });
}
