import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const STORE = `
  import { observable } from "@legendapp/state";
  export const store$ = observable<Record<string, { status: string }>>({});
  export function patch(id: string, status: string) {
    const map = store$.peek();
    store$.set({ ...map, [id]: { status } });
  }
`;

async function narrowWrites(consumer: string): Promise<string[]> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-narrow-identity-"));
  try {
    await mkdir(path.join(root, "state"), { recursive: true });
    await writeFile(path.join(root, "state", "store.ts"), STORE, "utf8");
    await writeFile(path.join(root, "consumer.tsx"), consumer, "utf8");
    const report = await analyzePath(root);
    return report.practices
      .filter((finding) => finding.action === "narrow-observable-write")
      .map((finding) => `${finding.location.file}:${finding.location.line}`);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("keeps a clone write whose root value another module memoizes on", async () => {
  const consumers = [
    `
      import { useValue } from "@legendapp/state/react";
      import { useMemo } from "react";
      import { store$ } from "./state/store";
      export function useDoneCount() {
        const map = useValue(() => store$.get());
        return useMemo(() => Object.values(map).filter((row) => row.status === "done").length, [map]);
      }
    `,
    `
      import { useValue } from "@legendapp/state/react";
      import { memo } from "react";
      import { store$ } from "./state/store";
      const Rows = memo(function Rows({ map }: { map: Record<string, { status: string }> }) {
        return <>{Object.keys(map).length}</>;
      });
      export function List() {
        return <Rows map={useValue(store$)} />;
      }
    `,
    `
      import { syncObservable } from "@legendapp/state/sync";
      import { store$ as rows$ } from "./state/store";
      syncObservable(rows$, { persist: { name: "rows" } });
    `,
  ];
  for (const consumer of consumers) {
    assert.deepEqual(await narrowWrites(consumer), [], consumer);
  }
});

test("narrows a clone write whose other-module readers read only rows or leaf fields", async () => {
  const consumer = `
    import { useValue } from "@legendapp/state/react";
    import { useMemo } from "react";
    import { store$ } from "./state/store";
    export function Row({ id }: { id: string }) {
      const row = useValue(() => store$[id].get());
      const status = useValue(() => store$.get()[id]?.status);
      return useMemo(() => \`\${row?.status}:\${status}\`, [row, status]);
    }
  `;
  assert.deepEqual(await narrowWrites(consumer), ["state/store.ts:6"]);
});
