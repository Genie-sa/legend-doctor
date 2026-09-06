import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("isolates a direct inline controlled-input setter", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    function Preview() { return null; }
    export function Form() {
      const [email, setEmail] = useState("");
      const submit = () => save(email);
      return <main>
        <Field value={email} onChange={event => setEmail(event.target.value)} />
        <Preview />
        <button onClick={submit}>Save</button>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
});

test("isolates a controlled input and its complete sibling validation projection", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    function Preview() { return null; }
    function Submit(_props: unknown) { return null; }
    export function Form() {
      const [query, setQuery] = useState("");
      const submit = () => save(query);
      return <main>
        <Preview />
        <Field value={query} onChange={event => setQuery(event.target.value)} />
        <Submit disabled={!query.trim()} onClick={submit} />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /derive validation from the subscribed value/u);
});

test("allows one pure validation alias shared with an event command", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    function Preview() { return null; }
    function Submit(_props: unknown) { return null; }
    export function Form() {
      const [name, setName] = useState("");
      const canSubmit = name.trim().length > 0;
      const submit = () => { if (canSubmit) save(name); };
      return <main>
        <Preview />
        <Field value={name} onChange={event => setName(event.target.value)} />
        <Submit disabled={!canSubmit} onClick={submit} />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
});

test("resolves a strict controlled-input setter adapter", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    function Preview() { return null; }
    function Submit(_props: unknown) { return null; }
    export function Form() {
      const [name, setName] = useState("");
      const handleNameChange = (event: { target: { value: string } }) => setName(event.target.value);
      const submit = () => save(name);
      return <main>
        <Preview />
        <Field value={name} onChange={handleNameChange} />
        <Submit disabled={name.trim().length === 0} onClick={submit} />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
});

test("keeps controlled ownership above a state-independent conditional field", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    function Preview() { return null; }
    function Submit(_props: unknown) { return null; }
    export function Form({ enabled }: { enabled: boolean }) {
      const [value, setValue] = useState("");
      const submit = () => save(value);
      return <main>
        <Preview />
        {enabled && <Field value={value} onChangeText={setValue} />}
        <Submit disabled={!value.trim()} onClick={submit} />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /owner-scoped observable/u);
});

test("does not isolate incomplete or nested validation projections", () => {
  for (const body of [
    `<main><Field value={value} onChangeText={setValue} /><Submit disabled={!value} /></main>`,
    `<main><Preview /><Form disabled={!value}><Field value={value} onChangeText={setValue} /></Form></main>`,
    `<main><Preview /><Field value={value} onChangeText={setValue} />{value && <Submit />}</main>`,
    `<main><Preview /><Field value={value} onChangeText={setValue} /><Submit disabled={validate(value)} /></main>`,
    `<main><Field value={value} onChangeText={setValue} /><Submit disabled={!value} /><button><span /></button></main>`,
  ]) {
    const [finding] = analyzeSource(
      `
      import { useState } from "react";
      function Field(_props: unknown) { return null; }
      function Form(_props: unknown) { return null; }
      function Preview() { return null; }
      function Submit(_props: unknown) { return null; }
      export function Owner() {
        const [value, setValue] = useState("");
        return ${body};
      }
    `,
      "fixture.tsx",
    );
    assert.notEqual(requireValue(finding).action, "use-observable", body);
  }
});

test("does not resolve a controlled setter adapter with additional work", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    function Preview() { return null; }
    function Submit(_props: unknown) { return null; }
    export function Form() {
      const [name, setName] = useState("");
      const handleNameChange = (event: { target: { value: string } }) => {
        setName(event.target.value);
        persistDraft();
      };
      return <main>
        <Preview />
        <Field value={name} onChange={handleNameChange} />
        <Submit disabled={!name.trim()} />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(requireValue(finding).action, "use-observable");
});

test("keeps owner rerenders when controlled input validity is read through a ref", () => {
  const [finding] = analyzeSource(
    `
    import { useRef, useState } from "react";
    function Field(_props: unknown) { return null; }
    function Preview() { return null; }
    function Submit(_props: unknown) { return null; }
    export function Form() {
      const form = useRef<HTMLFormElement>(null);
      const [name, setName] = useState("");
      const handleNameChange = (event: { target: { value: string } }) => setName(event.target.value);
      const isValid = form.current?.checkValidity();
      return <main>
        <Preview />
        <form ref={form}>
          <Field value={name} onChange={handleNameChange} />
          <Submit disabled={!isValid} />
        </form>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(requireValue(finding).action, "use-observable");
});

test("does not trace multi-hop validation aliases or repeated validation broadcasts", () => {
  for (const rendered of [
    `<main><Preview /><Field value={value} onChangeText={setValue} /><Submit disabled={!canSubmit} /></main>`,
    `<main><Preview /><Field value={value} onChangeText={setValue} />{rows.map(row => <Submit key={row.id} disabled={value !== row.id} />)}</main>`,
  ]) {
    const [finding] = analyzeSource(
      `
      import { useState } from "react";
      function Field(_props: unknown) { return null; }
      function Preview() { return null; }
      function Submit(_props: unknown) { return null; }
      export function Form({ rows }: { rows: Array<{ id: string }> }) {
        const [value, setValue] = useState("");
        const trimmed = value.trim();
        const canSubmit = trimmed.length > 0;
        return ${rendered};
      }
    `,
      "fixture.tsx",
    );
    assert.notEqual(requireValue(finding).action, "use-observable", rendered);
  }
});

test("does not isolate inline controlled setters with extra or scheduled work", () => {
  for (const handler of [
    `event => { setEmail(event.target.value); persistDraft(); }`,
    `event => setTimeout(() => setEmail(event.target.value), 0)`,
    `event => setEmail(normalize(event.target.value))`,
  ]) {
    const [finding] = analyzeSource(
      `
      import { useState } from "react";
      function Field(_props: unknown) { return null; }
      function Preview() { return null; }
      export function Form() {
        const [email, setEmail] = useState("");
        const submit = () => save(email);
        return <main>
          <Field value={email} onChange={${handler}} />
          <Preview />
          <button onClick={submit}>Save</button>
        </main>;
      }
    `,
      "fixture.tsx",
    );
    assert.notEqual(requireValue(finding).action, "use-observable");
  }
});
