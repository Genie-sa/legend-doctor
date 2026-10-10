import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../src/project/analyze-path/analyze-path.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const PREVIEW_CUT = /subscribe only in the sibling <section> boundary/u;

function picker(prelude: string, className: string): string {
  return `
    import { useState } from "react";
    ${prelude}
    export function Picker() {
      const [active, setActive] = useState<string | null>(null);
      return <main>
        <Grid onActive={(item: string) => setActive(item)} />
        <section className={${className}}><h2>Preview</h2><p>Body</p></section>
        <Footer /><Help /><Status /><Aside /><Toolbar /><Legend />
      </main>;
    }
  `;
}

function activeMessage(source: string): string {
  const finding = analyzeSource(source, "fixture.tsx").find((entry) => entry.name === "active");
  return finding?.message ?? "";
}

test("cuts a sibling consumer only through class-name calls proven pure by their binding", () => {
  const proven = {
    clsxImport: picker('import { clsx as cn } from "clsx";', 'cn("preview", active && "open")'),
    twMergeImport: picker(
      'import { twMerge } from "tailwind-merge";',
      'twMerge("preview", active && "open")',
    ),
    variantBuilder: picker(
      'import { cva } from "class-variance-authority";\nconst preview = cva("preview", { variants: { open: { true: "open" } } });',
      "preview({ open: active !== null })",
    ),
    localWrapper: picker(
      'import { clsx, type ClassValue } from "clsx";\nimport { twMerge } from "tailwind-merge";\nfunction cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }',
      'cn("preview", active && "open")',
    ),
    styleSheetMember: picker(
      'import { StyleSheet } from "react-native-unistyles";\nconst styles = StyleSheet.create((theme) => ({ row: (open: boolean) => (open ? theme.open : theme.closed) }));',
      "styles.row(active !== null)",
    ),
    styleSheetThemeCall: picker(
      'import { StyleSheet } from "react-native-unistyles";\nconst styles = StyleSheet.create((theme) => ({ row: (open: boolean) => ({ width: theme.sizing.scale(open ? 2 : 1) }) }));',
      "styles.row(active !== null)",
    ),
  } satisfies Record<string, string>;
  for (const [name, fixture] of Object.entries(proven)) {
    assert.match(activeMessage(fixture), PREVIEW_CUT, name);
  }
  const unproven = {
    impureLocalCn: picker(
      'let calls = 0;\nfunction cn(...inputs: (string | false)[]) { calls += 1; return inputs.join(" "); }',
      'cn("preview", active !== null && "open")',
    ),
    unboundCn: picker("", 'cn("preview", active && "open")'),
    objectStyles: picker(
      'let reads = 0;\nconst styles = { get hits() { reads += 1; return reads; }, row: (open: boolean) => (open ? "open" : "closed") };',
      "styles.row(active !== null)",
    ),
    impureStyleSheetMember: picker(
      'import { StyleSheet } from "react-native-unistyles";\nconst styles = StyleSheet.create({ row: (open: boolean) => (track(open) ? "open" : "closed") });',
      "styles.row(active !== null)",
    ),
  } satisfies Record<string, string>;
  for (const [name, fixture] of Object.entries(unproven)) {
    assert.doesNotMatch(activeMessage(fixture), PREVIEW_CUT, name);
  }
});

test("cuts a sibling consumer through a class-name wrapper imported from the same repository", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-class-name-wrapper-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "utils.ts"),
    `
      import { clsx, type ClassValue } from "clsx";
      import { twMerge } from "tailwind-merge";
      export function cn(...inputs: ClassValue[]) {
        return twMerge(clsx(inputs));
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "Picker.tsx"),
    picker('import { cn } from "./utils";', 'cn("preview", active && "open")'),
    "utf8",
  );
  const report = await analyzePath(root);
  const finding = report.findings.find((entry) => entry.name === "active");
  assert.match(finding?.message ?? "", PREVIEW_CUT);
});
