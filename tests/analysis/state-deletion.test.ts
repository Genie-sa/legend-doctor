import { actions, requireValue } from "./harness.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

test("deletes a pure derivation state and effect pair", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useState } from "react";
      export function Name({ first, last }: { first: string; last: string }) {
        const [fullName, setFullName] = useState(first + " " + last);
        useEffect(() => { setFullName(first + " " + last); }, [first, last]);
        return <span>{fullName}</span>;
      }
    `),
    ["delete-derived-state", "delete-effect"],
  );
});

test("deletes derived state only when transparent inputs match effect dependencies", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useState } from "react";
      export function Status({ login }: { login: { validated?: boolean; error?: string } }) {
        const [visible, setVisible] = useState(!login.validated);
        useEffect(() => { setVisible(!login.validated); }, [login.validated, login.error]);
        return <span>{String(visible)}</span>;
      }
    `),
    ["delete-derived-state", "delete-effect"],
  );
});

test("keeps effects whose assigned value is not a transparent dependency derivation", () => {
  for (const [body, dependencies] of [
    [`setValue(first)`, `[other]`],
    [`setValue(model.value)`, `[model]`],
    [`setValue({ text: first })`, `[first]`],
    [`setValue(true)`, `[other]`],
  ]) {
    assert.deepEqual(
      actions(`
        import { useEffect, useState } from "react";
        export function Screen({ first, other, model }: {
          first: string;
          other: string;
          model: { value: string };
        }) {
          const [value, setValue] = useState<unknown>(null);
          useEffect(() => { ${body}; }, ${dependencies});
          return <output>{String(value)}</output>;
        }
      `),
      ["keep-state", "keep-effect"],
      body,
    );
  }
});

test("does not leak a derived-state deletion across sibling component bindings", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function Interactive() {
      const [value, setValue] = useState("");
      return <input value={value} onChange={event => setValue(event.target.value)} />;
    }
    export function Derived({ input }: { input: string }) {
      const [value, setValue] = useState(input + "!");
      useEffect(() => { setValue(input + "!"); }, [input]);
      return <span>{value}</span>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(findings.filter((finding) => finding.action === "delete-derived-state").length, 1);
  assert.equal(findings.filter((finding) => finding.action === "delete-effect").length, 1);
});

test("does not confuse a sibling state setter with an external subscription", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function Form() {
      const [flag, subscribe] = useState(false);
      return <button onClick={() => subscribe(true)}>{String(flag)}</button>;
    }
    export function Bridge({ subscribe }: { subscribe: () => () => void }) {
      useEffect(() => subscribe(), [subscribe]);
      return null;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.hook === "useEffect")).action,
    "keep-effect",
  );
});

test("does not let a sibling setter suppress a module-global mount candidate", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    import { warmCache } from "./cache";
    export function Form() {
      const [ready, warmCache] = useState(false);
      return <button onClick={() => warmCache(true)}>{String(ready)}</button>;
    }
    export function App() {
      useEffect(() => { warmCache(); }, []);
      return null;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.hook === "useEffect")).action,
    "use-mount",
  );
});

test("does not call a resettable state value derived", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useState } from "react";
      export function Results({ filter }: { filter: string }) {
        const [page, setPage] = useState(1);
        useEffect(() => { setPage(1); }, [filter]);
        return <Pager page={page} onChange={setPage} />;
      }
    `),
    ["review-state", "review-effect"],
  );
});

test("keeps invariant same-value state non-actionable", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Image() {
        const [_hasError, setHasError] = useState(false);
        const retry = () => setHasError(false);
        return <Button onPress={retry} />;
      }
    `),
    ["review-state"],
  );
});

test("deletes state whose only reads calculate inert arguments for its own setter", () => {
  const findings = analyzeSource(
    `
    import { useState } from "react";
    export function Picker({ next }: { next: string }) {
      const [choice, setChoice] = useState("");
      const [called, setCalled] = useState("");
      const [published, setPublished] = useState("");
      return <><Button onPress={() => setChoice(next === choice ? "" : next)} />
        <Button onPress={() => setCalled(normalize(called))} />
        <Button onPress={() => { setPublished(next === published ? "" : next); save(published); }} /></>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.name === "choice")).action,
    "delete-unused-state",
  );
  assert.notEqual(
    requireValue(findings.find((finding) => finding.name === "called")).action,
    "delete-unused-state",
  );
  assert.notEqual(
    requireValue(findings.find((finding) => finding.name === "published")).action,
    "delete-unused-state",
  );
});

test("deletes setter-only state written by an effect when arguments are discardable", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function Resource() {
      const [_failed, setFailed] = useState(false);
      useEffect(() => { setFailed(false); start().catch(() => setFailed(true)); }, []);
      return <Content />;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.name === "_failed")).action,
    "delete-unused-state",
  );
});

test("does not delete setter-only state when removing the call would erase evaluation", () => {
  for (const write of ["recordAndReturnValue()", "++sequence", "+source"]) {
    assert.deepEqual(
      actions(`
      import { useState } from "react";
      let sequence = 0;
      export function Resource() {
        const [_value, setValue] = useState(0);
        return <button onClick={() => setValue(${write})}>Run</button>;
      }
      `),
      ["review-state"],
    );
  }
});

test("preserves property evaluation while deleting otherwise unused state", () => {
  const finding = analyzeSource(
    `
    import { useState } from "react";
    export function Resource({ source }: { source: { value: number } }) {
      const [_value, setValue] = useState(0);
      return <Button onPress={() => setValue(source.value)} />;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.hook === "useState");
  assert.equal(requireValue(finding).action, "delete-unused-state");
  assert.match(requireValue(finding).message ?? "", /evaluation.*preserved/iu);
});

test("does not delete unused state when removing its initializer would erase evaluation", () => {
  const finding = analyzeSource(
    `
    import { useState } from "react";
    export function Resource() {
      const [_value, setValue] = useState(loadInitialValue());
      return <Button onPress={() => setValue(0)} />;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.hook === "useState");
  assert.notEqual(requireValue(finding).action, "delete-unused-state");
});

test("does not delete setter-only state when an updater consumes the previous value", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Counter() {
        const [_count, setCount] = useState(0);
        const increment = () => setCount(previous => previous + 1);
        return <Button onPress={increment} />;
      }
    `),
    ["review-state"],
  );
});
