import { actions, requireValue } from "./harness.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

test("does not issue production state migrations for test harnesses", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    function Subject() { return null; }
    export function Harness() {
      const [value, setValue] = useState("");
      return <Subject value={value} onChange={setValue} />;
    }
  `,
    "Subject.test.tsx",
  );
  assert.equal(requireValue(finding).action, "keep-state");
  assert.equal(requireValue(finding).disposition, "keep");
});

test("does not issue production effect migrations for test harnesses", () => {
  const [finding] = analyzeSource(
    `
    import { useEffect } from "react";
    export function Harness({ observer, result }: { observer: () => void; result: string }) {
      useEffect(observer, [result]);
      return null;
    }
  `,
    "Subject.test.tsx",
  );
  assert.equal(requireValue(finding).action, "keep-effect");
  assert.equal(requireValue(finding).disposition, "keep");
});

test("does not delete derived state inside a test harness", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function Harness({ price, quantity }: { price: number; quantity: number }) {
      const [total, setTotal] = useState(0);
      useEffect(() => setTotal(price * quantity), [price, quantity]);
      return <output>{total}</output>;
    }
  `,
    "Harness.test.tsx",
  );
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["keep-state", "keep-effect"],
  );
});

test("does not migrate an effect-synchronized draft cluster inside a story harness", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function Profile({ initialName }: { initialName: string }) {
      const [name, setName] = useState(initialName);
      useEffect(() => { setName(initialName); }, [initialName]);
      return <main>
        <Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation /><Content />
        <input value={name} onChange={event => setName(event.target.value)} />
      </main>;
    }
  `,
    "Profile.stories.tsx",
  );
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["keep-state", "keep-effect"],
  );
});

test("recognizes aliased and namespace React hooks", () => {
  assert.deepEqual(
    actions(`
      import React, { useState as state } from "react";
      export function Example() {
        const [first] = state(1);
        const [second] = React.useState(2);
        return <>{first}{second}</>;
      }
    `),
    ["keep-state", "keep-state"],
  );
});

test("does not treat unrelated functions named useState as React hooks", () => {
  assert.deepEqual(
    actions(`
      function useState(value: number) { return [value, () => {}] as const; }
      export function Example() {
        const [value] = useState(1);
        return <>{value}</>;
      }
    `),
    [],
  );
});

test("reviews state transported through Context rather than treating Provider as a leaf", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Provider({ children }: { children: unknown }) {
        const [value, setValue] = useState(1);
        return <ValueContext.Provider value={{ value, setValue }}>{children}</ValueContext.Provider>;
      }
    `),
    ["review-state"],
  );
});

test("does not suggest a ref when a child renders the state and an owner handler reads it", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Form() {
        const [name, setName] = useState("");
        const submit = () => save(name);
        return <Input value={name} onChange={setName} onSubmit={submit} />;
      }
    `),
    ["review-state"],
  );
});

test("treats React Native host props as owner render reads", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      import { View } from "react-native";
      export function Field() {
        const [focused, setFocused] = useState(false);
        return <View style={styles.field(focused)} onFocus={() => setFocused(true)} />;
      }
    `),
    ["keep-state"],
  );
});

test("inventories nonstandard React useState bindings as review", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Example() {
        const tuple = useState(1);
        return <>{tuple[0]}</>;
      }
    `),
    ["review-state"],
  );
});

test("abstains when state is shadowed", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Example() {
        const [value, setValue] = useState(0);
        const callback = (value: number) => setValue(value);
        return <Child callback={callback} />;
      }
    `),
    ["review-state"],
  );
});

test("names the forced render when useState binds a setter but no value", () => {
  const [finding] = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function useEditorRevision(editor: { onChange: (run: () => void) => () => void }) {
      const [, setRevision] = useState(0);
      useEffect(() => editor.onChange(() => setRevision((current) => current + 1)), [editor]);
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).abstentionReason, "binding-shape-unsupported");
  assert.match(requireValue(finding).message, /`setRevision` has no value binding/u);
});

test("still reports an unrecognized state binding shape as such", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Example() {
      const pair = useState(0);
      return <span>{pair[0]}</span>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).abstentionReason, "binding-shape-unsupported");
  assert.match(requireValue(finding).message, /not a standard `\[value, setter\]` tuple/u);
});

test("a hook name rebound by a closer scope is not React's hook", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function makePanel(useState: (n: number) => [number, (n: number) => void]) {
        return function Panel() {
          const [unused, setUnused] = useState(0);
          return <button onClick={() => setUnused(1)}>go</button>;
        };
      }
    `),
    [],
  );
});

test("a hook name destructured from a local object is not React's hook", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Panel({ lib }: { lib: { useState: (n: number) => [number, (v: number) => void] } }) {
        const { useState } = lib;
        const [unused, setUnused] = useState(0);
        return <button onClick={() => setUnused(1)}>go</button>;
      }
    `),
    [],
  );
});

test("a sibling scope rebinding the name leaves React's hook recognized", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      function inject(useState: (n: number) => [number, (n: number) => void]) {
        return useState(0);
      }
      export function Panel() {
        const [count, setCount] = useState(0);
        return <button onClick={() => setCount(count + 1)}>{count}{inject.name}</button>;
      }
    `),
    ["keep-state"],
  );
});
