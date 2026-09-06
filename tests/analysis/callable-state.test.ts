import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("traces local callable state reads invoked before JSX", () => {
  const [finding] = analyzeSource(
    `
    import { useCallback, useState } from "react";
    export function Form() {
      const [busy, setBusy] = useState(false);
      const canSubmit = useCallback(() => !busy, [busy]);
      const disabled = !canSubmit();
      return <Button disabled={disabled} onClick={() => setBusy(true)} />;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(requireValue(finding).action, "use-ref");
});

test("does not put callable React state into a mixed observable transport", () => {
  for (const state of [
    "const [Component, setComponent] = useState<React.ComponentType>(() => Fallback);",
    "const [callback, setCallback] = useState<() => void>(() => noop);",
    "type Callback = () => void; const [callback, setCallback] = useState<Callback>(() => noop);",
    "const [callback, setCallback] = useState(() => noop);",
  ]) {
    const name = state.includes("Component") ? "Component" : "callback";
    const setter = name === "Component" ? "setComponent" : "setCallback";
    const [finding] = analyzeSource(
      `
      import React, { useState } from "react";
      export function Screen() {
        ${state}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <Slot value={${name}} ready={${name} != null} onReset={() => ${setter}(() => noop)} />
        </main>;
      }
    `,
      "fixture.tsx",
    );
    assert.notEqual(requireValue(finding).action, "use-observable");
  }
});

test("keeps callable React state out of projection and sibling leaf rules", () => {
  for (const state of [
    {
      declaration: "const [value, setValue] = useState<(() => void) | null>(null);",
      write: "setValue(() => work)",
    },
    {
      declaration:
        "type Handler = () => void; const [value, setValue] = useState<Handler | null>(null);",
      write: "setValue(() => work)",
    },
    {
      declaration: "const [value, setValue] = useState(() => work);",
      write: "setValue(() => next)",
    },
    {
      declaration:
        "interface DialogState { id: string; onConfirm(): void } const [value, setValue] = useState<DialogState | null>(null);",
      write: "setValue({ id: 'x', onConfirm: work })",
    },
    {
      declaration: "const [value, setValue] = useState(null);",
      write: "setValue({ onConfirm: () => work() })",
    },
  ]) {
    const [finding] = analyzeSource(
      `
      import { useState } from "react";
      function work() {}
      function next() {}
      export function Screen() {
        ${state.declaration}
        return <main>
          <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <button onClick={() => ${state.write}}>Set</button>
          <section><Leaf ready={value != null} /></section>
        </main>;
      }
    `,
      "fixture.tsx",
    );
    assert.notEqual(requireValue(finding).action, "use-observable", state.declaration);
    assert.notEqual(requireValue(finding).action, "move-state-down", state.declaration);
  }
});

test("does not mistake ordinary local state aliases for callable state", () => {
  for (const alias of ["Selection", "FC", "ComponentType"]) {
    const [finding] = analyzeSource(
      `
      import { useState } from "react";
      type ${alias} = { id: string };
      export function Screen() {
        const [value, setValue] = useState<${alias} | null>(null);
        return <main>
          <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <button onClick={() => setValue({ id: "x" })}>Set</button>
          <section><Leaf ready={value != null} /></section>
        </main>;
      }
    `,
      "fixture.tsx",
    );
    assert.equal(requireValue(finding).action, "use-observable", alias);
  }
});

test("resolves callable aliases in the nearest lexical scope", () => {
  const findings = analyzeSource(
    `
    import { useState } from "react";
    function OtherScreen() {
      type Handler = string;
      const [value] = useState<Handler>("");
      return <output>{value}</output>;
    }
    export function Screen() {
      type Handler = () => void;
      const [value, setValue] = useState<Handler | null>(null);
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
        <button onClick={() => setValue(() => () => {})}>Set</button>
        <section><Leaf ready={value != null} /></section>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  const finding = findings.find(
    (candidate) => candidate.name === "value" && candidate.location.line > 8,
  );
  assert.notEqual(requireValue(finding).action, "use-observable");
  assert.notEqual(requireValue(finding).action, "move-state-down");
});

test("traces a state-backed local callable when JSX invokes it synchronously", () => {
  const [finding] = analyzeSource(
    `
    import { useCallback, useState } from "react";
    export function SaveForm() {
      const [busy, setBusy] = useState(false);
      const canSubmit = useCallback(() => !busy, [busy]);
      const submit = useCallback(async () => {
        if (!canSubmit()) return;
        setBusy(true);
        try { await save(); } finally { setBusy(false); }
      }, [canSubmit]);
      return <Panel><Header /><Body /><Summary /><Footer /><Button disabled={!canSubmit()} onPress={submit} /></Panel>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "review-state");
  assert.match(requireValue(finding).evidence.join(" ") ?? "", /reads: render 1/u);
});
