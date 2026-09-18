import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const safeCaller = "export function App() { return <Screen options={{active: true}}/>; }";
const callers = [
  ["fresh literal", safeCaller, true],
  ["absent optional prop", "export function App() { return <Screen/>; }", true],
  [
    "getter in literal",
    "export function App() { return <Screen options={{get active(){return read()}}}/>; }",
    false,
  ],
  [
    "unknown spread",
    "export function App() { return <Screen options={{active:true}} {...other}/>; }",
    false,
  ],
  [
    "overridden prop",
    "export function App() { return <Screen options={{active:true}} options={unknown}/>; }",
    false,
  ],
  [
    "object alias",
    "const options={active:true}; export function App() { return <Screen options={options}/>; }",
    false,
  ],
  [
    "second unsafe site",
    `${safeCaller} export function Other({options}){return <Screen options={options}/>;}`,
    false,
  ],
  [
    "component shadow",
    "export function App({Screen}) { return <Screen options={{active:true}}/>; }",
    false,
  ],
  ["escaped component alias", `${safeCaller} export const Escaped=Screen;`, false],
  ["namespace transport", `import * as All from "./Screen"; ${safeCaller}`, false],
  ["reexport transport", `export {Screen as PublicScreen} from "./Screen"; ${safeCaller}`, false],
  ["dynamic transport", `import("./Screen").then(register); ${safeCaller}`, false],
  ["unresolved dynamic transport", `import(target).then(register); ${safeCaller}`, false],
] as const;

for (const [name, caller, expected] of callers) {
  test(`nested class prop requires complete data callers: ${name}`, async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "legend-prop-data-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(
      path.join(root, "projection.ts"),
      'import {clsx} from "clsx"; import {twMerge} from "tailwind-merge"; export function combine(...values: unknown[]) {return twMerge(clsx(values));}',
    );
    await writeFile(path.join(root, "Screen.tsx"), screen());
    await writeFile(path.join(root, "App.tsx"), `import {Screen} from "./Screen"; ${caller}`);
    const report = await analyzePath(root);
    assert.equal(
      report.practices.some((finding) => finding.action === "move-use-value-down"),
      expected,
    );
  });
}

for (const [name, setup] of [
  ["object escapes to a mutator", "register(options);"],
  ["object property is mutated", "if(options) options.active = flip();"],
  ["prop binding is shadowed", "{ const options = unknown; consume(options); }"],
] as const) {
  test(`known literal callers cannot authorize ${name}`, async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "legend-prop-escape-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(
      path.join(root, "projection.ts"),
      'import {clsx} from "clsx"; import {twMerge} from "tailwind-merge"; export function combine(...values: unknown[]) {return twMerge(clsx(values));}',
    );
    await writeFile(path.join(root, "Screen.tsx"), screen(setup));
    await writeFile(path.join(root, "App.tsx"), `import {Screen} from "./Screen"; ${safeCaller}`);
    const report = await analyzePath(root);
    assert.equal(
      report.practices.some((finding) => finding.action === "move-use-value-down"),
      false,
    );
  });
}

function screen(setup = ""): string {
  return `import {observable} from "@legendapp/state";
    import {useValue} from "@legendapp/state/react";
    import {combine} from "./projection";
    const state$=observable({open:false});
    export function Screen({options} = {}) {
      const open=useValue(state$.open); ${setup}
      const active=options?.active ?? false;
      return <main><A/><B/><C/><D/><E/><F/><G/><H/><I/><J/><K/>
        <aside className={combine("base", active && "active")}/><output>{open}</output></main>;
    }`;
}

for (const [name, child, expected] of [
  ["ignored child prop", "function Child({options: ignored}) { return <i/>; }", true],
  [
    "duplicate child prop aliases",
    "function Child({options: ignored, options: used}) { Object.defineProperty(used, 'active', {get: read}); return <i/>; }",
    false,
  ],
  [
    "child rest escape",
    "function Child({options: ignored, ...rest}) { register(rest); return <i/>; }",
    false,
  ],
] as const) {
  test(`nested data forwarding: ${name}`, async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "legend-forward-prop-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(
      path.join(root, "projection.ts"),
      'import {clsx} from "clsx"; import {twMerge} from "tailwind-merge"; export function combine(...values: unknown[]) {return twMerge(clsx(values));}',
    );
    await writeFile(
      path.join(root, "Screen.tsx"),
      screen()
        .replace("<A/>", "<Child options={options}/>")
        .replace("export function Screen", "export function Screen") + child,
    );
    await writeFile(path.join(root, "App.tsx"), `import {Screen} from "./Screen"; ${safeCaller}`);
    const report = await analyzePath(root);
    assert.equal(
      report.practices.some((finding) => finding.action === "move-use-value-down"),
      expected,
    );
  });
}

for (const [name, transform] of [
  [
    "owner parameter default",
    (source: string): string =>
      source.replace(
        "{options} = {}",
        "{options, ignored=Object.defineProperty(options, 'active', {get: read})} = {}",
      ),
  ],
  [
    "child parameter default",
    (source: string): string =>
      `${source.replace(
        "<A/>",
        "<Child options={options}/>",
      )}function Child({options, ignored=Object.defineProperty(options,'active',{get:read})}){return <i/>;}`,
  ],
  [
    "enclosing wrapper shadow",
    (source: string): string =>
      `${source.replace(
        "export function Screen",
        "function factory(combine) { return function Screen",
      )}}`,
  ],
] as const) {
  test(`class evaluation rejects ${name}`, async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "legend-default-prop-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(
      path.join(root, "projection.ts"),
      'import {clsx} from "clsx"; import {twMerge} from "tailwind-merge"; export function combine(...values: unknown[]) {return twMerge(clsx(values));}',
    );
    await writeFile(path.join(root, "Screen.tsx"), transform(screen()));
    await writeFile(path.join(root, "App.tsx"), `import {Screen} from "./Screen"; ${safeCaller}`);
    const report = await analyzePath(root);
    assert.equal(
      report.practices.some((finding) => finding.action === "move-use-value-down"),
      false,
    );
  });
}
