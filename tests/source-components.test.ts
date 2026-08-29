import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildSourceIndex } from "../src/source-components.js";

async function withProject(
  files: Readonly<Record<string, string>>,
  run: (root: string, sources: ReadonlyMap<string, string>) => void | Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-components-"));
  try {
    const sources = new Map<string, string>();
    for (const [relative, source] of Object.entries(files)) {
      const file = path.join(root, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, source, "utf8");
      sources.set(file, source);
    }
    await run(root, sources);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("resolves named, default, and barrel-exported source components", async () => {
  await withProject(
    {
      "feature/DefaultLeaf.tsx": "export default function () { return <div />; }",
      "feature/NamedLeaf.tsx": "export function NamedLeaf() { return <div />; }",
      "feature/index.ts": 'export { NamedLeaf } from "./NamedLeaf"; export { default as DefaultLeaf } from "./DefaultLeaf";',
      "screen.tsx": 'import { DefaultLeaf, NamedLeaf } from "./feature"; export function Screen() { return <><DefaultLeaf /><NamedLeaf /></>; }',
    },
    (root, sources) => {
      const components = buildSourceIndex(root, sources).componentsFor(path.join(root, "screen.tsx"));
      assert.deepEqual([...components].sort(), ["DefaultLeaf", "NamedLeaf"]);
    }
  );
});

test("resolves only source-proven pure projection wrappers", async () => {
  await withProject(
    {
      "projection.ts": `
        import { clsx as merge } from "clsx";
        import { twMerge } from "tailwind-merge";
        const normalize = (value: unknown) => String(value);
        export function cx(...values: unknown[]) { return twMerge(merge(values)); }
        export function noisy(value: unknown) { console.log(value); return merge(value); }
        export function defaulted(value = "") { return merge(value); }
        export function shadowed(merge: (value: unknown) => string, value: unknown) { return merge(value); }
        export function unknown(value: unknown) { return normalize(value); }
      `,
      "index.ts": 'export { cx as classNames, noisy, defaulted, shadowed, unknown } from "./projection";',
      "screen.tsx": 'import { classNames, noisy, defaulted, shadowed, unknown } from "./index";',
    },
    (root, sources) => {
      const projections = buildSourceIndex(root, sources)
        .pureProjectionsFor(path.join(root, "screen.tsx"));
      assert.deepEqual([...projections], ["classNames"]);
    }
  );
});

test("indexes shared UI components as provenance without deciding leaf safety", async () => {
  await withProject(
    {
      "components/ui/calendar.tsx": "export function Calendar() { return <div />; }",
      "components/ui/dropdown-menu.tsx": "export function DropdownMenu() { return <div />; }",
      "screen.tsx": 'import { Calendar } from "./components/ui/calendar"; import { DropdownMenu } from "./components/ui/dropdown-menu"; export function Screen() { return <><Calendar /><DropdownMenu /></>; }',
    },
    (root, sources) => {
      const components = buildSourceIndex(root, sources).componentsFor(path.join(root, "screen.tsx"));
      assert.deepEqual([...components].sort(), ["Calendar", "DropdownMenu"]);
    }
  );
});

test("resolves each import with its nearest application tsconfig", async () => {
  await withProject(
    {
      "tsconfig.json": '{"compilerOptions":{"moduleResolution":"Bundler"}}',
      "apps/web/tsconfig.json": '{"compilerOptions":{"moduleResolution":"Bundler","baseUrl":".","paths":{"@/*":["src/*"]}}}',
      "apps/web/src/Leaf.tsx": 'export function Leaf({ open }: { open: boolean }) { return open ? <aside /> : null; }',
      "apps/web/src/Panel.tsx": 'export function Panel() { return <main />; }',
      "apps/web/src/Screen.tsx": 'import { Leaf } from "@/Leaf"; import { Panel } from "@/Panel"; export function Screen() { return <><Leaf open={false} /><Panel /></>; }',
      "apps/native/tsconfig.json": '{"compilerOptions":{"moduleResolution":"Bundler","baseUrl":".","paths":{"@/*":["src/*"]}}}',
      "apps/native/src/Row.tsx": 'export function Row() { return <span />; }',
      "apps/native/src/Screen.tsx": 'import { Row } from "@/Row"; export function Screen() { return <Row />; }',
    },
    (root, sources) => {
      const index = buildSourceIndex(root, sources);
      assert.deepEqual(
        [...index.componentsFor(path.join(root, "apps/web/src/Screen.tsx"))].sort(),
        ["Leaf", "Panel"]
      );
      assert.deepEqual(
        [...index.componentsFor(path.join(root, "apps/native/src/Screen.tsx"))],
        ["Row"]
      );
    }
  );
});

test("resolves package imports when an extended config is unavailable", async () => {
  await withProject(
    {
      "package.json": JSON.stringify({
        imports: { "#app/*": "./src/*" },
        name: "fixture-app",
        type: "module",
      }),
      "tsconfig.json": '{"extends":"@fixture/tsconfig/vite.json","include":["src"]}',
      "src/state.ts": `
        import { observable } from "@legendapp/state";
        export const state$ = observable({ ready: false, message: "" });
      `,
      "src/screen.ts": 'import { state$ as appState$ } from "#app/state.ts";',
    },
    (root, sources) => {
      const index = buildSourceIndex(root, sources);
      const screen = path.join(root, "src/screen.ts");
      const observables = index.observablesFor(screen);
      assert.deepEqual([...observables], ["appState$"]);
      assert.deepEqual([...index.observableKeysFor(screen).get("appState$") ?? []], ["ready", "message"]);
    }
  );
});

test("resolves exported Legend observables through aliases and barrels", async () => {
  await withProject(
    {
      "state/player.ts": `
        import { observable as createObservable } from "@legendapp/state";
        export const player$ = createObservable({ loading: false, error: null });
        export const map$ = new Map();
      `,
      "state/index.ts": 'export { player$ as playback$ } from "./player";',
      "screen.ts": 'import { playback$ as audio$ } from "./state";',
    },
    (root, sources) => {
      const observables = buildSourceIndex(root, sources)
        .observablesFor(path.join(root, "screen.ts"));
      assert.deepEqual([...observables], ["audio$"]);
    }
  );
});

test("resolves only source-proven observable members from local wrapper factories", async () => {
  await withProject(
    {
      "state/controllers.ts": `
        import { observable as createObservable } from "@legendapp/state";

        function createController() {
          return {
            value$: createObservable({ profile: { name: "Ada" } }),
            set: (value: unknown) => value,
          };
        }

        function conditionalController(flag: boolean) {
          if (flag) return { value$: createObservable({ name: "Ada" }) };
          return { value$: createObservable({ name: "Grace" }) };
        }

        function spreadController() {
          return { ...createController(), extra$: createObservable(1) };
        }

        function reassignedController() {
          return { value$: createObservable({ name: "Ada" }) };
        }

        declare function unknownController(): { value$: unknown };
        reassignedController = unknownController;

        export const controller = createController();
        export const conditional = conditionalController(true);
        export const reassigned = reassignedController();
        export const spread = spreadController();
        export const unknown = unknownController();
        export const namedOnly = { value$: { profile: { name: "Lin" } } };
      `,
      "state/index.ts": `
        export {
          conditional,
          controller as dialog,
          namedOnly,
          reassigned,
          spread,
          unknown,
        } from "./controllers";
      `,
      "screen.ts": 'import { conditional, dialog, namedOnly, reassigned, spread, unknown } from "./state";',
    },
    (root, sources) => {
      const paths = buildSourceIndex(root, sources)
        .observablePathsFor(path.join(root, "screen.ts"));
      assert.deepEqual([...paths], ["dialog.value$"]);
    }
  );
});

test("rejects observable controller members replaced through another source file", async () => {
  await withProject(
    {
      "state.ts": `
        import { observable } from "@legendapp/state";
        function createController() {
          return { value$: observable({ name: "Ada" }), set: () => undefined };
        }
        export const controller = createController();
      `,
      "mutator.ts": `
        import { controller as dialog } from "./state";
        dialog.value$ = { name: "not observable" } as never;
      `,
      "screen.ts": 'import { controller as dialog } from "./state";',
    },
    (root, sources) => {
      const paths = buildSourceIndex(root, sources)
        .observablePathsFor(path.join(root, "screen.ts"));
      assert.deepEqual([...paths], []);
    }
  );
});

test("resolves observables created by explicitly typed project factories", async () => {
  await withProject(
    {
      "create-store.ts": `
        import { observable, type Observable as LegendObservable } from "@legendapp/state";
        export function createStore<T>(value: T): LegendObservable<T> {
          return observable(value);
        }
      `,
      "theme.ts": `
        import { createStore as makeStore } from "./create-store";
        export const theme$ = makeStore({ accent: "blue" });
      `,
      "screen.ts": 'import { theme$ as appTheme$ } from "./theme";',
    },
    (root, sources) => {
      const index = buildSourceIndex(root, sources);
      const factories = index.observableFactoriesFor(path.join(root, "theme.ts"));
      const observables = index
        .observablesFor(path.join(root, "screen.ts"));
      assert.deepEqual([...factories], ["makeStore"]);
      assert.deepEqual([...observables], ["appTheme$"]);
    }
  );
});

test("does not expose untyped project helpers as observable factories", async () => {
  await withProject(
    {
      "create-store.ts": "export function createStore<T>(value: T): T { return value; }",
      "screen.ts": 'import { createStore as makeStore } from "./create-store";',
    },
    (root, sources) => {
      const factories = buildSourceIndex(root, sources)
        .observableFactoriesFor(path.join(root, "screen.ts"));
      assert.deepEqual([...factories], []);
    }
  );
});

test("does not infer exported observables from names or unrelated factories", async () => {
  await withProject(
    {
      "state.ts": `
        const observable = makeStore;
        export const fake$ = observable({ first: "", second: "" });
        export const map$ = new Map();
      `,
      "screen.ts": 'import { fake$, map$ } from "./state";',
    },
    (root, sources) => {
      const observables = buildSourceIndex(root, sources)
        .observablesFor(path.join(root, "screen.ts"));
      assert.deepEqual([...observables], []);
    }
  );
});

test("proves plain styled() hosts of framework event package components", async () => {
  await withProject(
    {
      "Switch.tsx": `
        import * as RadixSwitch from "@radix-ui/react-switch";
        import styled from "styled-components";
        export const StyledRoot = styled(RadixSwitch.Root)<{ width?: number }>\`position: relative;\`;
        const LocalRoot = styled(RadixSwitch.Root)\`padding: 0;\`;
        export function Switch() { return <LocalRoot />; }
      `,
      "screen.tsx": 'import { StyledRoot } from "./Switch"; export function Screen() { return <StyledRoot />; }',
    },
    (root, sources) => {
      const index = buildSourceIndex(root, sources);
      assert.equal(index.frameworkEventComponentFor(path.join(root, "Switch.tsx"), "LocalRoot"), true);
      assert.equal(index.frameworkEventComponentFor(path.join(root, "screen.tsx"), "StyledRoot"), true);
    }
  );
});

test("rejects styled hosts without plain factory, const binding, and proven target provenance", async () => {
  await withProject(
    {
      "hosts.tsx": `
        import * as RadixSwitch from "@radix-ui/react-switch";
        import * as SomeUi from "some-ui";
        import styled from "styled-components";
        import fancy from "styled-components-lite";
        function LocalThing() { return <button />; }
        export const Configured = styled(RadixSwitch.Root).attrs({ type: "button" })\`padding: 0;\`;
        export const Narrowed = styled(RadixSwitch.Root).withConfig({ displayName: "N" })\`padding: 0;\`;
        export const Lookalike = fancy(RadixSwitch.Root)\`padding: 0;\`;
        export const Unproven = styled(SomeUi.Root)\`padding: 0;\`;
        export const LocalTarget = styled(LocalThing)\`padding: 0;\`;
        export const Intrinsic = styled.button\`padding: 0;\`;
        export let Mutable = styled(RadixSwitch.Root)\`padding: 0;\`;
      `,
      "shadowed.tsx": `
        import * as RadixSwitch from "@radix-ui/react-switch";
        import styled from "styled-components";
        export const Shadowed = styled(RadixSwitch.Root)\`padding: 0;\`;
        function rebind(styled: (target: unknown) => (parts: TemplateStringsArray) => unknown) {
          return styled(RadixSwitch.Root);
        }
        export const other = rebind(() => () => null);
      `,
    },
    (root, sources) => {
      const index = buildSourceIndex(root, sources);
      const file = path.join(root, "hosts.tsx");
      for (const name of ["Configured", "Narrowed", "Lookalike", "Unproven", "LocalTarget", "Intrinsic", "Mutable"]) {
        assert.equal(index.frameworkEventComponentFor(file, name), false, name);
      }
      assert.equal(
        index.frameworkEventComponentFor(path.join(root, "shadowed.tsx"), "Shadowed"),
        false,
        "Shadowed"
      );
    }
  );
});
