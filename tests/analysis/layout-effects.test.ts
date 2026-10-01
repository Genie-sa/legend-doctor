import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { HookFinding } from "../../src/core/types.js";
import { analyzePath } from "../../src/project/analyze-path/analyze-path.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

function layoutEffect(source: string): HookFinding {
  return requireValue(
    analyzeSource(source, "fixture.tsx").find((finding) => finding.hook === "useEffect"),
  );
}

function assertKeptBeforePaint(finding: HookFinding): void {
  assert.equal(finding.action, "keep-effect");
  assert.match(
    finding.message,
    /^Keep this layout effect; it runs after DOM mutation and before paint/u,
  );
}

test("keeps a layout effect that measures the committed DOM and stores the result", () => {
  assertKeptBeforePaint(
    layoutEffect(`
      import { useLayoutEffect, useRef, useState } from "react";
      export function Tooltip({ label }: { label: string }) {
        const ref = useRef<HTMLDivElement>(null);
        const [height, setHeight] = useState(0);
        useLayoutEffect(() => { setHeight(ref.current?.offsetHeight ?? 0); }, [label]);
        return <div ref={ref} style={{ top: -height }}><span>{label}</span><b /><i /><em /></div>;
      }
    `),
  );
});

test("deletes layout-derived state only when render calculation paints the same first frame", () => {
  assert.deepEqual(
    analyzeSource(
      `
        import { useLayoutEffect, useState } from "react";
        export function Name({ first, last }: { first: string; last: string }) {
          const [fullName, setFullName] = useState(first + " " + last);
          useLayoutEffect(() => { setFullName(first + " " + last); }, [first, last]);
          return <span>{fullName}</span>;
        }
      `,
      "fixture.tsx",
    ).map((finding) => finding.action),
    ["delete-derived-state", "delete-effect"],
  );
  assertKeptBeforePaint(
    layoutEffect(`
      import { useLayoutEffect, useRef, useState } from "react";
      export function Field() {
        const input = useRef<HTMLInputElement>(null);
        const [text, setText] = useState(input.current?.value);
        useLayoutEffect(() => { setText(input.current?.value); }, [input.current?.value]);
        return <label><input ref={input} /><span>{text}</span></label>;
      }
    `),
  );
});

test("moves a layout reset effect into the event that changes its source", () => {
  assert.equal(
    layoutEffect(`
      import { useLayoutEffect, useState } from "react";
      export function Browser() {
        const [category, setCategory] = useState("all");
        const [detailIndex, setDetailIndex] = useState(0);
        useLayoutEffect(() => setDetailIndex(0), [category]);
        return <main>
          <button onClick={() => setCategory("next")}>Next category</button>
          <button onClick={() => setDetailIndex(value => value + 1)}>{detailIndex}</button>
        </main>;
      }
    `).action,
    "move-to-event",
  );
});

test("never moves a layout effect into an observable reaction or a mount alias", () => {
  for (const source of [
    `
      import { observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      import { useLayoutEffect } from "react";
      const player$ = observable({ isPlaying: false });
      export function Manager({ onStop }: { onStop: () => void }) {
        const isPlaying = useValue(player$.isPlaying);
        useLayoutEffect(() => { if (!isPlaying) onStop(); }, [isPlaying]);
        return null;
      }
    `,
    `
      import * as React from "react";
      export function Focus({ input }: { input: { focus(): void } }) {
        React.useLayoutEffect(() => { input.focus(); }, []);
        return null;
      }
    `,
  ]) {
    assertKeptBeforePaint(layoutEffect(source));
  }
});

test("analyzes a file whose only React hook is useLayoutEffect", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-layout-effect-"));
  try {
    await writeFile(
      path.join(root, "focus.tsx"),
      `
        import { useLayoutEffect } from "react";
        export function Focus({ input }: { input: { focus(): void } }) {
          useLayoutEffect(() => { input.focus(); }, [input]);
          return null;
        }
      `,
    );
    const report = await analyzePath(root);
    assertKeptBeforePaint(
      requireValue(report.findings.find((finding) => finding.hook === "useEffect")),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
