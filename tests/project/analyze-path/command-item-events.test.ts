import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import { buildSourceIndex } from "../../../src/project/source-components/source-components.js";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

interface Scenario {
  name: string;
  importSource: string;
  action: "use-observable" | "review-state";
  before?: string;
  shadow?: string;
  prop?: string;
  member?: string;
  version?: string;
  terminalPrefix?: string;
  terminalAfter?: string;
  pickerAttributes?: string;
  alias?: boolean;
  installedVersion?: string;
  rootImport?: string;
  remoteMutation?: boolean;
  remoteDynamicMutation?: boolean;
  commandBefore?: string;
  commandAfter?: string;
}

const cases: readonly Scenario[] = [
  { name: "source-forwarded item selection", importSource: "cmdk", action: "use-observable" },
  { name: "same-named local library", importSource: "./lookalike", action: "review-state" },
  {
    name: "eager wrapper",
    importSource: "cmdk",
    before: "onSelect('eager');",
    action: "review-state",
  },
  {
    name: "unknown callback timing",
    importSource: "cmdk",
    before: "schedule(onSelect);",
    action: "review-state",
  },
  { name: "shadowed import", importSource: "cmdk", shadow: ", Palette", action: "review-state" },
  {
    name: "unproven item callback",
    importSource: "cmdk",
    prop: "onInspect",
    action: "review-state",
  },
  {
    name: "unknown export",
    importSource: "cmdk",
    rootImport: "CommandRoot as Palette",
    action: "review-state",
  },
  {
    name: "type-only import",
    importSource: "cmdk",
    rootImport: "type Command as Palette",
    action: "review-state",
  },
  { name: "missing package pin", importSource: "cmdk", version: "", action: "review-state" },
  {
    name: "installed version agrees",
    importSource: "cmdk",
    installedVersion: "1.1.1",
    action: "use-observable",
  },
  {
    name: "unknown package version",
    importSource: "cmdk",
    version: "1.2.0",
    action: "review-state",
  },
  {
    name: "unpinned version range",
    importSource: "cmdk",
    version: "^1.1.1",
    action: "review-state",
  },
  {
    name: "overwritten imported member",
    importSource: "cmdk",
    terminalPrefix: "Palette.Item = eager;",
    action: "review-state",
  },
  {
    name: "package reexport escape",
    importSource: "cmdk",
    terminalPrefix: "export { Command as PublicCommand } from 'cmdk';",
    action: "review-state",
  },
  {
    name: "dynamic package import escape",
    importSource: "cmdk",
    terminalPrefix: "import('cmdk').then(module => { module.Command.Item = eager; });",
    action: "review-state",
  },
  {
    name: "unknown dynamic import argument",
    importSource: "cmdk",
    terminalPrefix:
      "const pkg = 'cmdk'; import(pkg).then(module => { module.Command.Item = eager; });",
    action: "review-state",
  },
  {
    name: "unknown require argument",
    importSource: "cmdk",
    terminalPrefix: "const pkg = 'cmdk'; require(pkg).Command.Item = eager;",
    action: "review-state",
  },
  {
    name: "unrelated literal dynamic import",
    importSource: "cmdk",
    terminalPrefix: "import('./analytics');",
    action: "use-observable",
  },
  {
    name: "template dynamic package import escape",
    importSource: "cmdk",
    terminalPrefix: "import(`cmdk`).then(module => { module.Command.Item = eager; });",
    action: "review-state",
  },
  {
    name: "template CommonJS package import escape",
    importSource: "cmdk",
    terminalPrefix: "require(`cmdk`).Command.Item = eager;",
    action: "review-state",
  },
  {
    name: "CommonJS package import escape",
    importSource: "cmdk",
    terminalPrefix: "require('cmdk').Command.Item = eager;",
    action: "review-state",
  },
  {
    name: "another module dynamically loads singleton",
    importSource: "cmdk",
    remoteDynamicMutation: true,
    action: "review-state",
  },
  {
    name: "another source module mutates singleton",
    importSource: "cmdk",
    remoteMutation: true,
    action: "review-state",
  },
  {
    name: "aliased export escapes to a mutator",
    importSource: "cmdk",
    terminalPrefix: "export { Palette as PublicCommand };",
    action: "review-state",
  },
  {
    name: "second named import mutates singleton",
    importSource: "cmdk",
    terminalPrefix: "import { Command as Other } from 'cmdk'; Other.Item = eager;",
    action: "review-state",
  },
  {
    name: "namespace import mutates singleton",
    importSource: "cmdk",
    terminalPrefix: "import * as Other from 'cmdk'; Other.Command.Item = eager;",
    action: "review-state",
  },
  {
    name: "escaped imported namespace",
    importSource: "cmdk",
    terminalPrefix: "mutate(Palette);",
    action: "review-state",
  },
  {
    name: "discarded spread selection",
    importSource: "cmdk",
    terminalAfter: "onSelect={() => {}}",
    action: "review-state",
  },
  {
    name: "later unknown spread",
    importSource: "cmdk",
    terminalAfter: "{...overrides}",
    action: "review-state",
  },
  {
    name: "polymorphic child",
    importSource: "cmdk",
    pickerAttributes: "asChild",
    action: "review-state",
  },
  {
    name: "explicit host selection",
    importSource: "cmdk",
    pickerAttributes: "asChild={false}",
    action: "use-observable",
  },
  {
    name: "path alias impersonating package",
    importSource: "cmdk",
    alias: true,
    action: "review-state",
  },
  {
    name: "installed version disagrees with pin",
    importSource: "cmdk",
    installedVersion: "1.2.0",
    action: "review-state",
  },
  {
    name: "companion write in start epoch",
    importSource: "cmdk",
    commandBefore: "setResult(1);",
    action: "use-observable",
  },
  {
    name: "companion write before await",
    importSource: "cmdk",
    commandAfter: "setResult(1);",
    action: "use-observable",
  },
  { name: "wrong command member", importSource: "cmdk", member: "Input", action: "review-state" },
];

for (const scenario of cases) {
  test(`pending command through ${scenario.name}`, async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-command-item-"));
    context.after(() => rm(root, { force: true, recursive: true }));
    const variant = scenario;
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { cmdk: scenario.version ?? "1.1.1" } }),
    );
    await writeDependencyControls(root, variant);
    await writeFile(
      path.join(root, "Item.tsx"),
      `
      import { ${variant.rootImport ?? "Command as Palette"} } from '${scenario.importSource}';
      ${variant.terminalPrefix ?? ""}
      export function Item({ className, ...props }) {
        return <Palette.${variant.member ?? "Item"} className={className} {...props} ${variant.terminalAfter ?? ""} />;
      }
      export function Picker({ onSelect${variant.shadow ?? ""} }) {
        ${variant.before ?? ""}
        return <Item ${variant.pickerAttributes ?? ""} ${variant.prop ?? "onSelect"}={value => onSelect(value)} />;
      }
    `,
    );
    // The shadow must be in the actual terminal wrapper's scope.
    if (variant.shadow) {
      await writeFile(
        path.join(root, "Item.tsx"),
        `
        import { Command as Palette } from 'cmdk';
        export function Picker({ onSelect, Palette }) {
          return <Palette.Item onSelect={value => onSelect(value)} />;
        }
      `,
      );
    }
    await writeFile(
      path.join(root, "Screen.tsx"),
      `
      import { useState } from 'react';
      import { Picker } from './Item';
      export function Screen() {
        const [pending, setPending] = useState(false);
        const [result, setResult] = useState(0);
        const run = async (value) => {
          ${variant.commandBefore ?? ""}
          setPending(true);
          ${variant.commandAfter ?? ""}
          try { await save(value); } finally { setPending(false); }
        };
        return <main>
          <output>{result}</output><Header/><Toolbar/><Summary/><Filters/><List/><Footer/><Aside/><Help/><Status/><Actions/><Preview/>
          <section>{pending ? <span>Saving</span> : <Picker onSelect={run}/>}</section>
        </main>;
      }
    `,
    );
    const report = await analyzePath(root);
    const finding = requireValue(report.findings.find((entry) => entry.name === "pending"));
    assert.equal(finding.action, scenario.action, finding.message);
    if (variant.commandBefore || variant.commandAfter) {
      assert.deepEqual(finding.group?.members.toSorted(), ["pending", "result"]);
      assert.match(finding.message, /preserve each synchronous transition with `batch`/u);
      assert.doesNotMatch(finding.message, /Replace async pending flag/u);
    }
    assert.equal(
      finding.disposition,
      scenario.action === "use-observable" ? "change" : "candidate",
    );
  });
}

async function writeDependencyControls(root: string, variant: Scenario): Promise<void> {
  if (variant.remoteDynamicMutation) {
    await writeFile(
      path.join(root, "Mutator.tsx"),
      "const pkg = 'cmdk'; import(pkg).then(module => { module.Command.Item = ({ onSelect }) => { onSelect('eager'); return null; }; });",
    );
  }
  if (variant.remoteMutation) {
    await writeFile(
      path.join(root, "Mutator.tsx"),
      "import { Command as Other } from 'cmdk'; Other.Item = ({ onSelect }) => { onSelect('eager'); return null; };",
    );
  }
  if (variant.terminalPrefix?.includes("PublicCommand")) {
    await writeFile(
      path.join(root, "Mutator.tsx"),
      "import { PublicCommand } from './Item'; PublicCommand.Item = ({ onSelect }) => { onSelect('eager'); return null; };",
    );
  }
  if (variant.alias) {
    await writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { cmdk: ["./lookalike.tsx"] } } }),
    );
    await writeFile(
      path.join(root, "lookalike.tsx"),
      "export const Command = { Item: ({onSelect}) => { onSelect(); return null; } };",
    );
  }
  if (variant.installedVersion) {
    const dependency = path.join(root, "node_modules/cmdk");
    await mkdir(dependency, { recursive: true });
    await writeFile(
      path.join(dependency, "package.json"),
      JSON.stringify({ name: "cmdk", version: variant.installedVersion, types: "index.d.ts" }),
    );
    await writeFile(path.join(dependency, "index.d.ts"), "export declare const Command: any;");
  }
}

test("malformed dependency metadata cannot establish an audited callback contract", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-command-metadata-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const file = path.join(root, "Item.tsx");
  await writeFile(path.join(root, "package.json"), '{"dependencies":{"cmdk":"1.1.1"}, broken}');
  const index = buildSourceIndex(
    root,
    new Map([[file, "import { Command } from 'cmdk'; export const Item = Command.Item;"]]),
  );
  assert.equal(index.callbackPackageVersionFor(file, "cmdk"), null);
});
