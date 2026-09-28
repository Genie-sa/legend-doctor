import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("proves untracked render reads through imported observables, leaving reactive inputs alone", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-observable-tracking-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "store.ts"),
    `
      import { observable } from "@legendapp/state";
      export const state$ = observable({ ready: false, count: 0 });
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "screen.tsx"),
    `
      import { Show, observer } from "@legendapp/state/react";
      import { state$ } from "./store";
      export function Screen() {
        const count = state$.count.get();
        return <Show if={state$.ready.get()}>{() => <b>{count}</b>}</Show>;
      }
      export const Tracked = observer(function Tracked() {
        return <b>{state$.count.get()}</b>;
      });
    `,
    "utf8",
  );

  const report = await analyzePath(root);

  assert.deepEqual(
    report.practices.map((practice) => [
      practice.location.file,
      practice.location.line,
      practice.action,
    ]),
    [["screen.tsx", 5, "use-value-for-render-read"]],
  );
  assert.deepEqual(report.capabilities.disabledRules, []);
});

const SETTINGS_STORE = `
  import { observable } from "@legendapp/state";
  export const settings$ = observable({ lang: "en", theme: { dark: false } });
  export const other$ = observable("x");
`;

const SETTINGS_SCREEN = `
  import { settings$ } from "./store";
  import { useT } from "./hooks";
  export function Screen() {
    useT();
    return <p>{settings$.lang.get()}{settings$.theme.dark.get() ? "dark" : "light"}</p>;
  }
`;

function settingsHooks(hookBody: string): string {
  return `
    import { use$ } from "@legendapp/state/react";
    import { other$, settings$ } from "./store";
    export function useSettings() {
      ${hookBody}
    }
    export function useT() {
      return useSettings();
    }
  `;
}

async function screenRenderReadLines(hookBody: string): Promise<number[]> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-hook-coverage-"));
  try {
    await writeFile(path.join(root, "store.ts"), SETTINGS_STORE, "utf8");
    await writeFile(path.join(root, "hooks.ts"), settingsHooks(hookBody), "utf8");
    await writeFile(path.join(root, "screen.tsx"), SETTINGS_SCREEN, "utf8");
    const report = await analyzePath(root);
    return report.practices
      .filter((practice) => practice.action === "use-value-for-render-read")
      .map((practice) => practice.location.line);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("treats a render read as fresh when a custom hook the owner calls subscribes to its path", async () => {
  assert.deepEqual(await screenRenderReadLines("return use$(settings$);"), []);
  assert.deepEqual(await screenRenderReadLines("return use$(settings$.lang);"), [6]);
  assert.deepEqual(await screenRenderReadLines("return use$(other$);"), [6, 6]);
  assert.deepEqual(await screenRenderReadLines("return () => use$(settings$);"), [6, 6]);
});
