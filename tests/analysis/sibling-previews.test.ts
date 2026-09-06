import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("isolates an effect-synchronized preview from its sibling producer", () => {
  const findings = analyzeSource(
    `
    import { useCallback, useEffect, useState } from "react";
    export function Picker({ items }: { items: string[] }) {
      const [active, setActive] = useState<string | null>(null);
      useEffect(() => { setActive(null); }, [items]);
      const preview = active ?? items[0] ?? null;
      const handleActive = useCallback((item: string) => setActive(item), []);
      return <main>
        <Grid items={items} onItemActive={handleActive} />
        <Preview item={preview} />
        <Footer /><Help /><Status />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.name === "active")).action,
    "use-observable",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.hook === "useEffect")).action,
    "review-effect",
  );
  assert.match(
    requireValue(findings.find((finding) => finding.name === "active")).message ?? "",
    /sibling.*Preview/iu,
  );
});

test("keeps opaque fallback work in the owner as a sibling preview snapshot", () => {
  const findings = analyzeSource(
    `
    import { useCallback, useEffect, useState } from "react";
    export function Picker({ items }: { items: string[] }) {
      const [active, setActive] = useState<string | null>(null);
      useEffect(() => { setActive(null); }, [items]);
      const handleActive = useCallback((item: string) => setActive(item), []);
      return <main>
        <Grid items={items} onItemActive={handleActive} />
        <Preview item={active ?? chooseFallback(items)} />
        <Footer /><Help /><Status />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  const state = findings.find((finding) => finding.name === "active");
  assert.equal(requireValue(state).action, "use-observable");
  assert.match(
    requireValue(state).message ?? "",
    /state-independent fallback inputs as ordinary snapshots/u,
  );
});

test("does not isolate a fallback expression that reads the state twice", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Picker() {
      const [active, setActive] = useState<string | null>(null);
      return <main>
        <Grid onActive={item => setActive(item)} />
        <Preview item={active ?? recover(active)} />
        <Footer /><Help /><Status />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(requireValue(finding).action, "use-observable");
});

test("isolates a chart cursor in a stable sibling labels subtree", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function ChartCard({ rows }: { rows: Array<{ id: string; label: string }> }) {
      const [active, setActive] = useState<string | null>(null);
      const activeIndex = active === null ? -1 : rows.findIndex(row => row.id === active);
      return <main>
        <Chart rows={rows} onFocusChange={point => setActive(point?.id ?? null)} />
        <div>{rows.map((row, index) => <span key={row.id} data-active={index === activeIndex}>{row.label}</span>)}</div>
        <Header /><Footer /><Help />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /sibling.*<div>/iu);
});

test("isolates direct setter transport from its sibling value consumer", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Picker() {
      const [showFade, setShowFade] = useState(false);
      return <main>
        <Grid onOverflowChange={setShowFade} />
        <Preview showFade={showFade} />
        <Header /><Footer /><Help />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /sibling.*Preview/iu);
});

test("requires one stable producer and one complete sibling consumer", () => {
  const snippets = [
    `<Picker value={active} onChange={item => setActive(item)} />`,
    `<><Grid onActive={item => setActive(item)} /><Preview item={active} /><Header active={active} /></>`,
    `<><Grid onActive={item => setActive(item)} />{active && <Preview item={active} />}</>`,
    `<><Grid onActive={item => setActive(item)} /><Preview item={format(active)} /></>`,
    `<>{rows.map(row => <Grid key={row.id} onActive={item => setActive(item)} />)}<Preview item={active} /></>`,
  ];
  for (const rendered of snippets) {
    const [finding] = analyzeSource(
      `
      import { useState } from "react";
      export function Picker({ rows }: { rows: Array<{ id: string }> }) {
        const [active, setActive] = useState<string | null>(null);
        return <main>${rendered}<Footer /><Help /><Status /><Actions /></main>;
      }
    `,
      "fixture.tsx",
    );
    assert.notEqual(requireValue(finding).action, "use-observable");
  }
});

test("does not isolate a sibling preview when its alias also drives owner work", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Picker({ items }: { items: string[] }) {
      const [active, setActive] = useState<string | null>(null);
      const preview = active ?? items[0] ?? null;
      usePreviewQuery(preview);
      return <main><Grid onActive={item => setActive(item)} /><Preview item={preview} /><Footer /><Help /><Status /></main>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(requireValue(finding).action, "use-observable");
});

test("does not call a producer command-only when it also invokes owner work", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Picker({ notify }: { notify: () => void }) {
      const [active, setActive] = useState<string | null>(null);
      const handleActive = (item: string) => {
        setActive(item);
        notify();
      };
      return <main>
        <Grid onActive={handleActive} />
        <Preview item={active} />
        <Header /><Footer /><Help />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(requireValue(finding).action, "use-observable");
});
