import type { HookFinding } from "../../src/core/types.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("tracks state reads and writes through React lifecycle callback bindings", () => {
  const siblings =
    "<Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Preview />";
  const findings = analyzeSource(
    `
    import React, {
      useCallback,
      useEffect,
      useInsertionEffect as useInsert,
      useLayoutEffect,
      useState,
    } from "react";
    function Leaf() { return null; }

    export function InlineLayout({ source }: { source: boolean }) {
      const [visible, setVisible] = useState(false);
      useLayoutEffect(() => { setVisible(source); report(visible); }, [source]);
      return <main>${siblings}{visible && <Leaf />}</main>;
    }

    export function MemoizedLayout({ source }: { source: boolean }) {
      const [visible, setVisible] = useState(false);
      const synchronize = useCallback(() => setVisible(source), [source]);
      React.useLayoutEffect(synchronize, [synchronize]);
      return <main>${siblings}{visible && <Leaf />}</main>;
    }

    export function AliasedInsertion() {
      const [visible, setVisible] = useState(false);
      function read() { report(visible); }
      const synchronize = read;
      useInsert(synchronize, [synchronize]);
      return <main>${siblings}<button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}</main>;
    }

    export function NamedEffect({ source }: { source: boolean }) {
      const [visible, setVisible] = useState(false);
      const synchronize = () => setVisible(source);
      useEffect(synchronize, [synchronize]);
      return <main>${siblings}{visible && <Leaf />}</main>;
    }
  `,
    "fixture.tsx",
  );
  const stateFor = (owner: string): HookFinding | undefined =>
    findings.find(
      (finding) =>
        finding.hook === "useState" &&
        requireValue(finding.evidence[0]).startsWith(`owner: ${owner},`),
    );

  assert.equal(requireValue(stateFor("InlineLayout")).action, "review-state");
  assert.match(requireValue(stateFor("InlineLayout")).evidence[1] ?? "", /effects 1/u);
  assert.match(requireValue(stateFor("InlineLayout")).evidence[2] ?? "", /effect writes 1/u);
  assert.equal(requireValue(stateFor("MemoizedLayout")).action, "use-observable");
  assert.match(requireValue(stateFor("MemoizedLayout")).evidence[2] ?? "", /effect writes 1/u);
  assert.equal(requireValue(stateFor("AliasedInsertion")).action, "review-state");
  assert.match(requireValue(stateFor("AliasedInsertion")).evidence[1] ?? "", /effects 1/u);
  assert.equal(requireValue(stateFor("NamedEffect")).action, "use-observable");
  assert.match(requireValue(stateFor("NamedEffect")).evidence[2] ?? "", /effect writes 1/u);
  assert.equal(findings.filter((finding) => finding.hook === "useEffect").length, 1);
});

test("does not isolate state whose update is scheduled by a React transition", () => {
  const findings = analyzeSource(
    `
    import { startTransition as schedule, useState, useTransition } from "react";
    function Leaf(_props: unknown) { return null; }
    function Shell(_props: unknown) { return null; }
    export function PlainUpdate() {
      const [visible, setVisible] = useState(false);
      return <main><Shell /><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <button onClick={() => setVisible(true)}>Open</button>
        {visible && <Leaf />}
      </main>;
    }
    export function StaticTransition() {
      const [visible, setVisible] = useState(false);
      return <main><Shell /><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <button onClick={() => schedule(() => setVisible(true))}>Open</button>
        {visible && <Leaf />}
      </main>;
    }
    export function HookTransition() {
      const [visible, setVisible] = useState(false);
      const [, begin] = useTransition();
      return <main><Shell /><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <button onClick={() => begin(() => setVisible(true))}>Open</button>
        {visible && <Leaf />}
      </main>;
    }
    export function NamedTransition() {
      const [visible, setVisible] = useState(false);
      function update() { setVisible(true); }
      return <main><Shell /><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <button onClick={() => schedule(update)}>Open</button>
        {visible && <Leaf />}
      </main>;
    }
    export function AliasedTransition() {
      const [visible, setVisible] = useState(false);
      const begin = schedule;
      const update = () => setVisible(true);
      return <main><Shell /><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <button onClick={() => begin(() => update())}>Open</button>
        {visible && <Leaf />}
      </main>;
    }
    export function ChainedStaticTransition() {
      const [visible, setVisible] = useState(false);
      const first = schedule;
      const begin = first;
      return <main><Shell /><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <button onClick={() => begin(() => setVisible(true))}>Open</button>
        {visible && <Leaf />}
      </main>;
    }
    export function AliasedHookTransition() {
      const [visible, setVisible] = useState(false);
      const [, transition] = useTransition();
      const begin = transition;
      return <main><Shell /><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <button onClick={() => begin(() => setVisible(true))}>Open</button>
        {visible && <Leaf />}
      </main>;
    }
    export function NestedHelperTransition() {
      const [visible, setVisible] = useState(false);
      const update = () => setVisible(true);
      const middle = () => update();
      return <main><Shell /><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <button onClick={() => schedule(() => middle())}>Open</button>
        {visible && <Leaf />}
      </main>;
    }
    export function AssertedTransition() {
      const [visible, setVisible] = useState(false);
      function update() { setVisible(true); }
      return <main><Shell /><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <button onClick={() => schedule(update as () => void)}>Open</button>
        {visible && <Leaf />}
      </main>;
    }
    export function MutableNamedTransition() {
      const [visible, setVisible] = useState(false);
      let update = () => setVisible(true);
      if (window.disabled) update = () => {};
      return <main><Shell /><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <button onClick={() => schedule(update)}>Open</button>
        {visible && <Leaf />}
      </main>;
    }
  `,
    "fixture.tsx",
  );
  const visible = findings.filter((finding) => finding.name === "visible");
  assert.deepEqual(
    visible.map((finding) => finding.action),
    [
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

test("isolates only state proven outside direct inline React transitions", () => {
  const findings = analyzeSource(
    `
    import { useState, useTransition } from "react";
    function Leaf(_props: unknown) { return null; }
    function Shell() { return null; }
    export function Screen() {
      const [visible, setVisible] = useState(false);
      const [busy, setBusy] = useState(false);
      const [, begin] = useTransition();
      return <main><Shell /><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <button onClick={() => setVisible(true)}>Open</button>
        <button onClick={() => begin(() => setBusy(true))}>Refresh</button>
        {visible && <Leaf />}{busy && <Leaf />}
      </main>;
    }
  `,
    "fixture.tsx",
  );

  assert.equal(
    requireValue(findings.find((finding) => finding.name === "visible")).action,
    "use-observable",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.name === "busy")).action,
    "review-state",
  );
});

test("does not isolate controlled state captured by timers or subscriptions", () => {
  for (const root of [
    "subscribe(listener)",
    "setInterval(listener, 100)",
    "useFocusEffect(listener)",
  ]) {
    const [finding] = analyzeSource(
      `
      import { useState } from "react";
      function Field(_props: unknown) { return null; }
      function Preview() { return null; }
      export function Form() {
        const [value, setValue] = useState("");
        const listener = () => sync(value);
        ${root};
        return <main><Field value={value} onChangeText={setValue} /><Preview /></main>;
      }
    `,
      "fixture.tsx",
    );
    assert.notEqual(requireValue(finding).action, "use-observable");
  }
});

test("does not change stale useCallback snapshot semantics", () => {
  const [finding] = analyzeSource(
    `
    import { useCallback, useState } from "react";
    function Field(_props: unknown) { return null; }
    function Preview() { return null; }
    export function Form() {
      const [value, setValue] = useState("");
      const submit = useCallback(() => save(value), []);
      return <main><Field value={value} onChangeText={setValue} /><Preview /><button onClick={submit} /></main>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(requireValue(finding).action, "use-observable");
});
