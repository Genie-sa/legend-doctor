import type { HookFinding } from "../../src/core/types.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("does not isolate controlled state with a render-phase setter", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    function Preview() { return null; }
    export function Form({ reset }: { reset: boolean }) {
      const [value, setValue] = useState("");
      if (reset && value) setValue("");
      return <main><Field value={value} onChangeText={setValue} /><Preview /></main>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(requireValue(finding).action, "use-observable");
});

test("does not isolate controlled state read by an effect-like lifecycle hook", () => {
  const source = (hookImport: string, hookCall: string): HookFinding | undefined =>
    analyzeSource(
      `
    import { useState, ${hookImport} } from "react";
    function Field(_props: unknown) { return null; }
    function Preview() { return null; }
    export function Form() {
      const [value, setValue] = useState("");
      ${hookCall}(() => save(value), [value]);
      return <main><Field value={value} onChangeText={setValue} /><Preview /></main>;
    }
  `,
      "fixture.tsx",
    )[0];
  assert.notEqual(
    requireValue(source("useLayoutEffect", "useLayoutEffect")).action,
    "use-observable",
  );
  assert.notEqual(
    requireValue(source("useInsertionEffect as useInsert", "useInsert")).action,
    "use-observable",
  );
});

test("preserves mutable React state when its owner has an every-commit effect", () => {
  for (const [hookImport, hookCall] of [
    ["useEffect", "useEffect"],
    ["useLayoutEffect as useLayout", "useLayout"],
    ["useInsertionEffect", "useInsertionEffect"],
  ]) {
    const findings = analyzeSource(
      `
      import { ${hookImport}, useState } from "react";
      function Leaf(_props: unknown) { return null; }
      export function Screen() {
        const [visible, setVisible] = useState(false);
        ${hookCall}(() => synchronizeLayout());
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Preview />
          <button onClick={() => setVisible(true)}>Open</button>
          {visible && <Leaf />}
        </main>;
      }
    `,
      "fixture.tsx",
    );
    const visible = requireValue(findings.find((finding) => finding.name === "visible"));
    assert.equal(visible.action, "review-state");
    assert.equal(visible.abstentionReason, "react-commit-sensitive");
  }

  const explicitUndefined = analyzeSource(
    `
    import { useEffect, useState } from "react";
    function Leaf() { return null; }
    export function Screen() {
      const [visible, setVisible] = useState(false);
      function nested(undefined: unknown) { return undefined; }
      useEffect(() => synchronizeLayout(), undefined);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Preview />
        <button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(explicitUndefined.find((finding) => finding.name === "visible")).action,
    "review-state",
  );

  const explicitNull = analyzeSource(
    `
    import { useEffect, useState } from "react";
    function Leaf() { return null; }
    export function Screen() {
      const [visible, setVisible] = useState(false);
      useEffect(() => synchronizeLayout(), null);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Preview />
        <button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(explicitNull.find((finding) => finding.name === "visible")).action,
    "review-state",
  );
});

test("preserves mutable React state when its owner uses an inline callback ref", () => {
  const findings = analyzeSource(
    `
    import { useState } from "react";
    function Leaf() { return null; }
    export function Screen() {
      const [visible, setVisible] = useState(false);
      return <main ref={node => synchronizeLayout(node)}>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Preview />
        <button onClick={() => setVisible(true)}>Open</button>
        {visible && <Leaf />}
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.name === "visible")).action,
    "review-state",
  );
});

test("uses an owner-level boundary for fresh refs while allowing stable memoized refs", () => {
  const siblings =
    "<Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Preview />";
  const findings = analyzeSource(
    `
    import { useCallback, useState } from "react";
    function Leaf() { return null; }
    export function NamedRef() {
      const [visible, setVisible] = useState(false);
      const setNode = (node: unknown) => synchronizeLayout(node);
      return <main ref={setNode}>${siblings}<button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}</main>;
    }
    export function RepeatedRef({ rows }: { rows: Array<{ id: string }> }) {
      const [visible, setVisible] = useState(false);
      return <main>${siblings}<button onClick={() => setVisible(true)}>Open</button>
        {rows.map(row => <div key={row.id} ref={node => synchronizeRow(row.id, node)} />)}
        {visible && <Leaf />}
      </main>;
    }
    export function MemoizedRef() {
      const [visible, setVisible] = useState(false);
      const setNode = useCallback((node: unknown) => synchronizeLayout(node), []);
      return <main ref={setNode}>${siblings}<button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}</main>;
    }
    export function ConditionalRef({ alternate }: { alternate: boolean }) {
      const [visible, setVisible] = useState(false);
      return <main ref={alternate ? node => synchronizeLayout(node) : node => synchronizeFallback(node)}>
        ${siblings}<button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}
      </main>;
    }
    export function NestedComponentRef() {
      const [visible, setVisible] = useState(false);
      function Nested() { return <div ref={node => synchronizeLayout(node)} />; }
      return <main>${siblings}<button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}</main>;
    }
    export function OpaqueMergedRef({ externalRef }: { externalRef: unknown }) {
      const [visible, setVisible] = useState(false);
      const merged = mergeRefs(externalRef);
      return <main ref={merged}>${siblings}<button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}</main>;
    }
    export function ArrayFromRef({ rows }: { rows: string[] }) {
      const [visible, setVisible] = useState(false);
      return <main>${siblings}{Array.from(rows, row => <div key={row} ref={node => synchronizeRow(row, node)} />)}
        <button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}</main>;
    }
    export function NamedRenderRef({ rows }: { rows: string[] }) {
      const [visible, setVisible] = useState(false);
      function renderRow(row: string) { return <div key={row} ref={node => synchronizeRow(row, node)} />; }
      return <main>${siblings}{rows.map(renderRow)}
        <button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}</main>;
    }
    export function DirectRenderHelperRef() {
      const [visible, setVisible] = useState(false);
      const renderRef = () => <div ref={node => synchronizeLayout(node)} />;
      return <main>${siblings}{renderRef()}<button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}</main>;
    }
    export function LocalComponentRef() {
      const [visible, setVisible] = useState(false);
      function RefChild() { return <div ref={node => synchronizeLayout(node)} />; }
      return <main>${siblings}<RefChild /><button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}</main>;
    }
    export function UnmemoizedCallbackRef() {
      const [visible, setVisible] = useState(false);
      const setNode = useCallback((node: unknown) => synchronizeLayout(node));
      return <main ref={setNode}>${siblings}<button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}</main>;
    }
    export function ConditionalBindingRef({ alternate }: { alternate: boolean }) {
      const [visible, setVisible] = useState(false);
      const setNode = alternate
        ? (node: unknown) => synchronizeLayout(node)
        : (node: unknown) => synchronizeFallback(node);
      return <main ref={setNode}>${siblings}<button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}</main>;
    }
  `,
    "fixture.tsx",
  );
  const visible = findings.filter((finding) => finding.name === "visible");
  assert.deepEqual(
    visible.map((finding) => finding.action),
    [
      "review-state",
      "review-state",
      "use-observable",
      "review-state",
      "review-state",
      "review-state",
      "review-state",
      "review-state",
      "review-state",
      "review-state",
      "review-state",
      "review-state",
    ],
  );
});

test("does not call a nonliteral dependency array an every-commit effect", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    function Leaf() { return null; }
    export function Screen({ dependency }: { dependency: string }) {
      const [visible, setVisible] = useState(false);
      const dependencies = [dependency];
      useEffect(() => synchronizeLayout(), dependencies);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Preview />
        <button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.name === "visible")).action,
    "use-observable",
  );
});

test("does not trust shadowed React effect bindings", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    function Leaf() { return null; }
    export function Screen({ useEffect }: { useEffect: (callback: () => void) => void }) {
      const [visible, setVisible] = useState(false);
      useEffect(() => synchronizeLayout());
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Preview />
        <button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.name === "visible")).action,
    "use-observable",
  );
  assert.equal(findings.filter((finding) => finding.hook === "useEffect").length, 0);

  const unrelatedNestedShadow = analyzeSource(
    `
    import { useEffect, useState } from "react";
    function Leaf() { return null; }
    export function Screen() {
      const [visible, setVisible] = useState(false);
      function nested(useEffect: (callback: () => void) => void) { useEffect(() => work()); }
      useEffect(() => synchronizeLayout());
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Preview />
        <button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(unrelatedNestedShadow.find((finding) => finding.name === "visible")).action,
    "review-state",
  );
});
