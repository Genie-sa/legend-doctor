import type { LegendPracticeFinding } from "../../src/core/types.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

const STORE = `
  import { observable } from "@legendapp/state";
  import type { Observable } from "@legendapp/state";
  import { useValue } from "@legendapp/state/react";
  const state$ = observable({ value: 0, user: { name: "" }, items: [] as { id: string }[] });
`;

function renderReads(body: string, fileName = "fixture.tsx"): LegendPracticeFinding[] {
  return analyzeLegendPractices({ sourceText: `${STORE}\n${body}`, fileName }).filter(
    (finding) => finding.action === "use-value-for-render-read",
  );
}

test("replaces a direct render initializer read with useValue", () => {
  const [finding] = renderReads(`
    export function Counter() {
      const value = state$.value.get();
      return <div>{value}</div>;
    }
  `);
  assert.equal(requireValue(finding).confidence, "certain");
  assert.equal(requireValue(finding).disposition, "change");
  assert.equal(requireValue(finding).location.line, 9);
  assert.match(
    requireValue(finding).message,
    /^Replace `state\$\.value\.get\(\)` with `useValue\(state\$\.value\)`; the read runs in `Counter` outside a tracking context/u,
  );
  assert.match(
    requireValue(finding).message,
    /`Counter` never re-renders when `state\$\.value` changes\.$/u,
  );
});

test("tells the agent to hoist a subscription for reads in JSX, conditionals, and iteration callbacks", () => {
  const findings = renderReads(`
    export function Screen({ rows }: { rows: string[] }) {
      if (!rows.length) {
        return <p>{state$.user.name.get()}</p>;
      }
      return (
        <ul>
          {rows.map((row) => (
            <li key={row}>{row}{state$.value.get()}</li>
          ))}
          <li>{state$.items.get().length}</li>
        </ul>
      );
    }
  `);
  assert.deepEqual(
    findings.map((finding) => finding.location.line),
    [10, 15, 17],
  );
  assert.match(
    requireValue(findings[0]).message,
    /^Subscribe with `const name = useValue\(state\$\.user\.name\)` at the top of `Screen` and read `name` here;/u,
  );
  assert.match(requireValue(findings[1]).message, /`const value = useValue\(state\$\.value\)`/u);
  assert.match(
    requireValue(findings[1]).evidence.join("\n"),
    /synchronous iteration callback of component `Screen`/u,
  );
  assert.match(requireValue(findings[2]).message, /`const items = useValue\(state\$\.items\)`/u);
});

test("avoids a suggested binding name that the owner already declares", () => {
  const [finding] = renderReads(`
    export function Screen() {
      const value = 1;
      return <div>{value}{state$.value.get()}</div>;
    }
  `);
  assert.match(requireValue(finding).message, /`const valueValue = useValue\(state\$\.value\)`/u);
});

test("flags untracked reads inside custom hooks and names the callers as the stale party", () => {
  const [finding] = renderReads(`
    export function useName() {
      return state$.user.name.get().trim();
    }
  `);
  assert.match(
    requireValue(finding).message,
    /components calling `useName` never re-render when `state\$\.user\.name` changes/u,
  );
});

test("flags reads of component-local, typed, and aliased observables", () => {
  const findings = renderReads(`
    import { useObservable } from "@legendapp/state/react";
    const name$ = state$.user.name;
    export function Form(draft$: Observable<{ title: string }>) {
      const local$ = useObservable({ open: false });
      return <div>{local$.open.get()}{draft$.title.get()}{name$.get()}</div>;
    }
  `);
  assert.deepEqual(
    findings.map(
      (finding) => /useValue\((?<path>[^)]+)\)/u.exec(finding.message)?.groups?.["path"],
    ),
    ["local$.open", "draft$.title", "name$"],
  );
});

test("does not flag reads inside observer components, whether wrapped inline, by name, or through memo", () => {
  assert.deepEqual(
    renderReads(`
      import { memo } from "react";
      import { observer, reactiveObserver } from "@legendapp/state/react";
      export const Inline = observer(function Inline() {
        return <div>{state$.value.get()}</div>;
      });
      export const Arrow = observer(() => <div>{state$.value.get()}</div>);
      function Named() {
        return <div>{state$.value.get()}</div>;
      }
      export default observer(Named);
      export const Memoized = memo(reactiveObserver(function Memoized() {
        return <div>{state$.value.get()}</div>;
      }));
    `),
    [],
  );
});

test("does not flag reads already covered by a useValue subscription in the same owner", () => {
  assert.deepEqual(
    renderReads(`
      import { useSelector } from "@legendapp/state/react";
      const user$ = state$.user;
      export function Covered() {
        const user = useValue(state$.user);
        const doubled = useValue(() => state$.value.get() * 2);
        const legacy = useSelector(state$.items);
        return <div>{user.name}{doubled}{legacy.length}{user$.name.get()}{state$.value.get()}{state$.items.get().length}</div>;
      }
    `),
    [],
  );
});

test("does not treat a child-path subscription as covering a parent read", () => {
  const findings = renderReads(`
    export function Partial() {
      const name = useValue(state$.user.name);
      return <div>{name}{String(state$.user.get())}</div>;
    }
  `);
  assert.equal(findings.length, 1);
  assert.match(requireValue(findings[0]).message, /useValue\(state\$\.user\)/u);
});

test("leaves reads in handlers, effects, selectors, reactive children, hook arguments, and keys alone", () => {
  assert.deepEqual(
    renderReads(`
      import { useEffect, useMemo, useState } from "react";
      import { Computed, Memo, Show, useObservable } from "@legendapp/state/react";
      import { $React } from "@legendapp/state/react-web";
      export function Quiet({ ids }: { ids: string[] }) {
        const [initial] = useState(state$.value.get());
        const draft$ = useObservable(() => state$.user.name.get());
        const memo = useMemo(() => state$.value.get(), []);
        const selected = useValue(() => state$.value.get() > 0);
        useEffect(() => {
          report(state$.value.get());
        }, []);
        const onClick = () => save(state$.user.name.get());
        const render = () => state$.value.get();
        return (
          <div onClick={onClick}>
            {initial}{memo}{String(selected)}{render()}
            <Computed>{() => state$.value.get()}</Computed>
            <Memo>{() => <b>{state$.user.name.get()}</b>}</Memo>
            <Show if={() => state$.value.get() > 0}>{() => <i>{state$.value.get()}</i>}</Show>
            <$React.div $className={() => (state$.value.get() > 0 ? "on" : "off")} />
            {ids.map((id) => <span key={state$.user.name.get()}>{id}</span>)}
            {Promise.resolve().then(() => state$.value.get())}
          </div>
        );
      }
    `),
    [],
  );
});

test("does not flag reads outside React render functions", () => {
  assert.deepEqual(
    renderReads(`
      export function increment() {
        state$.value.set(state$.value.get() + 1);
      }
      export const total = state$.items.get().length;
      export function lowercase() {
        return <div>{state$.value.get()}</div>;
      }
      export function Plain() {
        return state$.value.get();
      }
      export class Widget {
        Render() {
          return <div>{state$.value.get()}</div>;
        }
      }
    `),
    [],
  );
});

test("does not flag shallow or dynamically keyed reads", () => {
  assert.deepEqual(
    renderReads(`
      export function Shallow({ id }: { id: string }) {
        return <div>{state$.items.get(true).length}{state$.items[id].get()}</div>;
      }
    `),
    [],
  );
});
