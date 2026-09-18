import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const imports = `import { observable, type Observable } from "@legendapp/state";
import { useValue, useValue as read, useObservable } from "@legendapp/state/react";
const open$ = observable(false);`;
const body = `const open = useValue(open$);
const raw = READ(state$.number);
const alias = raw ?? 0;
return <main><A/><B/><C/><D/><E/><F/><G/><H/><I/><J/><K/>
  <aside>{String(alias)}</aside><output>{open}</output></main>;`;
const receiverType = "{ state$: Observable<{ number: { toString(): string } }> }";

const unsafeSources = {
  "destructured owner receiver": `${imports}
const state$ = observable({ number: 1 });
export function Screen({ state$ }: ${receiverType}) { ${body.replace("READ", "useValue")} }`,
  "destructured enclosing receiver": `${imports}
const state$ = observable({ number: 1 });
export function makeScreen({ state$ }: ${receiverType}) {
  return function Screen() { ${body.replace("READ", "useValue")} };
}`,
  "reassignable receiver": `${imports}
let state$ = observable({ number: 1 });
export function replace(next) { state$ = next; }
export function Screen() { ${body.replace("READ", "useValue")} }`,
  "enclosing imported-hook alias shadow": `${imports}
const state$ = observable({ number: 1 });
export function makeScreen({ read }) {
  return function Screen() { ${body.replace("READ", "read")} };
}`,
  "enclosing observable-factory shadow": `${imports}
export function makeScreen({ observable }) {
  const state$ = observable<{number:number}>({number:1});
  return function Screen() { ${body.replace("READ", "useValue")} };
}`,
};

for (const [name, source] of Object.entries(unsafeSources)) {
  test(`primitive subscription evidence does not cross ${name}`, async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "legend-independent-receiver-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "Screen.tsx"), source);
    const report = await analyzePath(root);
    assert.equal(
      report.practices.some(
        (finding) =>
          finding.action === "move-use-value-down" && finding.subscription?.binding === "open",
      ),
      false,
      "String(alias) may invoke an object's effectful toString on the owner's update",
    );
  });
}

for (const local of [false, true]) {
  test(`a unique const ${local ? "owner" : "module"} receiver retains primitive coercion proof`, async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "legend-independent-const-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const receiver = `const state$ = ${local ? "useObservable" : "observable"}({ number: 1 });`;
    await writeFile(
      path.join(root, "Screen.tsx"),
      `${imports}
${local ? "" : receiver}
export function Screen() { ${local ? receiver : ""} ${body.replace("READ", "read")} }`,
    );
    const report = await analyzePath(root);
    assert.ok(
      report.practices.some(
        (finding) =>
          finding.action === "move-use-value-down" && finding.subscription?.binding === "open",
      ),
    );
  });
}
