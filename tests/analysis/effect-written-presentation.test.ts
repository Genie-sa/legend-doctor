import type { HookFinding } from "../../src/core/types.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("isolates effect-written presentation state in a leaf subscriber", () => {
  const [finding] = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function Dashboard() {
      const [previewUrl, setPreviewUrl] = useState<string | null>(null);
      useEffect(() => {
        const url = URL.createObjectURL(file);
        setPreviewUrl(url);
        return () => URL.revokeObjectURL(url);
      }, []);
      return <Page><Header /><Nav /><Summary /><Filters /><Chart /><Table /><Sidebar />
        <Help /><Footer /><Actions /><Status>
          {previewUrl ? <Preview src={previewUrl} /> : <EmptyPreview />}
        </Status></Page>;
    }
  `,
    "fixture.tsx",
  );

  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /preserve the React effect/iu);
  assert.match(requireValue(finding).message ?? "", /leaf subscriber/iu);
});

test("isolates presentation state written by an effect-owned memoized command", () => {
  const source = (escape: string): string => `
    import { useEffect, useMemo, useState } from "react";
    export function Dashboard({ values }: { values: number[] }) {
      const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
      const updateDimensions = useMemo(
        () => throttle((items: number[]) => {
          setDimensions({ width: items.length, height: items.length * 2 });
        }, 200),
        []
      );
      useEffect(() => { updateDimensions(values); }, [updateDimensions, values]);
      useEffect(() => () => updateDimensions.cancel(), [updateDimensions]);
      return <Page><Header /><Nav /><Summary /><Filters /><Chart /><Table /><Sidebar />
        <Help /><Footer /><Actions ${escape}/><Stats>
          <Row>{dimensions.width}</Row><Row>{dimensions.height}</Row>
        </Stats></Page>;
    }
  `;
  const [finding] = analyzeSource(source(""), "fixture.tsx");
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /memoized command/iu);
  assert.match(requireValue(finding).message ?? "", /effect and cleanup/iu);

  const escaped = analyzeSource(source("onUpdate={updateDimensions}"), "fixture.tsx").find(
    (candidate) => candidate.name === "dimensions",
  );
  assert.notEqual(requireValue(escaped).action, "use-observable");
});

test("requires a material five-element cut in a compact effect-written owner", () => {
  const analyze = (siblings: string): HookFinding | undefined =>
    analyzeSource(
      `
    import { useEffect, useState } from "react";
    export function Panel() {
      const [visible, setVisible] = useState(false);
      useEffect(() => { setVisible(true); }, []);
      return <Page>${siblings}{visible && <Leaf />}</Page>;
    }
  `,
      "fixture.tsx",
    ).find((candidate) => candidate.name === "visible");

  assert.equal(
    requireValue(analyze("<Header /><Nav /><Summary /><Filters /><Footer />")).action,
    "use-observable",
  );
  assert.notEqual(requireValue(analyze("<Header /><Nav /><Footer />")).action, "use-observable");
});

test("accepts an effect-written projection through the imported clsx package", () => {
  const [finding] = analyzeSource(
    `
    import clsx from "clsx";
    import { useEffect, useState } from "react";
    export function Dashboard() {
      const [canRetry, setCanRetry] = useState(false);
      useEffect(() => {
        const timer = setTimeout(() => setCanRetry(true), 200);
        return () => clearTimeout(timer);
      }, []);
      return <Page><Header /><Nav /><Summary /><Filters /><Chart /><Table /><Sidebar />
        <Help /><Footer /><Actions /><Status>
          <button className={clsx("retry", { invisible: !canRetry })}>Retry</button>
        </Status></Page>;
    }
  `,
    "fixture.tsx",
  );

  assert.equal(requireValue(finding).action, "use-observable");

  const [shadowed] = analyzeSource(
    `
    import clsx from "clsx";
    import { useEffect, useState } from "react";
    export function Dashboard() {
      const clsx = (...values: unknown[]) => { audit(values); return ""; };
      const [canRetry, setCanRetry] = useState(false);
      useEffect(() => { setCanRetry(true); }, []);
      return <Page><Header /><Nav /><Summary /><Filters /><Chart /><Table /><Sidebar />
        <Help /><Footer /><Actions /><Status>
          <button className={clsx("retry", { invisible: !canRetry })}>Retry</button>
        </Status></Page>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(requireValue(shadowed).action, "use-observable");
});

test("combines effect-written presentation state projected through two const aliases", () => {
  const [finding] = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function Gallery() {
      const [items, setItems] = useState<string[] | null>(null);
      useEffect(() => {
        let alive = true;
        setItems(null);
        loadItems().then(next => { if (alive) setItems(next); });
        return () => { alive = false; };
      }, []);
      const loading = items === null;
      const list = items ?? [];
      return <Page><Header /><Nav /><Summary /><Filters /><Chart /><Table /><Sidebar />
        <Help /><Footer /><Actions /><ScrollView>
          {loading ? <Skeleton /> : list.length === 0 ? <Empty /> :
            list.map(item => <Tile key={item} value={item} />)}
        </ScrollView></Page>;
    }
  `,
    "fixture.tsx",
  );

  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /<ScrollView>/u);

  const unkeyed = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function Gallery() {
      const [items, setItems] = useState<string[] | null>(null);
      useEffect(() => { setItems([]); }, []);
      const loading = items === null;
      const list = items ?? [];
      return <Page><Header /><Nav /><Summary /><Filters /><Chart /><Table /><Sidebar />
        <Help /><Footer /><Actions /><ScrollView>
          {loading ? <Skeleton /> : list.map(item => <Tile value={item} />)}
        </ScrollView></Page>;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.name === "items");
  assert.notEqual(requireValue(unkeyed).action, "use-observable");
});

test("keeps unsafe effect-written presentation state under review", () => {
  for (const body of [
    `setElapsed(next); setReady(true);`,
    `if (elapsed < next) setElapsed(next);`,
    `setElapsed(previous => { audit(previous); return previous + 1; });`,
  ]) {
    const findings = analyzeSource(
      `
      import { useEffect, useState } from "react";
      export function Dashboard({ next }: { next: number }) {
        const [elapsed, setElapsed] = useState(0);
        const [ready, setReady] = useState(false);
        useEffect(() => { ${body} }, [next]);
        return <Page><Header /><Nav /><Summary /><Filters /><Chart /><Table /><Sidebar />
          <Help /><Footer /><Actions /><Status><Progress value={elapsed} /></Status>
          <Ready value={ready} /></Page>;
      }
    `,
      "fixture.tsx",
    );
    const elapsed = findings.find((finding) => finding.name === "elapsed");
    assert.notEqual(requireValue(elapsed).action, "use-observable", body);
  }

  const opaqueGate = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function Dashboard() {
      const [visible, setVisible] = useState(false);
      useEffect(() => { setVisible(true); }, []);
      return <Page><Header /><Nav /><Summary /><Filters /><Chart /><Table /><Sidebar />
        <Help /><Footer /><Actions /><Status>
          {dangerous(visible) ? <Ready /> : <Waiting />}
        </Status></Page>;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.name === "visible");
  assert.notEqual(requireValue(opaqueGate).action, "use-observable");
});
