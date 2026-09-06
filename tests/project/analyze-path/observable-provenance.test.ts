import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import { createAnalysisContext } from "../../../src/project/analyze-path/analysis-context.js";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

test("uses cross-file observable provenance for batching findings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-observable-import-"));
  try {
    await mkdir(path.join(root, "state"), { recursive: true });
    await writeFile(
      path.join(root, "state", "player.ts"),
      `
        import { observable } from "@legendapp/state";
        export const player$ = observable({ loading: false, error: null as string | null });
      `,
      "utf8",
    );
    await writeFile(
      path.join(root, "screen.ts"),
      `
        import { player$ } from "./state/player";
        export function fail(message: string) {
          player$.error.set(message);
          player$.loading.set(false);
        }
      `,
      "utf8",
    );

    const report = await analyzePath(root);
    assert.equal(report.practices.length, 1);
    assert.equal(requireValue(report.practices[0]).action, "assign-observable-fields");
    assert.equal(requireValue(report.practices[0]).location.file, "screen.ts");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("uses typed project factory provenance for narrow leaf subscriptions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-observable-factory-"));
  try {
    await writeFile(
      path.join(root, "create-store.ts"),
      `
        import { observable, type Observable } from "@legendapp/state";
        export function createStore<T>(value: T): Observable<T> {
          return observable(value);
        }
      `,
      "utf8",
    );
    await writeFile(
      path.join(root, "screen.tsx"),
      `
        import { useValue } from "@legendapp/state/react";
        import { createStore } from "./create-store";
        const state$ = createStore({ profile: { name: "Ada", email: "ada@example.com" } });
        function Name(profile$: typeof state$.profile) {
          const profile = useValue(profile$);
          return <span>{profile.name}</span>;
        }
        export function Screen() { return <span>{Name(state$.profile)}</span>; }
      `,
      "utf8",
    );

    const report = await analyzePath(root);
    assert.deepEqual(
      report.practices.map((finding) => finding.action),
      ["narrow-use-value-subscription"],
    );
    assert.match(requireValue(report.practices[0]).message ?? "", /useValue\(profile\$\.name\)/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("uses cross-file observable provenance for direct useValue findings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-observable-read-"));
  try {
    await mkdir(path.join(root, "state"), { recursive: true });
    await writeFile(
      path.join(root, "state", "theme.ts"),
      `
        import { observable } from "@legendapp/state";
        export const theme$ = observable({ accent: "blue" });
      `,
      "utf8",
    );
    await writeFile(
      path.join(root, "screen.tsx"),
      `
        import { useValue as observe } from "@legendapp/state/react";
        import { theme$ } from "./state/theme";
        export function Screen() {
          return <span>{observe(() => theme$.accent.get())}</span>;
        }
      `,
      "utf8",
    );

    const report = await analyzePath(root);
    assert.equal(report.practices.length, 1);
    assert.equal(requireValue(report.practices[0]).action, "pass-observable-to-use-value");
    assert.equal(requireValue(report.practices[0]).location.file, "screen.tsx");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("uses peek only for a source-proven effect callback prop", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-effect-callback-read-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "state.ts"),
    `
      import { observable } from "@legendapp/state";
      export const state$ = observable({ ready: false, mixed: false, forwarded: false });
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "consumers.tsx"),
    `
      import { memo, useLayoutEffect } from "react";
      const typedMemo = memo as typeof memo;
      export const EffectConsumer = typedMemo(function EffectConsumer({ project }: { project: () => unknown }) {
        useLayoutEffect(() => { project(); }, [project]);
        return null;
      });
      export function MixedConsumer({ project }: { project: () => unknown }) {
        project();
        useLayoutEffect(() => { project(); }, [project]);
        return null;
      }
      export function ForwardedEffectConsumer({ project }: { project: () => unknown }) {
        useLayoutEffect(() => { subscribe(project); }, [project]);
        return null;
      }
      declare function subscribe(callback: () => unknown): void;
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "screen.tsx"),
    `
      import { EffectConsumer, ForwardedEffectConsumer, MixedConsumer } from "./consumers";
      import { state$ } from "./state";
      export function Screen() {
        return <>
          <EffectConsumer project={() => state$.ready.get()} />
          <MixedConsumer project={() => state$.mixed.get()} />
          <ForwardedEffectConsumer project={() => state$.forwarded.get()} />
        </>;
      }
    `,
    "utf8",
  );

  const report = await analyzePath(root);
  const findings = report.practices.filter((finding) => finding.action === "use-peek-for-snapshot");
  assert.equal(findings.length, 1);
  assert.match(requireValue(findings[0]).message ?? "", /state\$\.ready\.peek\(\)/u);
  assert.match(
    requireValue(findings[0]).evidence.join(" ") ?? "",
    /source-proven React effect callback/u,
  );
});

test("uses source-proven wrapper member provenance without treating the wrapper as observable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-observable-member-"));
  try {
    await mkdir(path.join(root, "state"), { recursive: true });
    await writeFile(
      path.join(root, "state", "controller.ts"),
      `
        import { observable } from "@legendapp/state";
        function createController() {
          return {
            value$: observable({ profile: { name: "Ada", email: "ada@example.com" } }),
            set: (value: unknown) => value,
          };
        }
        export const controller = createController();
      `,
      "utf8",
    );
    await writeFile(
      path.join(root, "state", "index.ts"),
      'export { controller as dialog } from "./controller";',
      "utf8",
    );
    await writeFile(
      path.join(root, "screen.tsx"),
      `
        import { useValue } from "@legendapp/state/react";
        import { dialog } from "./state";
        export function Screen() {
          const value = useValue(dialog.value$);
          dialog.set({ state: false });
          return <span>{value.profile.name}</span>;
        }
      `,
      "utf8",
    );

    const context = await createAnalysisContext(root);
    assert.deepEqual(
      [...context.sourceIndex.observablePathsFor(path.join(root, "screen.tsx"))],
      ["dialog.value$"],
    );
    const report = await analyzePath(root, { sharedContext: context });
    assert.deepEqual(
      report.practices.map((finding) => finding.action),
      ["narrow-use-value-subscription"],
    );
    assert.match(
      requireValue(report.practices[0]).message ?? "",
      /useValue\(dialog\.value\$\.profile\.name\)/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("narrows an appended clone write to an imported observable array", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-imported-array-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, "state"), { recursive: true });
  await writeFile(
    path.join(root, "state", "pages.ts"),
    `
      import { observable } from "@legendapp/state";
      export const pages$ = observable<string[]>([]);
      export const catalog$ = observable({ rows: [] as string[], selection: null as string | null });
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "commands.ts"),
    `
      import { catalog$, pages$ } from "./state/pages";
      export function append(page: string, row: string) {
        pages$.set((previous) => [...previous, page]);
        catalog$.rows.set([...catalog$.rows.peek(), row]);
        catalog$.selection.set(row);
      }
    `,
    "utf8",
  );

  const report = await analyzePath(root);
  const appends = report.practices.filter(
    (finding) => finding.action === "narrow-observable-write",
  );
  assert.deepEqual(
    appends.map(
      (finding) => finding.message?.match(/`(?<replacement>[^`]+)`/u)?.groups?.["replacement"],
    ),
    ["pages$.push(page)", "catalog$.rows.push(row)"],
  );
  assert.ok(appends.every((finding) => finding.location.file === "commands.ts"));
});
