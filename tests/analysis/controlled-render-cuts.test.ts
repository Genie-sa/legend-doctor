import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("keeps a controlled child without an independent render-cut witness", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    export function FieldOwner() {
      const [value, setValue] = useState("");
      return <Field value={value} onChangeText={setValue} />;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "keep-state");
});

test("uses independent host siblings as a controlled render-cut witness", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    export function Form() {
      const [format, setFormat] = useState("csv");
      const submit = () => save(format);
      return <main>
        <Field value={format} onChange={setFormat} />
        <hr />
        <button onClick={submit}>Export</button>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
});

test("uses an unresolved JSX component sibling as a controlled render-cut witness", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    import { SummaryPanel } from "./summary-panel";
    function Field(_props: unknown) { return null; }
    export function Form() {
      const [value, setValue] = useState("");
      const submit = () => save(value);
      return <>
        <Field value={value} onChange={setValue} />
        <SummaryPanel onSubmit={submit} />
      </>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
});

test("does not treat a Fragment as an independent component boundary", () => {
  const [finding] = analyzeSource(
    `
    import React, { useState } from "react";
    function Field(_props: unknown) { return null; }
    export function Form() {
      const [value, setValue] = useState("");
      return <>
        <Field value={value} onChange={setValue} />
        <React.Fragment>
          <button onClick={() => save(value)}>Save</button>
        </React.Fragment>
      </>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "review-state");
});

test("treats a local helper invoked by a JSX event as a deferred command", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    function Preview() { return null; }
    export function Form() {
      const [value, setValue] = useState("");
      const commit = () => save(value);
      return <main>
        <Field value={value} onChangeText={setValue} onBlur={() => commit()} />
        <Preview />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
});

test("does not split a controlled state transaction inside a compact owner", () => {
  const findings = analyzeSource(
    `
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    function Preview() { return null; }
    export function Range() {
      const [min, setMin] = useState(0);
      const [max, setMax] = useState(10);
      const normalize = () => { setMin(max); setMax(min); };
      return <main>
        <Field value={min} onChange={setMin} onBlur={normalize} />
        <Field value={max} onChange={setMax} onBlur={normalize} />
        <Preview />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(findings.filter((finding) => finding.action === "use-observable").length, 0);
});

test("isolates a controlled edit path even when a separate reset co-writes sibling state", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Form() {
      const [name, setName] = useState("");
      const [dirty, setDirty] = useState(false);
      const reset = () => { setName(""); setDirty(false); };
      const submit = () => save(name);
      return <Page><Header /><Summary /><Help /><Preview /><Footer /><Actions onReset={reset} onSubmit={submit} />
        <Input value={name} onChange={event => setName(event.target.value)} />
        <Status dirty={dirty} /><Sidebar /><Banner /><Navigation /><Details />
      </Page>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /controlled state/u);
});

test("does not call a multi-command input callback an independent controlled edit", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Form() {
      const [name, setName] = useState("");
      const [dirty, setDirty] = useState(false);
      const reset = () => { setName(""); setDirty(false); };
      const submit = () => save(name);
      return <Page><Header /><Summary /><Help /><Preview /><Footer /><Actions onReset={reset} onSubmit={submit} />
        <Input value={name} onChange={event => { setName(event.target.value); setDirty(true); }} />
        <Status dirty={dirty} /><Sidebar /><Banner /><Navigation /><Details />
      </Page>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "review-state");
});

test("does not use dead JSX or a controlled-child ancestor as a render-cut witness", () => {
  const [dead] = analyzeSource(
    `
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    function Preview() { return null; }
    export function Form() {
      const [value, setValue] = useState("");
      const unused = <Preview />;
      return <Field value={value} onChangeText={setValue} />;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(requireValue(dead).action, "use-observable");

  const [ancestor] = analyzeSource(
    `
    import { useState } from "react";
    function FormShell(_props: unknown) { return null; }
    function Field(_props: unknown) { return null; }
    export function Form() {
      const [value, setValue] = useState("");
      return <FormShell><Field value={value} onChangeText={setValue} /></FormShell>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(requireValue(ancestor).action, "use-observable");
});
