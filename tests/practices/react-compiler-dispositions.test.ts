import type { FileCapabilities } from "../../src/project/capabilities.js";
import type { LegendPracticeFinding } from "../../src/core/types.js";
import { NO_CAPABILITIES } from "../../src/project/capabilities.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

const COMPILED: FileCapabilities = { ...NO_CAPABILITIES, reactCompiler: true };

const STORE = `
  import { observable } from "@legendapp/state";
  const state$ = observable({ count: 0, name: "", visible: true });
`;

function dispositions(
  action: LegendPracticeFinding["action"],
  body: string,
  capabilities: FileCapabilities = COMPILED,
): string[] {
  return analyzeLegendPractices({
    capabilities,
    fileName: "fixture.tsx",
    sourceText: `${STORE}\n${body}`,
  })
    .filter((finding) => finding.action === action)
    .map((finding) => finding.disposition);
}

function legacyDispositions(body: string, capabilities?: FileCapabilities): string[] {
  return dispositions("replace-legacy-use-value", body, capabilities);
}

function renderReadFindings(
  body: string,
  capabilities: FileCapabilities = COMPILED,
): LegendPracticeFinding[] {
  return analyzeLegendPractices({
    capabilities,
    fileName: "fixture.tsx",
    sourceText: `${STORE}\nimport { observer, useValue } from "@legendapp/state/react";\n${body}`,
  }).filter((finding) => finding.action === "use-value-for-render-read");
}

const USE$_COMPONENT = `
  import { use$ } from "@legendapp/state/react";
  export function Counter() {
    const count = use$(state$.count);
    return <span>{count}</span>;
  }
`;

test("a use$ call in a compiled component is a change that names the Compiler's hook rule", () => {
  const [finding] = analyzeLegendPractices({
    capabilities: COMPILED,
    fileName: "fixture.tsx",
    sourceText: `${STORE}\n${USE$_COMPONENT}`,
  });
  assert.equal(requireValue(finding).disposition, "change");
  assert.match(requireValue(finding).message, /React Compiler does not treat `use\$` as a hook/u);
  assert.ok(requireValue(finding).evidence.some((line) => line.includes("/^use[A-Z0-9]/")));
});

test("the same use$ call stays style when the file is not compiled", () => {
  assert.deepEqual(legacyDispositions(USE$_COMPONENT, NO_CAPABILITIES), ["style"]);
});

test("callees the Compiler already treats as hooks stay style", () => {
  assert.deepEqual(
    legacyDispositions(`
      import { useSelector, useSelector as select$, use$ as useLegend } from "@legendapp/state/react";
      export function Counter() {
        const count = useSelector(state$.count);
        const name = select$(state$.name);
        const visible = useLegend(state$.visible);
        return <span>{count}{name}{visible}</span>;
      }
    `),
    ["style", "style", "style"],
  );
});

test("namespace calls follow the property name", () => {
  assert.deepEqual(
    legacyDispositions(`
      import * as LegendReact from "@legendapp/state/react";
      export function Counter() {
        const count = LegendReact.use$(state$.count);
        const name = LegendReact.useSelector(state$.name);
        return <span>{count}{name}</span>;
      }
    `),
    ["change", "style"],
  );
});

test("only a prologue opt-out directive keeps the file or the function uncompiled", () => {
  const optedOut = analyzeLegendPractices({
    capabilities: COMPILED,
    fileName: "fixture.tsx",
    sourceText: `"use no memo";\n${STORE}\n${USE$_COMPONENT}`,
  });
  assert.deepEqual(
    optedOut.map((finding) => finding.disposition),
    ["style"],
  );
  assert.deepEqual(legacyDispositions(`"use no memo";\n${USE$_COMPONENT}`), ["change"]);
  assert.deepEqual(
    legacyDispositions(`
      import { use$ } from "@legendapp/state/react";
      export function Counter() {
        "use no memo";
        const count = use$(state$.count);
        return <span>{count}</span>;
      }
      export function Name() {
        const name = use$(state$.name);
        return <span>{name}</span>;
      }
    `),
    ["style", "change"],
  );
});

test("ESLint hook-rule suppressions follow the Compiler's ranges", () => {
  assert.deepEqual(
    legacyDispositions(`
      import { use$ } from "@legendapp/state/react";
      export function Counter() {
        // eslint-disable-next-line react-hooks/exhaustive-deps
        const count = use$(state$.count);
        return <span>{count}</span>;
      }
      export function Name() {
        const name = use$(state$.name);
        return <span>{name}</span>;
      }
    `),
    ["style", "change"],
  );
  assert.deepEqual(
    legacyDispositions(`${USE$_COMPONENT}\n/* eslint-disable react-hooks/rules-of-hooks */`),
    ["style"],
  );
  assert.deepEqual(
    legacyDispositions(
      `${USE$_COMPONENT}\n// eslint-disable-next-line no-console\nconsole.log(1);`,
    ),
    ["change"],
  );
});

test("only functions the Compiler infers as components or hooks are compiled", () => {
  assert.deepEqual(
    legacyDispositions(`
      import { memo, useState } from "react";
      import { observer, use$ } from "@legendapp/state/react";
      export const Wrapped = observer(() => <span>{use$(state$.count)}</span>);
      export const Named = observer(function Named() { return <span>{use$(state$.count)}</span>; });
      export const Memoized = memo(() => <span>{use$(state$.count)}</span>);
      export function useCount() { return use$(state$.count); }
      export function useStatefulCount() { const [extra] = useState(0); return use$(state$.count) + extra; }
      export function helper() { "use memo"; return use$(state$.count); }
      export function TwoArgs(props: object, context: object) { return <span>{use$(state$.count)}</span>; }
      export function StringProps(label: string) { return <span>{use$(state$.count)}{label}</span>; }
      export function ReturnsObject() { const count = use$(state$.count); return { count }; }
      class Legacy { render() { return <span>{use$(state$.count)}</span>; } }
    `),
    ["style", "style", "change", "style", "change", "change", "style", "style", "style", "style"],
  );
});

test("an outer compiled function lowers the functions inside it", () => {
  assert.deepEqual(
    legacyDispositions(`
      import { use$ } from "@legendapp/state/react";
      export function Outer() {
        function Inner() { return <span>{use$(state$.count)}</span>; }
        return <Inner />;
      }
    `),
    ["style"],
  );
});

test("a compiled observer component's rendered get() is a change to useValue", () => {
  const body = `
    function Counter() {
      const count = state$.count.get();
      return <span>{count}</span>;
    }
    export default observer(Counter);
  `;
  const [finding] = renderReadFindings(body);
  assert.equal(requireValue(finding).disposition, "change");
  assert.deepEqual(
    requireValue(finding).edits?.map((edit) => edit.newText),
    ["useValue(state$.count)"],
  );
  assert.match(
    requireValue(finding).message,
    /React Compiler memoizes this get\(\) inside observer/u,
  );
  assert.deepEqual(
    renderReadFindings(body, NO_CAPABILITIES).map((read) => read.disposition),
    ["style"],
  );
});

test("a compiled observer component's JSX get() asks for a subscription", () => {
  const body = `
    function Counter({ ready }: { ready: boolean }) {
      return ready ? <span>{state$.count.get()}</span> : null;
    }
    export default observer(Counter);
  `;
  const [finding] = renderReadFindings(body);
  assert.equal(requireValue(finding).disposition, "change");
  assert.match(
    requireValue(finding).message,
    /^Subscribe with `const count = useValue\(state\$\.count\)`/u,
  );
  assert.deepEqual(renderReadFindings(body, NO_CAPABILITIES), []);
});

test("observer reads the Compiler does not memoize keep their prior disposition", () => {
  assert.deepEqual(
    renderReadFindings(`
      export const Inline = observer(function Inline() {
        const count = state$.count.get();
        return <span>{count}</span>;
      });
      function Gate() {
        const visible = state$.visible.get();
        if (!visible) {
          return null;
        }
        return <span />;
      }
      export const GateView = observer(Gate);
      function Label() {
        const name = state$.name.get();
        return <span>{\`\${name}!\`}</span>;
      }
      export const LabelView = observer(Label);
    `).map((finding) => finding.disposition),
    ["style", "style", "style"],
  );
});
