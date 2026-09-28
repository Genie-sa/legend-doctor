import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import test from "node:test";

const STORE = `
  import { observable } from "@legendapp/state";
  import { Computed, For, Memo, Show, Switch, useValue } from "@legendapp/state/react";
  import { $React } from "@legendapp/state/react-web";
  const state$ = observable({ ready: false, mode: "a", items: [] as { id: string }[], name: "" });
`;

function renderReadLines(sourceText: string): number[] {
  return analyzeLegendPractices({ sourceText, fileName: "fixture.tsx" })
    .filter((finding) => finding.action === "use-value-for-render-read")
    .map((finding) => finding.location.line);
}

test("leaves snapshots handed to Show, Switch, For, Memo, and Computed to those components", () => {
  assert.deepEqual(
    renderReadLines(`${STORE}
      export function Gates() {
        return (
          <>
            <Show if={state$.ready.get()}>{() => <b>ready</b>}</Show>
            <Switch value={state$.mode.get()}>{{ a: () => <i>a</i> }}</Switch>
            <For each={state$.items.get()}>{(item$) => <span>{item$.id.get()}</span>}</For>
            <Memo>{state$.name.get()}</Memo>
            <Computed>{state$.name.get()}</Computed>
            <b>{state$.name.get()}</b>
          </>
        );
      }
    `),
    [15],
  );
});

test("leaves snapshots handed to $-prefixed props on web, native, and reactive() components", () => {
  assert.deepEqual(
    renderReadLines(`
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
    `),
    [15],
  );
});

test("leaves snapshots handed to reactions and namespace-imported components", () => {
  assert.deepEqual(
    renderReadLines(`
      import * as Legend from "@legendapp/state";
      import * as LegendReact from "@legendapp/state/react";
      import { useObserve, useWhen } from "@legendapp/state/react";
      const state$ = Legend.observable({ ready: false });
      export function Gate() {
        useObserve(state$.ready.get(), () => sync());
        useWhen(state$.ready.get(), () => start());
        LegendReact.useObserveEffect(state$.ready.get(), () => sync());
        return <LegendReact.Show if={state$.ready.get()}>{() => <b>ready</b>}</LegendReact.Show>;
      }
    `),
    [],
  );
});

test("still flags a snapshot handed to a lookalike component or an ordinary prop", () => {
  assert.deepEqual(
    renderReadLines(`${STORE}
      import { Show as Modal } from "./ui";
      export function Lookalikes() {
        return (
          <>
            <Modal if={state$.ready.get()} />
            <$React.div className={state$.name.get()} />
          </>
        );
      }
    `),
    [11, 12],
  );
});
