import { actions, requireValue } from "./harness.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

test("isolates a lazy-initialized value inside one stable JSX child callback", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    function ImageField(_props: unknown) { return null; }
    function FormField(_props: unknown) { return null; }
    function Details() { return null; }
    export function Screen() {
      const [preview, setPreview] = useState<string | null>(() => initialPreview());
      const chooseFile = () => {
        const reader = new FileReader();
        reader.onloadend = () => setPreview(reader.result as string);
      };
      return <main>
        <FormField>{field => <ImageField field={field} preview={preview} />}</FormField>
        <Details />
        <button onClick={chooseFile}>Choose</button>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /created exactly once/u);
  assert.match(requireValue(finding).message ?? "", /do not turn the initializer into a computed/u);
  assert.match(requireValue(finding).message ?? "", /ImageField/u);
});

test("keeps lazy callback transport without one stable independent leaf cut", () => {
  for (const body of [
    `<FormField>{field => <ImageField field={field} preview={preview} />}</FormField>`,
    `<main><VirtualList renderItem={() => <ImageField preview={preview} />} /><Details /></main>`,
    `<main>{rows.map(row => <FormField key={row.id}>{() => <ImageField preview={preview} />}</FormField>)}<Details /></main>`,
    `<main>{show && <FormField>{() => <ImageField preview={preview} />}</FormField>}<Details /></main>`,
  ]) {
    const [finding] = analyzeSource(
      `
      import { useState } from "react";
      function ImageField(_props: unknown) { return null; }
      function FormField(_props: unknown) { return null; }
      function Details() { return null; }
      function VirtualList(_props: unknown) { return null; }
      export function Screen({ rows, show }: { rows: Array<{ id: string }>; show: boolean }) {
        const [preview, setPreview] = useState<string | null>(() => initialPreview());
        const chooseFile = () => setPreview("next");
        return ${body};
      }
    `,
      "fixture.tsx",
    );
    assert.notEqual(requireValue(finding).action, "use-observable", body);
  }
});

test("does not put a lazy callable value into a nested observable leaf", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    function Slot(_props: unknown) { return null; }
    function Details() { return null; }
    export function Screen() {
      const [callback, setCallback] = useState<(() => void) | null>(() => null);
      return <main>
        <Slot>{() => <Field callback={callback} />}</Slot>
        <Details />
        <button onClick={() => setCallback(() => work)}>Set</button>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(requireValue(finding).action, "use-observable");
});

test("keeps a lazy callback leaf when its write command also invalidates the owner", () => {
  const findings = analyzeSource(
    `
    import { useState } from "react";
    function ImageField(_props: unknown) { return null; }
    function FormField(_props: unknown) { return null; }
    function Details(_props: unknown) { return null; }
    export function Screen() {
      const [preview, setPreview] = useState<string | null>(() => initialPreview());
      const [dirty, setDirty] = useState(false);
      const markDirty = () => setDirty(true);
      const chooseFile = () => {
        setPreview("next");
        markDirty();
      };
      return <main>
        <FormField>{() => <ImageField preview={preview} />}</FormField>
        <Details dirty={dirty} />
        <button onClick={chooseFile}>Choose</button>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  const preview = findings.find((finding) => finding.name === "preview");
  assert.notEqual(requireValue(preview).action, "use-observable");
});

test("migrates broad transported state together with the companion that invalidates the owner", () => {
  const padding = "\n".repeat(150);
  const findings = analyzeSource(
    `
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    export function Screen() {
      const [value, setValue] = useState("");
      const [dirty, setDirty] = useState(false);
      const change = () => { setValue("next"); setDirty(true); };
      ${padding}
      return <main>
        <button onClick={change}>Change</button>
        <Field value={value} /><Field value={value} />
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Preview />
        {dirty && <Save />}
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.name === "value")).action,
    "use-observable",
  );
});

test("migrates a broad transported preview with its companion transition as one group", () => {
  const padding = "\n".repeat(150);
  const findings = analyzeSource(
    `
    import { useState } from "react";
    function ImageField(_props: unknown) { return null; }
    export function Screen() {
      const [preview, setPreview] = useState<string | null>(null);
      const [role, setRole] = useState("user");
      const changeRole = () => { setRole("admin"); setPreview(null); };
      const chooseFile = (reader: FileReader) => {
        reader.onloadend = () => { setPreview(reader.result as string); };
      };
      ${padding}
      return <main>
        <button onClick={changeRole}>Role</button>
        <button onClick={() => chooseFile(new FileReader())}>Choose</button>
        <ImageField preview={preview} /><ImageField preview={preview} />
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Preview />
        <span>{role}</span>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.name === "preview")).action,
    "use-observable",
  );
});

test("keeps setter-less lazy state as stable component resource ownership", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Panel() {
        const [store] = useState(() => createStore());
        return <><Toolbar store={store} /><Table store={store} /></>;
      }
    `),
    ["keep-state"],
  );
});
