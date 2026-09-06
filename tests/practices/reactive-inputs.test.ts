import type { LegendPracticeFinding } from "../../src/core/types.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import test from "node:test";

const STORE = `
  import { observable, observe, when, whenReady } from "@legendapp/state";
  import { Computed, For, Memo, Show, Switch, reactive, useObserve, useObserveEffect, useValue, useWhen } from "@legendapp/state/react";
  import { $React } from "@legendapp/state/react-web";
  const state$ = observable({ ready: false, mode: "a", items: [] as { id: string }[], name: "" });
`;

function eagerInputs(body: string): LegendPracticeFinding[] {
  return analyzeLegendPractices({
    sourceText: `${STORE}\n${body}`,
    fileName: "fixture.tsx",
  }).filter((finding) => finding.action === "pass-observable-to-reactive-input");
}

test("passes the observable instead of a snapshot to Show, Switch, and For", () => {
  const findings = eagerInputs(`
    export function Gates() {
      return (
        <>
          <Show if={state$.ready.get()}>{() => <b>ready</b>}</Show>
          <Show ifReady={state$.name.peek()}>{() => <b>named</b>}</Show>
          <Switch value={state$.mode.get()}>{{ a: () => <i>a</i> }}</Switch>
          <For each={state$.items.get()}>{(item$) => <span>{item$.id.get()}</span>}</For>
        </>
      );
    }
  `);
  assert.deepEqual(
    findings.map((finding) => [finding.location.line, finding.message]),
    [
      [
        11,
        "Replace `state$.ready.get()` with `state$.ready` in `<Show if>`; `Show` tracks the observable itself, while the snapshot only updates when the parent re-renders.",
      ],
      [
        12,
        "Replace `state$.name.peek()` with `state$.name` in `<Show ifReady>`; `Show` tracks the observable itself, while the snapshot only updates when the parent re-renders.",
      ],
      [
        13,
        "Replace `state$.mode.get()` with `state$.mode` in `<Switch value>`; `Switch` tracks the observable itself, while the snapshot only updates when the parent re-renders.",
      ],
      [
        14,
        "Replace `state$.items.get()` with `state$.items` in `<For each>`; `For` calls `get()` on the collection it receives to track membership, so the raw array breaks that contract.",
      ],
    ],
  );
  assert.ok(findings.every((finding) => finding.confidence === "certain"));
  assert.ok(findings.every((finding) => finding.disposition === "change"));
});

test("passes the observable to Memo and Computed children", () => {
  const findings = eagerInputs(`
    export function Text() {
      return (
        <p>
          <Memo>{state$.name.get()}</Memo>
          <Computed>{state$.name.get()}</Computed>
        </p>
      );
    }
  `);
  assert.deepEqual(
    findings.map((finding) => finding.message),
    [
      "Replace `state$.name.get()` with `state$.name` in `<Memo>`; `Memo` re-renders from its own observable, not from its parent, so the snapshot never updates.",
      "Replace `state$.name.get()` with `state$.name` in `<Computed>`; `Computed` re-renders from its own observable, not from its parent, so the snapshot never updates.",
    ],
  );
});

test("passes the observable to $-prefixed props on web, native, and reactive() components", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
      import { observable } from "@legendapp/state";
      import { reactive } from "@legendapp/state/react";
      import { $React } from "@legendapp/state/react-web";
      import { $View as NativeView } from "@legendapp/state/react-native";
      import { motion } from "framer-motion";
      const state$ = observable({ name: "", active: false });
      const MotionDiv = reactive(motion.div);
      export function Hosts() {
        return (
          <>
            <$React.input $value={state$.name.get()} />
            <NativeView $style={state$.active.get()} />
            <MotionDiv $animate={state$.active.get()} className="x" />
            <$React.div className={state$.name.get()} />
          </>
        );
      }
    `,
    fileName: "fixture.tsx",
  });
  assert.deepEqual(
    findings
      .filter((finding) => finding.action === "pass-observable-to-reactive-input")
      .map((finding) => finding.message.split(";")[0]),
    [
      "Replace `state$.name.get()` with `state$.name` in `<$React.input $value>`",
      "Replace `state$.active.get()` with `state$.active` in `<NativeView $style>`",
      "Replace `state$.active.get()` with `state$.active` in `<MotionDiv $animate>`",
    ],
  );
  assert.deepEqual(
    findings
      .filter((finding) => finding.action === "use-value-for-render-read")
      .map((finding) => finding.location.line),
    [15],
  );
});

test("passes the observable to reactions instead of a snapshot", () => {
  const findings = eagerInputs(`
    when(state$.ready.get(), () => start());
    whenReady(state$.items.get()).then(() => start());
    observe(state$.mode.get(), () => sync());
    export function Reactions() {
      useObserve(state$.ready.get(), () => sync());
      useObserveEffect(state$.mode.get(), () => sync());
      useWhen(state$.ready.get(), () => start());
      return null;
    }
  `);
  assert.deepEqual(
    findings.map((finding) => finding.message.replace(/^Replace `[^`]+` with `[^`]+` in /u, "")),
    [
      "`when`; `when` resolves the snapshot once instead of waiting for the observable to change.",
      "`whenReady`; `whenReady` resolves the snapshot once instead of waiting for the observable to change.",
      "`observe`; `observe` runs once against the snapshot instead of re-running when the observable changes.",
      "`useObserve`; `useObserve` runs once against the snapshot instead of re-running when the observable changes.",
      "`useObserveEffect`; `useObserveEffect` runs once against the snapshot instead of re-running when the observable changes.",
      "`useWhen`; `useWhen` resolves the snapshot once instead of waiting for the observable to change.",
    ],
  );
});

test("resolves Legend components and reactions through namespace imports", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
      import * as Legend from "@legendapp/state";
      import * as LegendReact from "@legendapp/state/react";
      const state$ = Legend.observable({ ready: false });
      Legend.when(state$.ready.get(), () => start());
      export function Gate() {
        LegendReact.useObserve(state$.ready.get(), () => sync());
        return <LegendReact.Show if={state$.ready.get()}>{() => <b>ready</b>}</LegendReact.Show>;
      }
    `,
    fileName: "fixture.tsx",
  });
  assert.deepEqual(
    findings.map((finding) => [finding.action, finding.location.line]),
    [
      ["pass-observable-to-reactive-input", 5],
      ["pass-observable-to-reactive-input", 7],
      ["pass-observable-to-reactive-input", 8],
    ],
  );
});

test("leaves selectors, observables, plain values, other props, and lookalike components alone", () => {
  const findings = analyzeLegendPractices({
    sourceText: `${STORE}
      import { Show as Modal } from "./ui";
      export function Fine({ open }: { open: boolean }) {
        const ready = useValue(state$.ready);
        return (
          <>
            <Show if={state$.ready}>{() => <b>ready</b>}</Show>
            <Show if={() => state$.ready.get()}>{() => <b>ready</b>}</Show>
            <Show if={open} else={<i>closed</i>}>{() => <b>ready</b>}</Show>
            <Show if={ready}>{() => <b>ready</b>}</Show>
            <Modal if={state$.ready.get()} />
            <For each={state$.items} item={Row} />
            <$React.div className="static" $style={() => ({ color: state$.name.get() })} />
          </>
        );
      }
      function Row() {
        return null;
      }
      when(() => state$.ready.get(), () => start());
      when(state$.ready, () => start());
      observe(() => sync(state$.mode.get()));
    `,
    fileName: "fixture.tsx",
  });
  assert.deepEqual(
    findings
      .map((finding) => finding.action)
      .filter(
        (action) =>
          action === "pass-observable-to-reactive-input" || action === "use-value-for-render-read",
      ),
    [],
  );
});

test("leaves useValue snapshots to the direct-input rule", () => {
  const findings = analyzeLegendPractices({
    sourceText: `${STORE}
      export function Direct() {
        const ready = useValue(state$.ready.get());
        return <b>{String(ready)}</b>;
      }
    `,
    fileName: "fixture.tsx",
  });
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["pass-observable-to-use-value"],
  );
});
