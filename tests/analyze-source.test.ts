import assert from "node:assert/strict";
import test from "node:test";

import { analyzeSource } from "../src/analyze-source.js";
import { agentFindings } from "../src/format.js";

function actions(source: string): string[] {
  return analyzeSource(source, "fixture.tsx").map(finding => finding.action);
}

test("keeps state rendered by its owner", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Counter() {
        const [count, setCount] = useState(0);
        return <button onClick={() => setCount(count + 1)}>{count}</button>;
      }
    `),
    ["keep-state"]
  );
});

test("isolates direct controlled child state when a sibling proves an owner render cut", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    function Preview() { return null; }
    export function Form() {
      const [value, setValue] = useState("");
      const submit = () => save(value);
      return <main><Field value={value} onChangeText={setValue} /><Preview /><button onClick={submit} /></main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /non-tracking reads in submit or commit commands/);
});

test("recognizes standard boolean controlled-child callbacks", () => {
  for (const callback of ["onCheckedChange", "onToggle"]) {
    const [finding] = analyzeSource(`
      import { useState } from "react";
      function Switch(_props: unknown) { return null; }
      function Preview() { return null; }
      export function Form() {
        const [enabled, setEnabled] = useState(false);
        const submit = () => save(enabled);
        return <main>
          <Switch checked={enabled} ${callback}={setEnabled} />
          <Preview />
          <button onClick={submit}>Save</button>
        </main>;
      }
    `, "fixture.tsx");
    assert.equal(finding?.action, "use-observable", callback);
  }
});

test("recognizes descriptive value-transition callbacks on controlled leaves", () => {
  for (const callback of ["onInputChange", "onSelectCover", "onDashboardNameChange"]) {
    const [finding] = analyzeSource(`
      import { useState } from "react";
      function Field(_props: unknown) { return null; }
      function Preview() { return null; }
      export function Form() {
        const [value, setValue] = useState("");
        const submit = () => save(value);
        return <main>
          <Field value={value} ${callback}={setValue} />
          <Preview />
          <button onClick={submit}>Save</button>
        </main>;
      }
    `, "fixture.tsx");
    assert.equal(finding?.action, "use-observable", callback);
  }
});

test("moves call-site-owned custom controlled state into that leaf", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    function Filter(_props: unknown) { return null; }
    function Preview() { return null; }
    export function Header() {
      const [open, setOpen] = useState(false);
      return <main>
        <Filter open={open} onOpenChange={() => setOpen(!open)} />
        <Preview />
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "move-state-down");
});

test("does not split custom controlled fields that share one validation projection", () => {
  const findings = analyzeSource(`
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    function Submit(_props: unknown) { return null; }
    function Preview() { return null; }
    export function Form() {
      const [title, setTitle] = useState("");
      const [message, setMessage] = useState("");
      const valid = title.trim().length > 0 && message.trim().length > 0;
      const submit = () => save(title, message);
      return <main>
        <Field value={title} onChangeTitle={setTitle} />
        <Field value={message} onChangeMessage={setMessage} />
        <Submit disabled={!valid} onClick={submit} />
        <Preview />
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(findings.filter(finding => finding.action === "use-observable").length, 0);
});

test("does not treat arbitrary callback props as controlled value transitions", () => {
  for (const callback of ["onClick", "onSubmit", "register", "renderValue"]) {
    const [finding] = analyzeSource(`
      import { useState } from "react";
      function Field(_props: unknown) { return null; }
      function Preview() { return null; }
      export function Form() {
        const [value, setValue] = useState("");
        const submit = () => save(value);
        return <main><Field value={value} ${callback}={setValue} /><Preview /><button onClick={submit} /></main>;
      }
    `, "fixture.tsx");
    assert.notEqual(finding?.action, "use-observable", callback);
  }
});

test("isolates a direct inline controlled-input setter", () => {
  const [finding] = analyzeSource(`
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
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
});

test("isolates a controlled input and its complete sibling validation projection", () => {
  const [finding] = analyzeSource(`
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
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /derive validation from the subscribed value/);
});

test("allows one pure validation alias shared with an event command", () => {
  const [finding] = analyzeSource(`
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
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
});

test("resolves a strict controlled-input setter adapter", () => {
  const [finding] = analyzeSource(`
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
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
});

test("keeps controlled ownership above a state-independent conditional field", () => {
  const [finding] = analyzeSource(`
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
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /owner-scoped observable/);
});

test("keeps controlled ownership above state-independent early returns", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    function Header() { return null; }
    function NotFound() { return null; }
    export function Form({ missing }: { missing: boolean }) {
      const [value, setValue] = useState("");
      const submit = () => save(value);
      if (missing) return <NotFound />;
      return <main>
        <Header />
        <Field value={value} onChangeText={setValue} onBlur={submit} />
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /controlled state/);
});

test("isolates a controlled leaf in one of several prop-selected returns", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    function Header() { return null; }
    function Alternative() { return null; }
    export function Form({ mode }: { mode: "edit" | "other" }) {
      const [value, setValue] = useState("");
      const submit = () => save(value);
      if (mode !== "edit") return <Alternative />;
      return <main><Header /><Field value={value} onChange={setValue} onBlur={submit} /></main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
});

test("does not use a stored controlled JSX value as a branch callsite", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    function Header() { return null; }
    export function Form({ disabled }: { disabled: boolean }) {
      const [value, setValue] = useState("");
      const field = <Field value={value} onChangeText={setValue} />;
      if (disabled) return <Header />;
      return <main><Header />{field}</main>;
    }
  `, "fixture.tsx");
  assert.notEqual(finding?.action, "use-observable");
});

test("does not call a state-controlled early return a controlled leaf", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    function Empty(_props: unknown) { return null; }
    function Header() { return null; }
    export function Form() {
      const [value, setValue] = useState("");
      if (!value) return <Empty onStart={() => setValue("start")} />;
      return <main><Header /><Field value={value} onChangeText={setValue} /></main>;
    }
  `, "fixture.tsx");
  assert.doesNotMatch(finding?.message ?? "", /Replace controlled state/);
});

test("does not split one controlled value across alternate return branches", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    function CompactField(_props: unknown) { return null; }
    function FullField(_props: unknown) { return null; }
    function Header() { return null; }
    export function Form({ compact }: { compact: boolean }) {
      const [value, setValue] = useState("");
      if (compact) return <CompactField value={value} onChangeText={setValue} />;
      return <main><Header /><FullField value={value} onChangeText={setValue} /></main>;
    }
  `, "fixture.tsx");
  assert.notEqual(finding?.action, "use-observable");
});

test("does not isolate incomplete or nested validation projections", () => {
  for (const body of [
    `<main><Field value={value} onChangeText={setValue} /><Submit disabled={!value} /></main>`,
    `<main><Preview /><Form disabled={!value}><Field value={value} onChangeText={setValue} /></Form></main>`,
    `<main><Preview /><Field value={value} onChangeText={setValue} />{value && <Submit />}</main>`,
    `<main><Preview /><Field value={value} onChangeText={setValue} /><Submit disabled={validate(value)} /></main>`,
    `<main><Field value={value} onChangeText={setValue} /><Submit disabled={!value} /><button><span /></button></main>`,
  ]) {
    const [finding] = analyzeSource(`
      import { useState } from "react";
      function Field(_props: unknown) { return null; }
      function Form(_props: unknown) { return null; }
      function Preview() { return null; }
      function Submit(_props: unknown) { return null; }
      export function Owner() {
        const [value, setValue] = useState("");
        return ${body};
      }
    `, "fixture.tsx");
    assert.notEqual(finding?.action, "use-observable", body);
  }
});

test("does not resolve a controlled setter adapter with additional work", () => {
  const [finding] = analyzeSource(`
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
  `, "fixture.tsx");
  assert.notEqual(finding?.action, "use-observable");
});

test("keeps owner rerenders when controlled input validity is read through a ref", () => {
  const [finding] = analyzeSource(`
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
  `, "fixture.tsx");
  assert.notEqual(finding?.action, "use-observable");
});

test("does not trace multi-hop validation aliases or repeated validation broadcasts", () => {
  for (const rendered of [
    `<main><Preview /><Field value={value} onChangeText={setValue} /><Submit disabled={!canSubmit} /></main>`,
    `<main><Preview /><Field value={value} onChangeText={setValue} />{rows.map(row => <Submit key={row.id} disabled={value !== row.id} />)}</main>`,
  ]) {
    const [finding] = analyzeSource(`
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
    `, "fixture.tsx");
    assert.notEqual(finding?.action, "use-observable", rendered);
  }
});

test("does not isolate inline controlled setters with extra or scheduled work", () => {
  for (const handler of [
    `event => { setEmail(event.target.value); persistDraft(); }`,
    `event => setTimeout(() => setEmail(event.target.value), 0)`,
    `event => setEmail(normalize(event.target.value))`,
  ]) {
    const [finding] = analyzeSource(`
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
    `, "fixture.tsx");
    assert.doesNotMatch(finding?.message ?? "", /async pending flag/);
  }
});

test("does not isolate a controlled child without an independent render-cut witness", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    export function FieldOwner() {
      const [value, setValue] = useState("");
      return <Field value={value} onChangeText={setValue} />;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "review-state");
});

test("uses independent host siblings as a controlled render-cut witness", () => {
  const [finding] = analyzeSource(`
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
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
});

test("treats a local helper invoked by a JSX event as a deferred command", () => {
  const [finding] = analyzeSource(`
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
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
});

test("does not split a controlled state transaction across independent migrations", () => {
  const findings = analyzeSource(`
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
  `, "fixture.tsx");
  assert.equal(findings.filter(finding => finding.action === "use-observable").length, 0);
});

test("isolates a controlled edit path even when a separate reset co-writes sibling state", () => {
  const [finding] = analyzeSource(`
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
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /controlled state/);
});

test("does not call a multi-command input callback an independent controlled edit", () => {
  const [finding] = analyzeSource(`
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
  `, "fixture.tsx");
  assert.equal(finding?.action, "review-state");
});

test("does not use dead JSX or a controlled-child ancestor as a render-cut witness", () => {
  const dead = analyzeSource(`
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    function Preview() { return null; }
    export function Form() {
      const [value, setValue] = useState("");
      const unused = <Preview />;
      return <Field value={value} onChangeText={setValue} />;
    }
  `, "fixture.tsx")[0];
  assert.notEqual(dead?.action, "use-observable");

  const ancestor = analyzeSource(`
    import { useState } from "react";
    function FormShell(_props: unknown) { return null; }
    function Field(_props: unknown) { return null; }
    export function Form() {
      const [value, setValue] = useState("");
      return <FormShell><Field value={value} onChangeText={setValue} /></FormShell>;
    }
  `, "fixture.tsx")[0];
  assert.notEqual(ancestor?.action, "use-observable");
});

test("does not isolate controlled state with a render-phase setter", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    function Preview() { return null; }
    export function Form({ reset }: { reset: boolean }) {
      const [value, setValue] = useState("");
      if (reset && value) setValue("");
      return <main><Field value={value} onChangeText={setValue} /><Preview /></main>;
    }
  `, "fixture.tsx");
  assert.notEqual(finding?.action, "use-observable");
});

test("does not isolate controlled state read by an effect-like lifecycle hook", () => {
  const source = (hookImport: string, hookCall: string) => analyzeSource(`
    import { useState, ${hookImport} } from "react";
    function Field(_props: unknown) { return null; }
    function Preview() { return null; }
    export function Form() {
      const [value, setValue] = useState("");
      ${hookCall}(() => save(value), [value]);
      return <main><Field value={value} onChangeText={setValue} /><Preview /></main>;
    }
  `, "fixture.tsx")[0];
  assert.notEqual(source("useLayoutEffect", "useLayoutEffect")?.action, "use-observable");
  assert.notEqual(source("useInsertionEffect as useInsert", "useInsert")?.action, "use-observable");
});

test("does not isolate controlled state captured by timers or subscriptions", () => {
  for (const root of ["subscribe(listener)", "setInterval(listener, 100)", "useFocusEffect(listener)"]) {
    const [finding] = analyzeSource(`
      import { useState } from "react";
      function Field(_props: unknown) { return null; }
      function Preview() { return null; }
      export function Form() {
        const [value, setValue] = useState("");
        const listener = () => sync(value);
        ${root};
        return <main><Field value={value} onChangeText={setValue} /><Preview /></main>;
      }
    `, "fixture.tsx");
    assert.notEqual(finding?.action, "use-observable");
  }
});

test("does not change stale useCallback snapshot semantics", () => {
  const [finding] = analyzeSource(`
    import { useCallback, useState } from "react";
    function Field(_props: unknown) { return null; }
    function Preview() { return null; }
    export function Form() {
      const [value, setValue] = useState("");
      const submit = useCallback(() => save(value), []);
      return <main><Field value={value} onChangeText={setValue} /><Preview /><button onClick={submit} /></main>;
    }
  `, "fixture.tsx");
  assert.notEqual(finding?.action, "use-observable");
});

test("migrates a complete effect-synchronized draft while preserving the effect", () => {
  const findings = analyzeSource(`
    import { useEffect, useState } from "react";
    export function Profile({ initialName }: { initialName: string }) {
      const [name, setName] = useState(initialName);
      useEffect(() => { setName(initialName); }, [initialName]);
      return <main>
        <Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation /><Content />
        <input value={name} onChange={event => setName(event.target.value)} />
      </main>;
    }
  `, "fixture.tsx");
  assert.deepEqual(findings.map(finding => finding.action), ["use-observable", "review-effect"]);
  assert.match(findings[0]?.message ?? "", /preserve the React synchronization effect/);
});

test("groups every state written by one synchronization effect", () => {
  const findings = analyzeSource(`
    import { useEffect, useState } from "react";
    export function Address({ city: initialCity, zip: initialZip }: { city: string; zip: string }) {
      const [city, setCity] = useState(initialCity);
      const [zip, setZip] = useState(initialZip);
      useEffect(() => {
        if (initialCity) {
          setCity(initialCity);
          setZip(initialZip);
        }
      }, [initialCity, initialZip]);
      return <main>
        <Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation />
        <input value={city} onChange={event => setCity(event.target.value)} />
        <input value={zip} onChange={event => setZip(event.target.value)} />
      </main>;
    }
  `, "fixture.tsx");
  const states = findings.filter(finding => finding.hook === "useState");
  assert.deepEqual(states.map(finding => finding.action), ["use-observable", "use-observable"]);
  assert.deepEqual(states[0]?.group?.members, ["city", "zip"]);
  assert.equal(states[0]?.group?.primary, true);
  assert.equal(states[1]?.group?.primary, false);
});

test("groups branch-complete drafts edited through a direct host callback", () => {
  const findings = analyzeSource(`
    import { useEffect, useState } from "react";
    export function Editor({ open, saved }: { open: boolean; saved: { name: string; color: string } | null }) {
      const [name, setName] = useState("");
      const [color, setColor] = useState("red");
      useEffect(() => {
        if (!open) return;
        if (saved) {
          setName(saved.name);
          setColor(saved.color);
        } else {
          setName("");
          setColor("red");
        }
      }, [open, saved]);
      return <main>
        <Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation />
        <input value={name} onChange={setName} />
        <button style={{ color }} onClick={() => { notify(); setColor("blue"); }} />
      </main>;
    }
  `, "fixture.tsx");
  const states = findings.filter(finding => finding.hook === "useState");
  assert.deepEqual(states.map(finding => finding.action), ["use-observable", "use-observable"]);
  assert.deepEqual(states[0]?.group?.members, ["name", "color"]);
});

test("treats TypeScript-only JSX wrappers as direct draft transport", () => {
  const findings = analyzeSource(`
    import { useEffect, useState } from "react";
    type Country = string & { readonly country: unique symbol };
    export function Address({ saved }: { saved: { country: string; city: string; state: string; zip: string } }) {
      const [country, setCountry] = useState(saved.country);
      const [city, setCity] = useState(saved.city);
      const [region, setRegion] = useState(saved.state);
      const [zip, setZip] = useState(saved.zip);
      useEffect(() => {
        setCountry(saved.country);
        setCity(saved.city);
        setRegion(saved.state);
        setZip(saved.zip);
      }, [saved]);
      const change = (next: string) => {
        setCountry(next);
        setCity("");
        setRegion("");
        setZip("");
      };
      return <main>
        <Header />
        <AddressForm
          country={country as unknown as Country}
          city={city}
          state={region}
          zip={zip}
          onAddressChanged={change}
        />
      </main>;
    }
  `, "fixture.tsx");
  const states = findings.filter(finding => finding.hook === "useState");
  assert.deepEqual(states.map(finding => finding.action), [
    "use-observable",
    "use-observable",
    "use-observable",
    "use-observable",
  ]);
  assert.deepEqual(states[0]?.group?.members, ["country", "city", "region", "zip"]);
});

test("isolates an effect-synchronized preview from its sibling producer", () => {
  const findings = analyzeSource(`
    import { useCallback, useEffect, useState } from "react";
    export function Picker({ items }: { items: string[] }) {
      const [active, setActive] = useState<string | null>(null);
      useEffect(() => { setActive(null); }, [items]);
      const preview = active ?? items[0] ?? null;
      const handleActive = useCallback((item: string) => setActive(item), []);
      return <main>
        <Grid items={items} onItemActive={handleActive} />
        <Preview item={preview} />
        <Footer /><Help /><Status />
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(findings.find(finding => finding.name === "active")?.action, "use-observable");
  assert.equal(findings.find(finding => finding.hook === "useEffect")?.action, "review-effect");
  assert.match(findings.find(finding => finding.name === "active")?.message ?? "", /sibling.*Preview/i);
});

test("keeps opaque fallback work in the owner as a sibling preview snapshot", () => {
  const findings = analyzeSource(`
    import { useCallback, useEffect, useState } from "react";
    export function Picker({ items }: { items: string[] }) {
      const [active, setActive] = useState<string | null>(null);
      useEffect(() => { setActive(null); }, [items]);
      const handleActive = useCallback((item: string) => setActive(item), []);
      return <main>
        <Grid items={items} onItemActive={handleActive} />
        <Preview item={active ?? chooseFallback(items)} />
        <Footer /><Help /><Status />
      </main>;
    }
  `, "fixture.tsx");
  const state = findings.find(finding => finding.name === "active");
  assert.equal(state?.action, "use-observable");
  assert.match(state?.message ?? "", /state-independent fallback inputs as ordinary snapshots/);
});

test("does not isolate a fallback expression that reads the state twice", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function Picker() {
      const [active, setActive] = useState<string | null>(null);
      return <main>
        <Grid onActive={item => setActive(item)} />
        <Preview item={active ?? recover(active)} />
        <Footer /><Help /><Status />
      </main>;
    }
  `, "fixture.tsx");
  assert.notEqual(finding?.action, "use-observable");
});

test("isolates a chart cursor in a stable sibling labels subtree", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function ChartCard({ rows }: { rows: Array<{ id: string; label: string }> }) {
      const [active, setActive] = useState<string | null>(null);
      const activeIndex = active === null ? -1 : rows.findIndex(row => row.id === active);
      return <main>
        <Chart rows={rows} onFocusChange={point => setActive(point?.id ?? null)} />
        <div>{rows.map((row, index) => <span key={row.id} data-active={index === activeIndex}>{row.label}</span>)}</div>
        <Header /><Footer /><Help />
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /sibling.*<div>/i);
});

test("isolates direct setter transport from its sibling value consumer", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function Picker() {
      const [showFade, setShowFade] = useState(false);
      return <main>
        <Grid onOverflowChange={setShowFade} />
        <Preview showFade={showFade} />
        <Header /><Footer /><Help />
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /sibling.*Preview/i);
});

test("requires one stable producer and one complete sibling consumer", () => {
  const snippets = [
    `<Picker value={active} onChange={item => setActive(item)} />`,
    `<><Grid onActive={item => setActive(item)} /><Preview item={active} /><Header active={active} /></>`,
    `<><Grid onActive={item => setActive(item)} />{active && <Preview item={active} />}</>`,
    `<><Grid onActive={item => setActive(item)} /><Preview item={format(active)} /></>`,
    `<>{rows.map(row => <Grid key={row.id} onActive={item => setActive(item)} />)}<Preview item={active} /></>`,
  ];
  for (const rendered of snippets) {
    const [finding] = analyzeSource(`
      import { useState } from "react";
      export function Picker({ rows }: { rows: Array<{ id: string }> }) {
        const [active, setActive] = useState<string | null>(null);
        return <main>${rendered}<Footer /><Help /><Status /><Actions /></main>;
      }
    `, "fixture.tsx");
    assert.notEqual(finding?.action, "use-observable");
  }
});

test("does not isolate a sibling preview when its alias also drives owner work", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function Picker({ items }: { items: string[] }) {
      const [active, setActive] = useState<string | null>(null);
      const preview = active ?? items[0] ?? null;
      usePreviewQuery(preview);
      return <main><Grid onActive={item => setActive(item)} /><Preview item={preview} /><Footer /><Help /><Status /></main>;
    }
  `, "fixture.tsx");
  assert.notEqual(finding?.action, "use-observable");
});

test("does not call a producer command-only when it also invokes owner work", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function Picker({ notify }: { notify: () => void }) {
      const [active, setActive] = useState<string | null>(null);
      const handleActive = (item: string) => {
        setActive(item);
        notify();
      };
      return <main>
        <Grid onActive={handleActive} />
        <Preview item={active} />
        <Header /><Footer /><Help />
      </main>;
    }
  `, "fixture.tsx");
  assert.notEqual(finding?.action, "use-observable");
});

test("uses a strict local JSX cut for a compact synchronized draft", () => {
  const findings = analyzeSource(`
    import { useEffect, useState } from "react";
    export function Editor({ open, saved }: { open: boolean; saved: string }) {
      const [value, setValue] = useState(saved);
      const [error, setError] = useState<string | null>(null);
      useEffect(() => { if (open) { setValue(saved); setError(null); } }, [open, saved]);
      return <Dialog>
        <Header /><Description />
        <section>
          <textarea value={value} onChange={event => { setValue(event.target.value); setError(null); }} />
          {error && <p>{error}</p>}
        </section>
        <Footer /><Cancel /><Save onError={() => setError("invalid")} />
      </Dialog>;
    }
  `, "fixture.tsx");
  const states = findings.filter(finding => finding.hook === "useState");
  assert.deepEqual(states.map(finding => finding.action), ["use-observable", "use-observable"]);
  assert.deepEqual(states[0]?.group?.members, ["value", "error"]);
});

test("does not use owner line count as proof of a synchronized draft cut", () => {
  const findings = analyzeSource(`
    import { useEffect, useState } from "react";
    export function Tiny({ saved }: { saved: string }) {
      const [value, setValue] = useState(saved);
      useEffect(() => { setValue(saved); }, [saved]);
      ${"\n".repeat(120)}
      return <label><input value={value} onChange={setValue} /></label>;
    }
  `, "fixture.tsx");
  assert.notEqual(findings.find(finding => finding.name === "value")?.action, "use-observable");
});

test("requires a synchronized draft's one call site to contain every render read", () => {
  const findings = analyzeSource(`
    import { useEffect, useState } from "react";
    export function Compact({ saved }: { saved: string | null }) {
      const [value, setValue] = useState(saved);
      useEffect(() => { setValue(saved); }, [saved]);
      return <main><Header />{value && <Editor value={value} onChange={setValue} />}</main>;
    }
  `, "fixture.tsx");
  assert.notEqual(findings.find(finding => finding.name === "value")?.action, "use-observable");
});

test("does not change a synchronized draft's stale deferred snapshot", () => {
  const findings = analyzeSource(`
    import { useCallback, useEffect, useState } from "react";
    export function Editor({ saved }: { saved: string }) {
      const [value, setValue] = useState(saved);
      useEffect(() => { setValue(saved); }, [saved]);
      const save = useCallback(() => persist(value), []);
      return <main><Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation />
        <input value={value} onChange={setValue} /><button onClick={save}>Save</button>
      </main>;
    }
  `, "fixture.tsx");
  assert.notEqual(findings.find(finding => finding.name === "value")?.action, "use-observable");
});

test("rejects reset mirrors, hook-fed owner work, and edit commands with external work", () => {
  const snippets = [
    `useEffect(() => { setValue(source); }, [source]);`,
    `const filtered = useDebouncedValue(value.trim()); useEffect(() => { setValue(source); }, [source]);`,
    `useEffect(() => { setValue(source); }, [source]);`,
  ];
  for (const [index, setup] of snippets.entries()) {
    const edit = index === 0
      ? `const edit = () => setValue(source);`
      : index === 2
      ? `const edit = () => { setValue("edit"); updateExternal(); };`
      : `const edit = () => setValue("edit");`;
    const [finding] = analyzeSource(`
      import { useEffect, useState } from "react";
      export function Form({ source }: { source: string }) {
        const [value, setValue] = useState<string | null>(source);
        ${setup}
        ${edit}
        return <main><Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation /><p>{value}</p><button onClick={edit} /></main>;
      }
    `, "fixture.tsx");
    assert.notEqual(finding?.action, "use-observable");
  }
});

test("keeps a synchronized draft when a one-hop projection feeds a hook", () => {
  const findings = analyzeSource(`
    import { useEffect, useState } from "react";
    export function Search({ open }: { open: boolean }) {
      const [query, setQuery] = useState("");
      const trimmedQuery = query.trim();
      const debouncedQuery = useDebouncedValue(trimmedQuery);
      useSearchResults(debouncedQuery);
      useEffect(() => { if (!open) setQuery(""); }, [open]);
      return <main><Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation /><input value={query} onChange={setQuery} /></main>;
    }
  `, "fixture.tsx");
  assert.notEqual(findings.find(finding => finding.name === "query")?.action, "use-observable");
});

test("does not use broad JSX count as proof of a synchronized draft render cut", () => {
  const findings = analyzeSource(`
    import { useEffect, useState } from "react";
    export function Card({ disabled }: { disabled: boolean }) {
      const [open, setOpen] = useState(false);
      useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
      return <Collapsible.Root open={open} onOpenChange={nextOpen => { if (!disabled) setOpen(nextOpen); }}>
        <Header /><Trigger /><Description /><Summary /><Controls /><Fields /><Preview /><Help /><Status /><Actions /><Footer />
        <Collapsible.Content className={open ? "expanded" : "collapsed"}><Content /></Collapsible.Content>
      </Collapsible.Root>;
    }
  `, "fixture.tsx");
  assert.notEqual(findings.find(finding => finding.name === "open")?.action, "use-observable");
});

test("keeps a keyed one-hop render alias inside a synchronized draft", () => {
  const findings = analyzeSource(`
    import { useEffect, useState } from "react";
    export function Picker({ rows, source }: { rows: Array<{ id: string }>; source: string | null }) {
      const [active, setActive] = useState<string | null>(source);
      useEffect(() => { setActive(source); }, [source]);
      return <main><Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation />
        {rows.map(row => {
          const selected = active === row.id;
          return <button key={row.id} aria-pressed={selected} onClick={() => setActive(row.id)} />;
        })}
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(findings.find(finding => finding.name === "active")?.action, "use-observable");
});

test("preserves one command snapshot for a synchronized draft read by deferred work", () => {
  const findings = analyzeSource(`
    import { useEffect, useState } from "react";
    export function DeletePanel({ initial, rows }: { initial: boolean; rows: string[] }) {
      const [decrement, setDecrement] = useState(initial);
      useEffect(() => { setDecrement(initial); }, [initial]);
      const remove = async () => {
        await Promise.all(rows.map(id => destroy(id, { decrement })));
      };
      return <main><Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation />
        <Checkbox checked={decrement} onCheckedChange={setDecrement} /><button onClick={remove} />
      </main>;
    }
  `, "fixture.tsx");
  const state = findings.find(finding => finding.name === "decrement");
  assert.equal(state?.action, "use-observable");
  assert.match(state?.message ?? "", /snapshot once at command entry/);
});

test("accepts a literal reset effect when a controlled input proves independent editing", () => {
  const findings = analyzeSource(`
    import { useEffect, useState } from "react";
    export function Form({ open }: { open: boolean }) {
      const [value, setValue] = useState("");
      useEffect(() => { if (open) setValue(""); }, [open]);
      return <main><Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation /><input value={value} onChange={setValue} /></main>;
    }
  `, "fixture.tsx");
  assert.equal(findings.find(finding => finding.name === "value")?.action, "use-observable");
});

test("does not treat an opaque setter prop as a draft edit path", () => {
  for (const setterProp of ["register", "onClick"]) {
    const findings = analyzeSource(`
      import { useEffect, useState } from "react";
      export function Form({ source }: { source: string }) {
        const [value, setValue] = useState(source);
        useEffect(() => { setValue(source); }, [source]);
        return <main><Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation /><Field value={value} ${setterProp}={setValue} /></main>;
      }
    `, "fixture.tsx");
    assert.notEqual(findings.find(finding => finding.name === "value")?.action, "use-observable");
  }
});

test("keeps owner rerenders when a memoized draft projection feeds another lifecycle hook", () => {
  const findings = analyzeSource(`
    import { useEffect, useMemo, useState } from "react";
    export function Editor({ saved }: { saved: string }) {
      const [value, setValue] = useState(saved);
      useEffect(() => { setValue(saved); }, [saved]);
      const payload = useMemo(() => ({ value }), [value]);
      useEffect(() => { persist(payload); }, [payload]);
      return <main><Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation /><input value={value} onChange={setValue} /></main>;
    }
  `, "fixture.tsx");
  assert.notEqual(findings.find(finding => finding.name === "value")?.action, "use-observable");
});

test("rejects draft reads and dead member edits that do not originate in UI events", () => {
  const findings = analyzeSource(`
    import { useCallback, useEffect, useState } from "react";
    export function Editor({ saved }: { saved: string }) {
      const [first, setFirst] = useState(saved);
      const [second, setSecond] = useState(saved);
      useEffect(() => { setFirst(saved); setSecond(saved); }, [saved]);
      const synchronize = useCallback(() => send(first), [first]);
      useEffect(synchronize, [synchronize]);
      const never = () => setSecond("edit");
      return <main><Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation /><input value={first} onChange={setFirst} /><p>{second}</p></main>;
    }
  `, "fixture.tsx");
  assert.notEqual(findings.find(finding => finding.name === "first")?.action, "use-observable");
  assert.notEqual(findings.find(finding => finding.name === "second")?.action, "use-observable");
});

test("rejects partial, asynchronous, cleanup, and derived effect sinks", () => {
  const snippets = [
    `useEffect(() => { setValue(source); setOther(false); }, [source]);`,
    `useEffect(() => { const timer = setTimeout(() => setValue(source), 1); return () => clearTimeout(timer); }, [source]);`,
    `useEffect(() => { setValue(previous => source); }, [source]);`,
    `useEffect(() => { setValue(source); }, [source]);`,
  ];
  for (const [index, effect] of snippets.entries()) {
    const editable = index === 3 ? "" : `<button onClick={() => setValue("edit")} />`;
    const findings = analyzeSource(`
      import { useEffect, useState } from "react";
      export function Form({ source }: { source: string }) {
        const [value, setValue] = useState(source);
        const [other, setOther] = useState(false);
        ${effect}
        return <main><Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation /><p>{value}</p>${editable}</main>;
      }
    `, "fixture.tsx");
    assert.notEqual(findings.find(finding => finding.name === "value")?.action, "use-observable");
  }
});

test("does not mistake a JSX callback invocation for an owner render read", () => {
  const [finding] = analyzeSource(`
    import { useCallback, useState } from "react";
    export function Form() {
      const [busy, setBusy] = useState(false);
      const canSubmit = useCallback(() => !busy, [busy]);
      return <Panel renderFooter={() => <Button disabled={!canSubmit()} onClick={() => setBusy(true)} />} />;
    }
  `, "fixture.tsx");
  assert.notEqual(finding?.action, "use-ref");
});

test("traces local callable state reads invoked before JSX", () => {
  const [finding] = analyzeSource(`
    import { useCallback, useState } from "react";
    export function Form() {
      const [busy, setBusy] = useState(false);
      const canSubmit = useCallback(() => !busy, [busy]);
      const disabled = !canSubmit();
      return <Button disabled={disabled} onClick={() => setBusy(true)} />;
    }
  `, "fixture.tsx");
  assert.notEqual(finding?.action, "use-ref");
});

test("flags direct render state in a non-trivial owner as Legend-first", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function Screen() {
      const [active, setActive] = useState(false);
      return <main><Header /><Toolbar /><Content /><Button onClick={() => setActive(v => !v)} />{active && <Panel />}</main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "review-state");
  assert.equal(finding?.disposition, "candidate");
  assert.match(finding?.message ?? "", /Legend-first restructuring candidate/);
});

test("moves direct state into its strict stable JSX subtree", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function Screen() {
      const [expanded, setExpanded] = useState(false);
      ${"\n".repeat(150)}
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <section><p>{expanded ? "Long" : "Short"}</p><button onClick={() => setExpanded(v => !v)}>Toggle</button></section>
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "move-state-down");
  assert.match(finding?.message ?? "", /every read and command is confined/);
});

test("keeps ownership stable and extracts a conditional subscription subtree", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function Screen({ show }: { show: boolean }) {
      const [expanded, setExpanded] = useState(false);
      ${"\n".repeat(150)}
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        {show ? <section><p>{expanded ? "Long" : "Short"}</p><button onClick={() => setExpanded(v => !v)}>Toggle</button></section> : null}
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /preserves conditional mount lifetime/);
});

test("isolates presentation gates whose branches contain ordinary render calls", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function Screen({ t }: { t: (key: string) => string }) {
      const [copied, setCopied] = useState(false);
      const copy = () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2_000);
      };
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <button aria-label={copied ? t("copied") : t("copy")} onClick={copy}>
          {copied ? <CheckIcon label={t("copied")} /> : <CopyIcon label={t("copy")} />}
        </button>
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /full state-controlled render expression/);
});

test("isolates a small logical JSX gate without moving its owner lifetime", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function Screen() {
      const [visible, setVisible] = useState(true);
      const hide = () => setVisible(false);
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <section>
          <Canvas onBegin={hide} />
          {visible && <Hint onDismiss={hide}>Draw here</Hint>}
        </section>
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /always-mounted leaf subscriber/);
});

test("isolates a leaf reached through one immutable render projection", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function Screen({ src, enabled }: { src: string; enabled: boolean }) {
      const [failed, setFailed] = useState(false);
      const showImage = src.length > 0 && !failed;
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <section>{showImage && enabled && <img src={src} onError={() => setFailed(true)} />}</section>
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /full state-controlled render expression/);
});

test("does not isolate mutable, effectful, or externally consumed render aliases", () => {
  for (const alias of [
    `let showImage = !failed;`,
    `const showImage = trackAndCheck(failed);`,
    `const showImage = !failed; useQuery(showImage);`,
  ]) {
    assert.deepEqual(
      actions(`
        import { useState } from "react";
        export function Screen() {
          const [failed, setFailed] = useState(false);
          ${alias}
          return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
            {showImage && <img onError={() => setFailed(true)} />}
          </main>;
        }
      `),
      ["review-state"]
    );
  }
});

test("does not move side effects embedded in a render gate condition", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Screen({ trackAndCheck }: { trackAndCheck: (value: boolean) => boolean }) {
        const [visible, setVisible] = useState(false);
        const show = () => setVisible(true);
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
          <button onClick={show}>Show</button>
          {trackAndCheck(visible) && <Leaf />}
        </main>;
      }
    `),
    ["review-state"]
  );
});

test("does not isolate a presentation gate that owns the whole return", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Screen() {
        const [ready, setReady] = useState(false);
        return ready
          ? <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /></main>
          : <Loading onReady={() => setReady(true)} />;
      }
    `),
    ["review-state"]
  );
});

test("does not isolate a presentation gate repeated across rows", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Screen({ rows }: { rows: Array<{ id: string }> }) {
        const [active, setActive] = useState(false);
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
          {rows.map(row => <Row key={row.id} onClick={() => setActive(true)}>
            {active ? <ActiveIcon /> : <IdleIcon />}
          </Row>)}
        </main>;
      }
    `),
    ["review-state"]
  );
});

test("does not isolate a presentation gate with companion state writes", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Screen() {
        const [open, setOpen] = useState(false);
        const [payload, setPayload] = useState<string | null>(null);
        const show = () => { setPayload("item"); setOpen(true); };
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
          <button onClick={show}>Open</button>
          {open && <Dialog payload={payload} onClose={() => setOpen(false)} />}
        </main>;
      }
    `),
    ["review-state", "review-state"]
  );

  assert.deepEqual(
    actions(`
      import { useState } from "react";
      function Dialog(_props: unknown) { return null; }
      export function Screen() {
        const [open, setOpen] = useState(false);
        const [dirty, setDirty] = useState(false);
        const unused = <button onClick={() => setOpen(true)} />;
        const close = () => { setOpen(false); setDirty(false); };
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <Dialog open={open} onOpenChange={close} />
          <span>{dirty}</span>
        </main>;
      }
    `),
    ["review-state", "review-state"]
  );

  assert.deepEqual(
    actions(`
      import { useState } from "react";
      function Dialog(_props: unknown) { return null; }
      export function Screen() {
        const [open, setOpen] = useState(false);
        const [dirty, setDirty] = useState(false);
        const markDirty = () => { setDirty(true); return true; };
        const close = () => { setOpen(false); setDirty(false); };
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <button onClick={() => setOpen(markDirty())} />
          <Dialog open={open} onOpenChange={close} />
          <span>{dirty}</span>
        </main>;
      }
    `),
    ["review-state", "review-state"]
  );
});

test("keeps observable ownership across early-return and keyed subtree lifetimes", () => {
  const [earlyReturn] = analyzeSource(`
    import { useState } from "react";
    export function Screen({ loading }: { loading: boolean }) {
      const [expanded, setExpanded] = useState(false);
      ${"\n".repeat(100)}
      if (loading) return <Loading />;
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <section><p>{expanded ? "Long" : "Short"}</p><button onClick={() => setExpanded(v => !v)}>Toggle</button></section>
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(earlyReturn?.action, "use-observable");

  const [keyed] = analyzeSource(`
    import { useState } from "react";
    export function Screen({ identity }: { identity: string }) {
      const [expanded, setExpanded] = useState(false);
      ${"\n".repeat(100)}
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <article key={identity}><section><p>{expanded ? "Long" : "Short"}</p><button onClick={() => setExpanded(v => !v)}>Toggle</button></section></article>
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(keyed?.action, "use-observable");
});

test("does not isolate direct state whose reads span the owner", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function Screen() {
      const [active, setActive] = useState(false);
      ${"\n".repeat(150)}
      return <main data-active={active}>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <section><button onClick={() => setActive(v => !v)}>Toggle</button></section>
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "review-state");
});

test("groups multiple direct states confined to the same JSX subtree", () => {
  const findings = analyzeSource(`
    import { useState } from "react";
    export function Screen() {
      const [query, setQuery] = useState("");
      const [expanded, setExpanded] = useState(false);
      ${"\n".repeat(150)}
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <section>
          <input value={query} onChange={event => setQuery(event.target.value)} />
          <p>{expanded ? query : query.slice(0, 2)}</p>
          <button onClick={() => setExpanded(value => !value)}>Toggle</button>
        </section>
      </main>;
    }
  `, "fixture.tsx");
  const grouped = findings.filter(finding => finding.group);
  assert.deepEqual(grouped.map(finding => finding.action), ["move-state-down", "move-state-down"]);
  assert.deepEqual(grouped[0]?.group?.members, ["query", "expanded"]);
  assert.equal(agentFindings(findings).filter(finding => finding.group).length, 1);
});

test("keeps observable ownership when a subtree cluster mixes direct and projected state", () => {
  const findings = analyzeSource(`
    import { useState } from "react";
    export function Screen() {
      const [query, setQuery] = useState("");
      const [selected, setSelected] = useState<{ id: string } | null>(null);
      return <main>
        <Header onSelect={item => setSelected(item)} /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <section>
          <input onChange={event => setQuery(event.target.value)} />
          <p>{query}</p>
          <Dialog open={selected != null} />
          <Preview itemId={selected?.id ?? null} />
        </section>
      </main>;
    }
  `, "fixture.tsx");
  const grouped = findings.filter(finding => finding.group);
  assert.deepEqual(grouped.map(finding => finding.action), ["use-observable", "use-observable"]);
  assert.deepEqual(grouped[0]?.group?.members, ["query", "selected"]);
});

test("does not let a direct state pull an escaped projection into its subtree cluster", () => {
  const findings = analyzeSource(`
    import { useCallback, useState } from "react";
    export function Screen() {
      const [query, setQuery] = useState("");
      const [selected, setSelected] = useState<{ id: string } | null>(null);
      useCommands({ onSelect: useCallback(item => setSelected(item), []) });
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <section>
          <input onChange={event => setQuery(event.target.value)} />
          <p>{query}</p>
          <Dialog open={selected != null} />
          <Preview itemId={selected?.id ?? null} />
        </section>
      </main>;
    }
  `, "fixture.tsx");
  const selected = findings.find(finding => finding.name === "selected");
  assert.equal(selected?.action, "review-state");
  assert.equal(selected?.group, undefined);
});

test("does not let a direct state pull a reactive-mutation projection into its subtree cluster", () => {
  const findings = analyzeSource(`
    import { useState } from "react";
    export function Screen() {
      const { mutateAsync: submitSelection } = useSubmitSelection();
      const [query, setQuery] = useState("");
      const [selected, setSelected] = useState<{ id: string } | null>(null);
      const select = async (item: { id: string }) => {
        setSelected(item);
        try { await submitSelection(item); } catch { setSelected(null); }
      };
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <section>
          <input onChange={event => setQuery(event.target.value)} />
          <p>{query}</p>
          <button onClick={() => select({ id: "x" })}>Select</button>
          <Dialog open={selected != null} />
          <Preview itemId={selected?.id ?? null} />
        </section>
      </main>;
    }
  `, "fixture.tsx");
  const selected = findings.find(finding => finding.name === "selected");
  assert.equal(selected?.action, "review-state");
  assert.equal(selected?.group, undefined);
});

test("places pure JSX prop projections in a call-site subscriber wrapper", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function Screen() {
      const [selected, setSelected] = useState<{ id: string } | null>(null);
      const open = (item: { id: string }) => setSelected(item);
      ${"\n".repeat(100)}
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
        <ItemDialog open={selected != null} itemId={selected?.id ?? null} onClose={() => setSelected(null)} />
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /leave the child API unchanged/);
});

test("keeps raw state transport and its projection in one stable call-site wrapper", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function Screen() {
      const [target, setTarget] = useState<string | null>(null);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
        <DetailDialog id={target} open={!!target} onOpenChange={open => !open && setTarget(null)} />
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /leave the child API unchanged/);
});

test("keeps mixed transport ownership above a state-controlled call-site gate", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function Screen() {
      const [target, setTarget] = useState<string | null>(null);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
        {target && <DetailDialog id={target} open onOpenChange={open => !open && setTarget(null)} />}
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /full state-controlled render expression/);
});

test("does not transport a whole mixed state value into every repeated row subscriber", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function Screen({ rows }: { rows: Array<{ id: string }> }) {
      const [selected, setSelected] = useState<{ id: string } | null>(null);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
        {rows.map(row => <Row key={row.id} selected={selected} active={selected?.id === row.id} onPress={() => setSelected(row)} />)}
      </main>;
    }
  `, "fixture.tsx");
  assert.notEqual(finding?.action, "use-observable");
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
    const [finding] = analyzeSource(`
      import React, { useState } from "react";
      export function Screen() {
        ${state}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <Slot value={${name}} ready={${name} != null} onReset={() => ${setter}(() => noop)} />
        </main>;
      }
    `, "fixture.tsx");
    assert.notEqual(finding?.action, "use-observable");
  }
});

test("isolates direct primitive state at one stable call-site leaf", () => {
  const findings = analyzeSource(`
    import { useState } from "react";
    const Leaf = (props: { value: unknown }) => <output>{String(props.value)}</output>;
    const Shell = ({ children }: { children: React.ReactNode }) => <main>{children}</main>;
    export function BooleanScreen() {
      const [visible, setVisible] = useState(true);
      return <Shell><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <button onClick={() => setVisible(false)}>Close</button><Leaf value={visible} /></Shell>;
    }
    export function StringScreen() {
      const [mode, setMode] = useState("idle");
      return <Shell><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <button onClick={() => setMode("done")}>Done</button><Leaf value={mode} /></Shell>;
    }
    export function NumberScreen() {
      const [page, setPage] = useState(-1);
      return <Shell><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <button onClick={() => setPage(1)}>Next</button><Leaf value={page} /></Shell>;
    }
  `, "fixture.tsx");
  assert.deepEqual(
    findings.filter(finding => ["visible", "mode", "page"].includes(finding.name ?? "")).map(finding => finding.action),
    ["use-observable", "use-observable", "use-observable"]
  );
});

test("isolates an async pending flag at one stable leaf without changing its await boundary", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    function LoadingButton(props: { loading: boolean }) { return <button>{String(props.loading)}</button>; }
    export function Form() {
      const [saving, setSaving] = useState(false);
      async function save() {
        setSaving(true);
        try { await persist(); } finally { setSaving(false); }
      }
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <form onSubmit={save}><LoadingButton loading={saving} /></form>
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /await boundary/);
});

test("traces an async pending command through an event-rooted submit helper", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    function LoadingButton(props: { loading: boolean }) { return <button>{String(props.loading)}</button>; }
    export function Form() {
      const [saving, setSaving] = useState(false);
      const save = async () => {
        setSaving(true);
        try { await persist(); } finally { setSaving(false); }
      };
      const submit = () => save();
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <form onSubmit={submit}><LoadingButton loading={saving} /></form>
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
});

test("isolates async status after non-mutating validation guards", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    function LoadingButton(props: { loading: boolean }) { return <button>{String(props.loading)}</button>; }
    export function Form({ valid }: { valid: boolean }) {
      const [saving, setSaving] = useState(false);
      async function save() {
        if (!valid) return;
        setSaving(true);
        await persist();
        setSaving(false);
      }
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <form onSubmit={save}><LoadingButton loading={saving} /></form>
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /await boundary/);
});

test("keeps async status ownership above a state-independent conditional leaf", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function Form({ existing }: { existing: boolean }) {
      const [saving, setSaving] = useState(false);
      async function save() {
        setSaving(true);
        try { await persist(); } finally { setSaving(false); }
      }
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        {existing ? <ExternalButton loading={saving} onClick={save} /> : <CreateButton />}
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /await boundary/);
});

test("does not isolate async status when another owner update starts the command", () => {
  const findings = analyzeSource(`
    import { useState } from "react";
    function LoadingButton(props: { loading: boolean }) { return <button>{String(props.loading)}</button>; }
    export function Form() {
      const [dirty, setDirty] = useState(false);
      const [saving, setSaving] = useState(false);
      async function save() {
        setDirty(true);
        try {
          setSaving(true);
          await persist();
        } finally { setSaving(false); }
      }
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <form onSubmit={save}><LoadingButton loading={saving} /></form><output>{String(dirty)}</output>
      </main>;
    }
  `, "fixture.tsx");
  assert.notEqual(findings.find(finding => finding.name === "saving")?.action, "use-observable");
});

test("does not isolate async status owned by a reactive mutation", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    function LoadingButton(props: { loading: boolean }) { return <button>{String(props.loading)}</button>; }
    export function Form() {
      const mutation = useSaveMutation();
      const [saving, setSaving] = useState(false);
      async function save() {
        setSaving(true);
        try { await mutation.mutateAsync(); } finally { setSaving(false); }
      }
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <form onSubmit={save}><LoadingButton loading={saving} /></form>
      </main>;
    }
  `, "fixture.tsx");
  assert.notEqual(finding?.action, "use-observable");
});

test("does not isolate async status from a scheduled callback or nonliteral write", () => {
  for (const command of [
    `setTimeout(async () => { setSaving(true); await persist(); setSaving(false); }, 0);`,
    `async function save() { setSaving(next); await persist(); setSaving(false); }`,
  ]) {
    const [finding] = analyzeSource(`
      import { useState } from "react";
      function LoadingButton(props: { loading: boolean }) { return <button>{String(props.loading)}</button>; }
      export function Form({ next = true }: { next?: boolean }) {
        const [saving, setSaving] = useState(false);
        ${command}
        return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
          <LoadingButton loading={saving} />
        </main>;
      }
    `, "fixture.tsx");
    assert.doesNotMatch(finding?.message ?? "", /async pending flag/);
  }
});

test("does not isolate async status without one broad stable leaf", () => {
  const findings = analyzeSource(`
    import { useState } from "react";
    function LoadingButton(props: { loading: boolean }) { return <button>{String(props.loading)}</button>; }
    export function Small() {
      const [saving, setSaving] = useState(false);
      async function save() { setSaving(true); await persist(); setSaving(false); }
      return <form onSubmit={save}><LoadingButton loading={saving} /></form>;
    }
    export function Fanout() {
      const [saving, setSaving] = useState(false);
      async function save() { setSaving(true); await persist(); setSaving(false); }
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <form onSubmit={save}><LoadingButton loading={saving} /><Status pending={saving} /></form>
      </main>;
    }
  `, "fixture.tsx");
  for (const finding of findings.filter(candidate => candidate.name === "saving")) {
    assert.notEqual(finding.action, "use-observable");
  }
});

test("does not treat a lazy or indirect initializer as a direct primitive", () => {
  const findings = analyzeSource(`
    import { useState } from "react";
    const Leaf = (props: { value: unknown }) => <output>{String(props.value)}</output>;
    export function Screen({ initial }: { initial: string }) {
      const [lazy, setLazy] = useState(() => true);
      const [indirect, setIndirect] = useState(initial);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <button onClick={() => setLazy(false)}>Lazy</button><Leaf value={lazy} />
        <button onClick={() => setIndirect("done")}>Indirect</button><Leaf value={indirect} /></main>;
    }
  `, "fixture.tsx");
  for (const name of ["lazy", "indirect"]) {
    assert.notEqual(findings.find(finding => finding.name === name)?.action, "use-observable");
  }
});

test("does not wrap projections that span sibling call sites", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function Screen() {
      const [selected, setSelected] = useState<{ id: string } | null>(null);
      ${"\n".repeat(100)}
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <EditDialog open={selected != null} item={selected} />
        <DeleteDialog open={selected != null} item={selected} onClose={() => setSelected(null)} />
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "review-state");
});

test("does not promote a projection whose every write shares a reactive mutation lifecycle", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function Screen() {
      const { mutateAsync: submitFeedback, isPending } = useSubmitFeedback();
      const [feedback, setFeedback] = useState<Record<string, string>>({});
      const vote = async (id: string) => {
        setFeedback(value => ({ ...value, [id]: "up" }));
        try { await submitFeedback(id); } catch { setFeedback({}); }
      };
      ${"\n".repeat(100)}
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        {rows.map(row => <Row key={row.id} active={feedback[row.id] === "up"} onVote={() => vote(row.id)} />)}
        <Spinner visible={isPending} />
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "review-state");
});

test("does not promote a projection when its setter callback escapes through a custom hook", () => {
  const [finding] = analyzeSource(`
    import { useCallback, useState } from "react";
    export function Screen() {
      const [open, setOpen] = useState(false);
      useCommands({ onOpen: useCallback(() => setOpen(true), []) });
      ${"\n".repeat(100)}
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <Dialog open={open && enabled} onClose={() => setOpen(false)} />
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "review-state");
});

test("keeps React state when the component is already a tiny render leaf", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function Toggle() {
      const [active, setActive] = useState(false);
      return <button onClick={() => setActive(v => !v)}>{active ? "On" : "Off"}</button>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "keep-state");
  assert.equal(finding?.disposition, "keep");
});

test("does not issue production state migrations for test harnesses", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    function Subject() { return null; }
    export function Harness() {
      const [value, setValue] = useState("");
      return <Subject value={value} onChange={setValue} />;
    }
  `, "Subject.test.tsx");
  assert.equal(finding?.action, "keep-state");
  assert.equal(finding?.disposition, "keep");
});

test("moves transport-only state into one child", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      function SearchInput() { return null; }
      export function SearchPage() {
        const [query, setQuery] = useState("");
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <SearchInput value={query} onChange={setQuery} />
        </main>;
      }
    `),
    ["move-state-down"]
  );
});

test("moves controlled state when an inline setter callback belongs to the same leaf", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Screen() {
        const [active, setActive] = useState("profile");
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <Tabs value={active} onValueChange={value => setActive(String(value))} />
        </main>;
      }
    `),
    ["move-state-down"]
  );
});

test("keeps observable ownership when a sibling command opens one exact leaf", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      function Dialog(_props: unknown) { return null; }
      export function Screen() {
        const [open, setOpen] = useState(false);
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <button onClick={() => setOpen(true)} />
          <Dialog open={open} onOpenChange={setOpen} />
        </main>;
      }
    `),
    ["use-observable"]
  );
});

test("does not infer an independent write through a helper-hidden companion update", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      function Dialog(_props: unknown) { return null; }
      export function Screen() {
        const [open, setOpen] = useState(false);
        const [dirty, setDirty] = useState(false);
        const markDirty = () => setDirty(true);
        const show = () => { setOpen(true); markDirty(); };
        const close = () => { setOpen(false); setDirty(false); };
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <button onClick={show} />
          <Dialog open={open} onOpenChange={close} />
          <span>{dirty}</span>
        </main>;
      }
    `),
    ["review-state", "review-state"]
  );

  assert.deepEqual(
    actions(`
      import { useState } from "react";
      function Dialog(_props: unknown) { return null; }
      export function Screen() {
        const [open, setOpen] = useState(false);
        const [dirty, setDirty] = useState(false);
        const markDirty = () => setDirty(true);
        const close = () => { setOpen(false); setDirty(false); };
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <button onClick={() => { setOpen(true); markDirty(); }} />
          <Dialog open={open} onOpenChange={close} />
          <span>{dirty}</span>
        </main>;
      }
    `),
    ["review-state", "review-state"]
  );
});

test("isolates an independently opened leaf while preserving coupled workflow transitions", () => {
  const findings = analyzeSource(`
    import { useState } from "react";
    function Dialog(_props: unknown) { return null; }
    export function Screen() {
      const [open, setOpen] = useState(false);
      const [selection, setSelection] = useState<string | null>(null);
      const transition = () => { setOpen(false); setSelection("next"); };
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
        <button onClick={() => setOpen(true)}>Open</button>
        <Dialog open={open} onOpenChange={setOpen} onTransition={transition} />
        <span>{selection}</span>
      </main>;
    }
  `, "fixture.tsx");
  const open = findings.find(finding => finding.name === "open");
  const selection = findings.find(finding => finding.name === "selection");
  assert.equal(open?.action, "use-observable");
  assert.equal(selection?.action, "review-state");
});

test("does not move an inline controlled callback that co-writes owner state", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Screen() {
        const [active, setActive] = useState("profile");
        const [dirty, setDirty] = useState(false);
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <Tabs value={active} onValueChange={value => { setActive(String(value)); setDirty(true); }} />
          <Save disabled={!dirty} />
        </main>;
      }
    `),
    ["review-state", "review-state"]
  );
});

test("does not move state whose setter command lives outside the receiving leaf", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Screen() {
        const [active, setActive] = useState("profile");
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <button onClick={() => setActive("profile")} />
          <Tabs value={active} />
        </main>;
      }
    `),
    ["review-state"]
  );
});

test("does not move controlled state through an opaque JSX callback", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Screen() {
        const [active, setActive] = useState("profile");
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <Panel render={() => <Tabs value={active} onValueChange={setActive} />} />
        </main>;
      }
    `),
    ["review-state"]
  );
});

test("does not move controlled state through a stored JSX value", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Screen({ show }: { show: boolean }) {
        const [active, setActive] = useState("profile");
        const tabs = <Tabs value={active} onValueChange={setActive} />;
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          {show ? tabs : null}
        </main>;
      }
    `),
    ["review-state"]
  );
});

test("does not move controlled state out of a custom hook that returns JSX", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function useTabs() {
        const [active, setActive] = useState("profile");
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <Tabs value={active} onValueChange={setActive} />
        </main>;
      }
    `),
    ["review-state"]
  );
});

test("does not move direct state into an opaque render callback", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Screen() {
        const [expanded, setExpanded] = useState(false);
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <VirtualList renderItem={() => <section><b>{expanded ? "Yes" : "No"}</b><button onClick={() => setExpanded(value => !value)} /></section>} />
        </main>;
      }
    `),
    ["review-state"]
  );
});

test("requires repeated projections to depend on a stable row key", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Screen({ rows }: { rows: Array<{ id: string }> }) {
        const [busy, setBusy] = useState(false);
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          {rows.map(row => <Row key={row.id} disabled={!busy} onClick={() => setBusy(true)} />)}
        </main>;
      }
    `),
    ["review-state"]
  );
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Screen({ rows }: { rows: Array<{ id: string }> }) {
        const [selectedId, setSelectedId] = useState<string | null>(null);
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          {rows.map((row, index) => <Row key={index} active={selectedId === row.id} onClick={() => setSelectedId(row.id)} />)}
        </main>;
      }
    `),
    ["review-state"]
  );
});

test("allows a keyed row projection to read the current key in its click command", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function Screen({ rows }: { rows: Array<{ id: string }> }) {
      const [openId, setOpenId] = useState<string | null>(null);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        {rows.map(row => <Row key={row.id} open={openId === row.id} onClick={() => setOpenId(openId === row.id ? null : row.id)} />)}
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /per-item/);
});

test("does not move direct state when every write shares a mutation lifecycle", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Screen() {
        const save = useSave();
        const [busy, setBusy] = useState(false);
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <section>{busy ? "Saving" : "Ready"}<button onClick={async () => { setBusy(true); await save.mutateAsync(); setBusy(false); }} /></section>
        </main>;
      }
    `),
    ["review-state"]
  );
});

test("does not move controlled state from an owner that is already a small leaf", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      function Editor() { return null; }
      export function Screen() {
        const [value, setValue] = useState("");
        return <Editor value={value} onChange={setValue} />;
      }
    `),
    ["review-state"]
  );
});

test("does not move shared state into repeated or conditional child instances", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      function Editor() { return null; }
      export function Screen({ show }: { show: boolean }) {
        const [value, setValue] = useState("");
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          {show && <Editor value={value} onChange={setValue} />}
        </main>;
      }
    `),
    ["review-state"]
  );
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      function Editor() { return null; }
      export function Screen() {
        const [value, setValue] = useState("");
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <Editor value={value} onChange={setValue} /><Editor value={value} onChange={setValue} />
        </main>;
      }
    `),
    ["review-state"]
  );
});

test("groups a co-written dialog payload and visibility flag into one observable model", () => {
  const findings = analyzeSource(`
    import { useState } from "react";
    interface Item { id: string }
    function ItemDialog(_props: unknown) { return null; }
    export function Screen({ item }: { item: Item }) {
      const [target, setTarget] = useState<Item | null>(null);
      const [open, setOpen] = useState(false);
      const show = () => { setTarget(item); setOpen(true); };
      ${"\n".repeat(100)}
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
        <Aside /><Help /><Status /><Actions /><Preview />
        <ItemDialog target={target} open={open} onOpenChange={setOpen} onShow={show} />
      </main>;
    }
  `, "fixture.tsx");
  const grouped = findings.filter(finding => finding.group);
  assert.deepEqual(grouped.map(finding => finding.action), ["use-observable", "use-observable"]);
  assert.deepEqual(grouped[0]?.group?.members, ["target", "open"]);
  assert.equal(agentFindings(findings).filter(finding => finding.group).length, 1);
});

test("does not merge mutually exclusive switch branches into one state cluster", () => {
  const findings = analyzeSource(`
    import { useState } from "react";
    interface Item { id: string }
    function ItemDialog(_props: unknown) { return null; }
    function EditDialog(_props: unknown) { return null; }
    export function Screen({ item }: { item: Item }) {
      const [editTarget, setEditTarget] = useState<Item | null>(null);
      const [linkTarget, setLinkTarget] = useState<Item | null>(null);
      const [linkOpen, setLinkOpen] = useState(false);
      const act = (kind: "edit" | "link") => {
        switch (kind) {
          case "edit": setEditTarget(item); return;
          case "link": setLinkTarget(item); setLinkOpen(true); return;
        }
      };
      ${"\n".repeat(100)}
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
        <Aside /><Help /><Status /><Actions />
        <EditDialog target={editTarget} onAct={act} />
        <ItemDialog target={linkTarget} open={linkOpen} onOpenChange={setLinkOpen} />
      </main>;
    }
  `, "fixture.tsx");
  const primary = findings.find(finding => finding.group?.primary);
  assert.deepEqual(primary?.group?.members, ["linkTarget", "linkOpen"]);
  assert.equal(findings.find(finding => finding.name === "editTarget")?.group, undefined);
});

test("reviews fanout to multiple leaves without assuming Legend is faster", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      function SearchInput() { return null; }
      function Preview() { return null; }
      export function SearchPage() {
        const [query, setQuery] = useState("");
        return <><SearchInput value={query} onChange={setQuery} /><Preview query={query} /></>;
      }
    `),
    ["review-state"]
  );
});

test("suggests observable transport for a repeated leaf", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      function Row() { return null; }
      export function Results({ rows }: { rows: string[] }) {
        const [selectedId, setSelectedId] = useState<string | null>(null);
        return rows.map(id => <Row key={id} id={id} selectedId={selectedId} onSelect={setSelectedId} />);
      }
    `),
    ["use-observable"]
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
    ["keep-state"]
  );
});

test("deletes a pure derivation state and effect pair", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useState } from "react";
      export function Name({ first, last }: { first: string; last: string }) {
        const [fullName, setFullName] = useState("");
        useEffect(() => { setFullName(first + " " + last); }, [first, last]);
        return <span>{fullName}</span>;
      }
    `),
    ["delete-derived-state", "delete-effect"]
  );
});

test("does not leak a derived-state deletion across sibling component bindings", () => {
  const findings = analyzeSource(`
    import { useEffect, useState } from "react";
    export function Interactive() {
      const [value, setValue] = useState("");
      return <input value={value} onChange={event => setValue(event.target.value)} />;
    }
    export function Derived({ input }: { input: string }) {
      const [value, setValue] = useState("");
      useEffect(() => { setValue(input + "!"); }, [input]);
      return <span>{value}</span>;
    }
  `, "fixture.tsx");
  assert.equal(findings.filter(finding => finding.action === "delete-derived-state").length, 1);
  assert.equal(findings.filter(finding => finding.action === "delete-effect").length, 1);
});

test("does not confuse a sibling state setter with an external subscription", () => {
  const findings = analyzeSource(`
    import { useEffect, useState } from "react";
    export function Form() {
      const [flag, subscribe] = useState(false);
      return <button onClick={() => subscribe(true)}>{String(flag)}</button>;
    }
    export function Bridge({ subscribe }: { subscribe: () => () => void }) {
      useEffect(() => subscribe(), [subscribe]);
      return null;
    }
  `, "fixture.tsx");
  assert.equal(findings.find(finding => finding.hook === "useEffect")?.action, "keep-effect");
});

test("does not let a sibling setter suppress a module-global mount candidate", () => {
  const findings = analyzeSource(`
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
  `, "fixture.tsx");
  assert.equal(findings.find(finding => finding.hook === "useEffect")?.action, "use-mount");
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
    ["review-state", "review-effect"]
  );
});

test("moves a same-owner reset effect into complete event mutation boundaries", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useState } from "react";
      export function Browser() {
        const [category, setCategory] = useState("all");
        const [detailIndex, setDetailIndex] = useState(0);
        useEffect(() => setDetailIndex(0), [category]);
        return <main>
          <Filter onChange={setCategory} />
          <button onClick={() => setDetailIndex(value => value + 1)}>{detailIndex}</button>
        </main>;
      }
    `),
    ["review-state", "review-state", "move-to-event"]
  );
});

test("does not move a reset effect when a dependency mutation boundary is external", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useState } from "react";
      export function Browser({ category }: { category: string }) {
        const [detailIndex, setDetailIndex] = useState(0);
        useEffect(() => setDetailIndex(0), [category]);
        return <button onClick={() => setDetailIndex(value => value + 1)}>{detailIndex}</button>;
      }
    `),
    ["review-state", "review-effect"]
  );
});

test("keeps an expression-bodied external subscription as lifecycle ownership", () => {
  assert.deepEqual(
    actions(`
      import { useEffect } from "react";
      export function Bridge({ source }: { source: { subscribe: (fn: () => void) => () => void } }) {
        useEffect(() => source.subscribe(() => refresh()), [source]);
        return null;
      }
    `),
    ["keep-effect"]
  );
});

test("does not mistake an expression-bodied React setter for cleanup", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useState } from "react";
      export function Results({ query }: { query: string }) {
        const [page, setPage] = useState(1);
        useEffect(() => setPage(1), [query]);
        return <Pager page={page} onChange={setPage} />;
      }
    `),
    ["review-state", "review-effect"]
  );
});

test("does not mistake an arbitrary expression-bodied callback call for cleanup", () => {
  assert.deepEqual(
    actions(`
      import { useEffect } from "react";
      export function Reporter({ result }: { result: unknown }) {
        useEffect(() => onResult(result), [result]);
        return null;
      }
    `),
    ["review-effect"]
  );
});

test("replaces a React mirror written only by a Legend reaction with useValue", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      import { useObserveEffect } from "@legendapp/state/react";
      export function Content({ activeId$ }: { activeId$: unknown }) {
        const [isOpen, setIsOpen] = useState(false);
        useObserveEffect(() => { setIsOpen(activeId$.get() === "menu"); });
        return isOpen ? <Menu /> : null;
      }
    `),
    ["use-value"]
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
    ["keep-state", "keep-state"]
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
    []
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
    ["review-state"]
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
    ["review-state"]
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
    ["keep-state"]
  );
});

test("suggests a ref for command-only state that never reaches rendering", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Actions() {
        const [busy, setBusy] = useState(false);
        const run = async () => {
          if (busy) return;
          setBusy(true);
          await work();
          setBusy(false);
        };
        return <Button onPress={run} />;
      }
    `),
    ["use-ref"]
  );
});

test("does not call lifecycle or render-callback state command-only", () => {
  const listener = analyzeSource(`
      import { useCallback, useEffect, useState } from "react";
      export function Listener() {
        const [active, setActive] = useState(false);
        const report = useCallback(() => send(active), [active]);
        useEffect(report, [report]);
        return <Button onPress={() => { if (active) setActive(false); }} />;
      }
    `, "fixture.tsx").find(finding => finding.hook === "useState");
  assert.equal(listener?.action, "review-state");

  const renderCallback = analyzeSource(`
      import { useCallback, useState } from "react";
      export function Results({ rows }: { rows: Array<{ id: string }> }) {
        const [selected, setSelected] = useState<string | null>(null);
        const renderItem = useCallback(({ item }: { item: { id: string } }) => (
          <Row active={selected === item.id} />
        ), [selected]);
        return <><List data={rows} renderItem={renderItem} />
          <Button onPress={() => { if (selected) setSelected(null); }} /></>;
      }
    `, "fixture.tsx").find(finding => finding.hook === "useState");
  assert.notEqual(renderCallback?.action, "use-ref");
});

test("deletes setter-only state when no assigned value is consumed", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Image() {
        const [_hasError, setHasError] = useState(false);
        const retry = () => setHasError(false);
        return <Button onPress={retry} />;
      }
    `),
    ["delete-unused-state"]
  );
});

test("deletes setter-only state written by an effect when arguments are discardable", () => {
  const findings = analyzeSource(`
    import { useEffect, useState } from "react";
    export function Resource() {
      const [_failed, setFailed] = useState(false);
      useEffect(() => { setFailed(false); start().catch(() => setFailed(true)); }, []);
      return <Content />;
    }
  `, "fixture.tsx");
  assert.equal(findings.find(finding => finding.name === "_failed")?.action, "delete-unused-state");
});

test("does not delete setter-only state when removing the call would erase side effects", () => {
  for (const write of ["recordAndReturnValue()", "++sequence"]) {
    assert.deepEqual(
      actions(`
      import { useState } from "react";
      let sequence = 0;
      export function Resource() {
        const [_value, setValue] = useState(0);
        return <button onClick={() => setValue(${write})}>Run</button>;
      }
      `),
      ["review-state"]
    );
  }
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
    ["review-state"]
  );
});

test("treats useCallback dependencies as deferred command reads", () => {
  assert.deepEqual(
    actions(`
      import { useCallback, useState } from "react";
      export function Slider() {
        const [width, setWidth] = useState(0);
        const update = useCallback((x: number) => save(x / width), [width]);
        return <Track onLayout={event => setWidth(event.width)} onMove={update} />;
      }
    `),
    ["use-ref"]
  );
});

test("traces a state-backed local callable when JSX invokes it synchronously", () => {
  const [finding] = analyzeSource(`
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
  `, "fixture.tsx");
  assert.equal(finding?.action, "review-state");
  assert.match(finding?.evidence.join(" ") ?? "", /reads: render 1/);
});

test("separates observable ownership from leaf subscription placement", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    function Row() { return null; }
    export function LargeOwner({ rows }: { rows: string[] }) {
      ${Array.from({ length: 145 }, (_, index) => `const padding${index} = ${index};`).join("\n")}
      const [selected, setSelected] = useState<string | null>(null);
      return rows.map(id => <Row selected={selected} onSelect={setSelected} />);
    }
  `, "fixture.tsx");
  assert.deepEqual(finding?.stateModel, {
    ownership: "local-observable",
    subscription: "leaf-use-value",
  });
});

test("moves a scalar row cursor into stable per-row equality selectors", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function Results({ rows }: { rows: Array<{ id: string }> }) {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      const choose = (id: string) => setSelectedId(id);
      const accept = () => selectedId && save(selectedId);
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions onAccept={accept} />
        <Status /><Help /><Footer /><Sidebar /><Banner /><Search /><Preview />
        {rows.map(row => <Row key={row.id} selected={selectedId === row.id} onPress={() => choose(row.id)} />)}
      </Screen>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /scalar row-selection/);
});

test("recognizes an index cursor and a one-hop row presentation alias", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function Results({ rows }: { rows: Array<{ id: string }> }) {
      const [selectedIndex, setSelectedIndex] = useState(-1);
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status />
        <Help /><Footer /><Sidebar /><Banner /><Search /><Preview />
        {rows.map((row, index) => {
          const active = selectedIndex === index;
          return <Row key={row.id} active={active} onPointerMove={() => setSelectedIndex(index)} />;
        })}
      </Screen>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
});

test("does not mistake a nullish row prop projection for a row mount gate", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function Results({ rows, activeStyle }: { rows: Array<{ id: string }>; activeStyle: unknown }) {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status />
        <Help /><Footer /><Sidebar /><Banner /><Search /><Preview />
        {rows.map(row => {
          const selected = selectedId === row.id;
          return <Row key={row.id} selected={selected}
            hoverStyle={selected ? activeStyle : undefined}
            onPointerMove={() => setSelectedId(row.id)} />;
        })}
      </Screen>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
});

test("allows a row-only event path when a separate reset co-writes companion state", () => {
  const findings = analyzeSource(`
    import { useState } from "react";
    export function Results({ rows }: { rows: Array<{ id: string }> }) {
      const [query, setQuery] = useState("");
      const [selectedIndex, setSelectedIndex] = useState(-1);
      const reset = () => { setQuery(""); setSelectedIndex(-1); };
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions onReset={reset} />
        <Status /><Help /><Footer /><Sidebar /><Banner /><Search /><Preview />
        {rows.map((row, index) => <Row key={row.id} active={selectedIndex === index}
          onPointerMove={() => setSelectedIndex(index)} />)}
      </Screen>;
    }
  `, "fixture.tsx");
  assert.equal(findings.find(finding => finding.name === "selectedIndex")?.action, "use-observable");
});

test("requires scalar selectors to depend on a stable repeated item key", () => {
  for (const rows of [
    `rows.map(row => <Row key={row.id} selected={selectedId === activeId} onPress={() => setSelectedId(row.id)} />)`,
    `rows.map((row, index) => <Row key={index} selected={selectedId === row.id} onPress={() => setSelectedId(row.id)} />)`,
    `rows.map(row => <Row selected={selectedId === row.id} onPress={() => setSelectedId(row.id)} />)`,
  ]) {
    const finding = analyzeSource(`
      import { useState } from "react";
      export function Results({ rows, activeId }: { rows: Array<{ id: string }>; activeId: string }) {
        const [selectedId, setSelectedId] = useState<string | null>(null);
        return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status />
          <Help /><Footer /><Sidebar /><Banner /><Search /><Preview />{${rows}}
        </Screen>;
      }
    `, "fixture.tsx").find(candidate => candidate.name === "selectedId");
    assert.notEqual(finding?.action, "use-observable");
  }
});

test("does not put a scalar selector inside its own row mount gate", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function Results({ rows }: { rows: Array<{ id: string }> }) {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status />
        <Help /><Footer /><Sidebar /><Banner /><Search /><Preview />
        {rows.map(row => selectedId === row.id && <Row key={row.id} onPress={() => setSelectedId(row.id)} />)}
      </Screen>;
    }
  `, "fixture.tsx");
  assert.notEqual(finding?.action, "use-observable");
});

test("keeps scalar selection that has effects, broadcast row reads, or no independent write", () => {
  const sources = [
    `useEffect(() => report(selectedId), [selectedId]);
     return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status /><Help /><Footer /><Sidebar /><Banner /><Search /><Preview />
       {rows.map(row => <Row key={row.id} selected={selectedId === row.id} onPress={() => setSelectedId(row.id)} />)}</Screen>;`,
    `return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status /><Help /><Footer /><Sidebar /><Banner /><Search /><Preview />
       {rows.map(row => <Row key={row.id} selected={selectedId === row.id} anySelected={selectedId !== null} onPress={() => setSelectedId(row.id)} />)}</Screen>;`,
    `const open = (id: string) => { setDirty(true); setSelectedId(id); };
     return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status /><Help /><Footer /><Sidebar /><Banner /><Search /><Preview />
       {rows.map(row => <Row key={row.id} selected={selectedId === row.id} onPress={() => open(row.id)} />)}</Screen>;`,
    `return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status /><Help /><Footer /><Sidebar /><Banner /><Search /><Preview />
       {rows.map(row => <Row key={row.id} selected={selectedId === row.id}
         onPress={() => setSelectedId(previous => { audit(previous); return row.id; })} />)}</Screen>;`,
  ];
  for (const body of sources) {
    const finding = analyzeSource(`
      import { useEffect, useState } from "react";
      export function Results({ rows }: { rows: Array<{ id: string }> }) {
        const [dirty, setDirty] = useState(false);
        const [selectedId, setSelectedId] = useState<string | null>(null);
        ${body}
      }
    `, "fixture.tsx").find(candidate => candidate.name === "selectedId");
    assert.notEqual(finding?.action, "use-observable");
  }
});

test("isolates row selection and a selected-item footer into separate subscribers", () => {
  const finding = analyzeSource(`
    import { useState } from "react";
    export function Results({ rows }: { rows: Array<{ id: string }> }) {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      const selected = rows.find(row => row.id === selectedId) ?? null;
      const accept = () => selected && save(selected);
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Status /><Help />
        <Sidebar /><Banner /><Search /><Preview />
        {rows.map(row => <Row key={row.id} selected={selectedId === row.id}
          onPress={() => setSelectedId(row.id)} />)}
        <Footer disabled={!selected} onAccept={accept} />
      </Screen>;
    }
  `, "fixture.tsx").find(candidate => candidate.name === "selectedId");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /footer or detail/);
});

test("isolates a row-selected id and its non-null footer summary", () => {
  const finding = analyzeSource(`
    import { useState } from "react";
    export function Results({ rows }: { rows: Array<{ id: string }> }) {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      const hasSelection = selectedId !== null;
      const accept = () => selectedId && save(selectedId);
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Status /><Help />
        <Sidebar /><Banner /><Search /><Preview />
        {rows.map(row => <Row key={row.id} selected={selectedId === row.id}
          onPress={() => setSelectedId(row.id)} />)}
        <Footer enabled={hasSelection} onAccept={accept} />
      </Screen>;
    }
  `, "fixture.tsx").find(candidate => candidate.name === "selectedId");
  assert.equal(finding?.action, "use-observable");
});

test("isolates a repeated row command and one selected-item detail leaf", () => {
  const finding = analyzeSource(`
    import { useState } from "react";
    export function Results({ rows, loading }: { rows: Array<{ id: string }>; loading: boolean }) {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      const selected = rows.find(row => row.id === selectedId) ?? null;
      if (loading) return <Loading />;
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Status /><Help />
        <Sidebar /><Banner /><Search /><Preview />
        {rows.map(row => <Row key={row.id} onPress={() => setSelectedId(row.id)} />)}
        <Detail item={selected} open={selected !== null} onClose={() => setSelectedId(null)} />
      </Screen>;
    }
  `, "fixture.tsx").find(candidate => candidate.name === "selectedId");
  assert.equal(finding?.action, "use-observable");
});

test("isolates an object selection payload across keyed rows and one footer", () => {
  const finding = analyzeSource(`
    import { useState } from "react";
    type Item = { id: string; disabled: boolean };
    export function Results({ rows }: { rows: Item[] }) {
      const [selected, setSelected] = useState<Item | null>(null);
      const accept = () => selected && save(selected.id);
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Status /><Help />
        <Sidebar /><Banner /><Search /><Preview />
        {rows.map(row => <Row key={row.id} selected={selected?.id === row.id}
          onPress={() => setSelected(row)} />)}
        <Footer disabled={!selected || selected.disabled} onAccept={accept} />
      </Screen>;
    }
  `, "fixture.tsx").find(candidate => candidate.name === "selected");
  assert.equal(finding?.action, "use-observable");
});

test("keeps keyed selection whose secondary reads span the owner", () => {
  const finding = analyzeSource(`
    import { useState } from "react";
    export function Results({ rows }: { rows: Array<{ id: string }> }) {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      const selected = rows.find(row => row.id === selectedId) ?? null;
      return <Screen>
        <Header selected={selected} /><Toolbar /><Summary /><Filters /><Status /><Help />
        {rows.map(row => <Row key={row.id} selected={selectedId === row.id}
          onPress={() => setSelectedId(row.id)} />)}
        <Sidebar /><Banner /><Search /><Preview /><Footer selected={selected} />
      </Screen>;
    }
  `, "fixture.tsx").find(candidate => candidate.name === "selectedId");
  assert.equal(finding?.action, "review-state");
});

test("keeps scalar selection that changes list shape or lacks an item-keyed producer", () => {
  for (const body of [
    `const visible = rows.filter(row => row.id === selectedId);
     return <Screen><Header /><Toolbar /><Summary /><Filters /><Status /><Help /><Sidebar /><Banner /><Search /><Preview />
       {rows.map(row => <Row key={row.id} selected={selectedId === row.id} onPress={() => setSelectedId(row.id)} />)}
       <List rows={visible} />
     </Screen>;`,
    `const selected = rows.find(row => { audit(row); return row.id === selectedId; }) ?? null;
     return <Screen><Header /><Toolbar /><Summary /><Filters /><Status /><Help /><Sidebar /><Banner /><Search /><Preview />
       {rows.map(row => <Row key={row.id} onPress={() => setSelectedId("fixed")} />)}
       <Detail item={selected} />
     </Screen>;`,
    `const selected = rows.find(row => row.id === selectedId) ?? null;
     return <Screen><Header /><Toolbar /><Summary /><Filters /><Status /><Help /><Sidebar /><Banner /><Search /><Preview />
       {rows.map(row => <Row key={row.id} onPress={() => setSelectedId(row.id)} />)}
       <Panel renderFooter={() => <Footer selected={selected} />} />
     </Screen>;`,
  ]) {
    const finding = analyzeSource(`
      import { useState } from "react";
      export function Results({ rows }: { rows: Array<{ id: string }> }) {
        const [selectedId, setSelectedId] = useState<string | null>(null);
        ${body}
      }
    `, "fixture.tsx").find(candidate => candidate.name === "selectedId");
    assert.equal(finding?.action, "review-state");
  }
});

test("accepts a memoized event command whose binding matches its JSX prop name", () => {
  const finding = analyzeSource(`
    import { useCallback, useState } from "react";
    export function Results({ rows }: { rows: Array<{ id: string; run: () => void }> }) {
      const [selectedIndex, setSelectedIndex] = useState(0);
      const onKeyDown = useCallback(() => rows[selectedIndex]?.run(), [rows, selectedIndex]);
      return <Screen onKeyDown={onKeyDown}><Header /><Toolbar /><Summary /><Filters /><Status /><Help />
        <Sidebar /><Banner /><Search /><Preview /><Actions /><Footer />
        {rows.map((row, index) => <Row key={row.id} selected={selectedIndex === index}
          onPointerMove={() => setSelectedIndex(index)} />)}
      </Screen>;
    }
  `, "fixture.tsx").find(candidate => candidate.name === "selectedIndex");
  assert.equal(finding?.action, "use-observable");
});

test("keeps a row cursor whose callback is stale or also owns external lifecycle", () => {
  for (const callback of [
    `const onKeyDown = useCallback(() => rows[selectedIndex]?.run(), []);`,
    `const onKeyDown = useCallback(() => rows[selectedIndex]?.run(), [rows, selectedIndex]);
     useEffect(() => subscribe(onKeyDown), [onKeyDown]);`,
  ]) {
    const finding = analyzeSource(`
      import { useCallback, useEffect, useState } from "react";
      export function Results({ rows }: { rows: Array<{ id: string; run: () => void }> }) {
        const [selectedIndex, setSelectedIndex] = useState(0);
        ${callback}
        return <Screen onKeyDown={onKeyDown}><Header /><Toolbar /><Summary /><Filters /><Status /><Help />
          <Sidebar /><Banner /><Search /><Preview /><Actions /><Footer />
          {rows.map((row, index) => <Row key={row.id} selected={selectedIndex === index}
            onPointerMove={() => setSelectedIndex(index)} />)}
        </Screen>;
      }
    `, "fixture.tsx").find(candidate => candidate.name === "selectedIndex");
    assert.equal(finding?.action, "review-state");
  }
});

test("moves keyed collection membership into repeated row subscriptions", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function SelectionScreen({ rows }: { rows: Array<{ id: string }> }) {
      const [selected, setSelected] = useState<Set<string>>(() => new Set());
      const toggle = (id: string) => setSelected(previous => {
        const next = new Set(previous);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
      return <Screen><Header /><Toolbar /><Summary count={selected.size} /><Filters /><Actions /><Status /><Help /><Footer /><Sidebar /><Banner /><Search />
        {rows.map(row => <Row key={row.id} selected={selected.has(row.id)} onPress={() => toggle(row.id)} />)}
      </Screen>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /per-row/);
});

test("recognizes an array selection normalized by one immutable local Set", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function SelectionScreen({ rows }: { rows: Array<{ id: string }> }) {
      const [selectedIds, setSelectedIds] = useState<string[]>([]);
      const selectedIdSet = new Set(selectedIds);
      const selectedCount = selectedIds.length;
      const toggle = (id: string) => setSelectedIds(previous =>
        previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]
      );
      const submit = () => save(selectedIds);
      return <Screen><Header /><Toolbar count={selectedCount} /><Summary /><Filters /><Actions onSubmit={submit} />
        <Status /><Help /><Footer /><Sidebar /><Banner /><Search />
        {rows.map(row => <Row key={row.id} selected={selectedIdSet.has(row.id)} onPress={() => toggle(row.id)} />)}
      </Screen>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /per-row/);
});

test("requires an immutable non-escaping Set normalization for array selection", () => {
  const mutable = `
    import { useState } from "react";
    export function Screen({ rows }: { rows: Array<{ id: string }> }) {
      const [selectedIds, setSelectedIds] = useState<string[]>([]);
      let selectedIdSet = new Set(selectedIds);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <Actions /><Preview />{rows.map(row => <Row key={row.id} selected={selectedIdSet.has(row.id)} />)}</main>;
    }
  `;
  const escaped = mutable
    .replace("let selectedIdSet", "const selectedIdSet")
    .replace("return <main>", "inspect(selectedIdSet); return <main>");
  for (const source of [mutable, escaped]) {
    const finding = analyzeSource(source, "screen.tsx").find(candidate => candidate.name === "selectedIds");
    assert.notEqual(finding?.action, "use-observable");
  }
});

test("does not move array selection when a summary alias controls repeated mounting", () => {
  const source = `
    import { useState } from "react";
    export function Screen({ rows }: { rows: Array<{ id: string }> }) {
      const [selectedIds, setSelectedIds] = useState<string[]>([]);
      const selectedIdSet = new Set(selectedIds);
      const hasSelection = selectedIds.length > 0;
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <Actions /><Preview />{rows.map(row => hasSelection &&
          <Row key={row.id} selected={selectedIdSet.has(row.id)} />)}</main>;
    }
  `;
  const finding = analyzeSource(source, "screen.tsx").find(candidate => candidate.name === "selectedIds");
  assert.notEqual(finding?.action, "use-observable");
});

test("recognizes keyed collection membership in a JSX renderItem callback", () => {
  const [finding] = analyzeSource(`
    import { useCallback, useState } from "react";
    export function SelectionScreen({ rows }: { rows: Array<{ id: string }> }) {
      const [selected, setSelected] = useState<Set<string>>(() => new Set());
      const renderItem = useCallback(({ item }: { item: { id: string } }) =>
        <Row selected={selected.has(item.id)} onPress={() => setSelected(new Set([item.id]))} />,
        [selected]
      );
      return <Screen><Header /><Toolbar /><Summary count={selected.size} /><Filters /><Actions /><Status /><Help /><Footer /><Sidebar /><Banner /><Search />
        <List data={rows} renderItem={renderItem} extraData={selected} />
      </Screen>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
});

test("keeps filtered array selection as review without a general cross-value proof", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function SelectionScreen({ rows, visibleIds }: { rows: Array<{ id: string }>; visibleIds: Set<string> }) {
      const [selectedIds, setSelectedIds] = useState<string[]>([]);
      const activeSelection = selectedIds.filter(id => visibleIds.has(id));
      const activeSelectionSet = new Set(activeSelection);
      return <Screen><Header /><Toolbar /><Summary count={activeSelection.length} /><Filters /><Actions /><Status /><Help /><Footer /><Sidebar /><Banner /><Search />
        {rows.map(row => <Row key={row.id} selected={activeSelectionSet.has(row.id)} onPress={() => setSelectedIds([row.id])} />)}
      </Screen>;
    }
  `, "fixture.tsx");
  assert.notEqual(finding?.action, "use-observable");
});

test("does not call array filtering that changes row membership a keyed leaf selection", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function FilteredRows({ rows }: { rows: Array<{ id: string }> }) {
      const [selectedIds, setSelectedIds] = useState<string[]>([]);
      const visibleRows = rows.filter(row => selectedIds.includes(row.id));
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status /><Help /><Footer /><Sidebar /><Banner /><Search />
        {visibleRows.map(row => <Row key={row.id} onPress={() => setSelectedIds([row.id])} />)}
      </Screen>;
    }
  `, "fixture.tsx");
  assert.notEqual(finding?.action, "use-observable");
});

test("does not trace an arbitrary filtered array into keyed membership", () => {
  const source = `
    import { useState } from "react";
    export function Screen({ rows }: { rows: Array<{ id: string; enabled: boolean }> }) {
      const [selectedIds, setSelectedIds] = useState<string[]>([]);
      const active = selectedIds.filter(id => normalize(id));
      const activeSet = new Set(active);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <Actions /><Preview />{rows.map(row => <Row key={row.id} selected={activeSet.has(row.id)} />)}</main>;
    }
  `;
  const finding = analyzeSource(source, "screen.tsx").find(candidate => candidate.name === "selectedIds");
  assert.notEqual(finding?.action, "use-observable");
});

test("does not move a derived keyed alias read by an effect", () => {
  const source = `
    import { useEffect, useState } from "react";
    export function Screen({ rows }: { rows: Array<{ id: string }> }) {
      const [selected, setSelected] = useState<Set<string>>(() => new Set());
      useEffect(() => report(selected.size), [selected]);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <Actions /><Preview />{rows.map(row => <Row key={row.id} selected={selected.has(row.id)} />)}</main>;
    }
  `;
  const finding = analyzeSource(source, "screen.tsx").find(candidate => candidate.name === "selected");
  assert.notEqual(finding?.action, "use-observable");
});

test("requires derived membership to use the repeated row key", () => {
  const source = `
    import { useState } from "react";
    export function Screen({ rows, activeId }: { rows: Array<{ id: string }>; activeId: string }) {
      const [selected, setSelected] = useState<Set<string>>(() => new Set());
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <Actions /><Preview />{rows.map(row => <Row key={row.id} selected={selected.has(activeId)} />)}</main>;
    }
  `;
  const finding = analyzeSource(source, "screen.tsx").find(candidate => candidate.name === "selected");
  assert.notEqual(finding?.action, "use-observable");
});

test("requires a stable item-derived key for mapped membership", () => {
  const source = `
    import { useState } from "react";
    export function Screen({ rows }: { rows: Array<{ id: string }> }) {
      const [selected, setSelected] = useState<Set<string>>(() => new Set());
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <Actions /><Preview />{rows.map((row, index) => <Row key={index} selected={selected.has(row.id)} />)}</main>;
    }
  `;
  const finding = analyzeSource(source, "screen.tsx").find(candidate => candidate.name === "selected");
  assert.notEqual(finding?.action, "use-observable");
});

test("does not treat render-prop reads as selection commands", () => {
  const source = `
    import { useState } from "react";
    export function Screen({ rows }: { rows: Array<{ id: string }> }) {
      const [selected, setSelected] = useState<Set<string>>(() => new Set());
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <Actions /><Preview /><Panel renderLabel={() => Array.from(selected).join(",")} />
        {rows.map(row => <Row key={row.id} selected={selected.has(row.id)} />)}</main>;
    }
  `;
  const finding = analyzeSource(source, "screen.tsx").find(candidate => candidate.name === "selected");
  assert.notEqual(finding?.action, "use-observable");
});

test("requires immutable aliases and a stable filter membership source", () => {
  const mutable = `
    import { useState } from "react";
    export function Screen({ rows, visible }: { rows: Array<{ id: string }>; visible: Set<string> }) {
      const [selectedIds, setSelectedIds] = useState<string[]>([]);
      let active = selectedIds.filter(id => visible.has(id));
      let selected = new Set(active);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <Actions /><Preview />{rows.map(row => <Row key={row.id} selected={selected.has(row.id)} />)}</main>;
    }
  `;
  const opaque = mutable
    .replace("let active", "const active")
    .replace("let selected", "const selected")
    .replace("visible.has(id)", "registry().has(id)");
  for (const source of [mutable, opaque]) {
    const finding = analyzeSource(source, "screen.tsx").find(candidate => candidate.name === "selectedIds");
    assert.notEqual(finding?.action, "use-observable");
  }
});

test("does not place a collection summary subscription inside every row", () => {
  const source = `
    import { useState } from "react";
    export function Screen({ rows }: { rows: Array<{ id: string }> }) {
      const [selected, setSelected] = useState<Set<string>>(() => new Set());
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <Actions /><Preview />{rows.map(row => <section key={row.id}>
          <Row selected={selected.has(row.id)} /><span>{selected.size}</span>
        </section>)}</main>;
    }
  `;
  const finding = analyzeSource(source, "screen.tsx").find(candidate => candidate.name === "selected");
  assert.notEqual(finding?.action, "use-observable");
});

test("does not move lifecycle membership that controls whether a row exists", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function PremountedSteps({ steps }: { steps: string[] }) {
      const [mounted, setMounted] = useState<Set<number>>(() => new Set([0]));
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status /><Help /><Footer /><Sidebar /><Banner /><Search />
        {steps.map((step, index) => {
          if (!mounted.has(index)) return null;
          return <Step key={step} onReady={() => setMounted(previous => new Set(previous).add(index))} />;
        })}
      </Screen>;
    }
  `, "fixture.tsx");
  assert.notEqual(finding?.action, "use-observable");
});

test("does not bypass keyed mount-control checks through a local boolean alias", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function FilteredRows({ rows }: { rows: Array<{ id: string }> }) {
      const [selected, setSelected] = useState<Set<string>>(() => new Set());
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status /><Help /><Footer /><Sidebar /><Banner /><Search />
        {rows.map(row => {
          const shown = selected.has(row.id);
          if (!shown) return null;
          return <Row key={row.id} onPress={() => setSelected(new Set([row.id]))} />;
        })}
      </Screen>;
    }
  `, "fixture.tsx");
  assert.notEqual(finding?.action, "use-observable");
});

test("converts a custom-hook selection cluster into one observable model", () => {
  const findings = analyzeSource(`
    import { useCallback, useState } from "react";
    export function useSelection<T>() {
      const [selecting, setSelecting] = useState(false);
      const [selected, setSelected] = useState<Set<T>>(() => new Set<T>());
      const toggle = useCallback((id: T) => {
        setSelecting(true);
        setSelected(previous => new Set(previous).add(id));
      }, []);
      return { selecting, selected, toggle };
    }
  `, "fixture.ts");
  assert.deepEqual(findings.map(finding => finding.action), ["use-observable", "use-observable"]);
  assert.ok(findings.every(finding => finding.stateModel?.ownership === "local-observable"));
});

test("does not call an ordinary custom-hook Set resource a selection model without a setter", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function useCache() {
      const [cache] = useState<Set<string>>(() => new Set());
      return cache;
    }
  `, "fixture.ts");
  assert.equal(finding?.action, "keep-state");
});

test("does not call custom-hook lifecycle bookkeeping a selection model", () => {
  const [finding] = analyzeSource(`
    import { useEffect, useState } from "react";
    export function usePremountedSteps(step: number) {
      const [mounted, setMounted] = useState<ReadonlySet<number>>(() => new Set([step]));
      useEffect(() => { setMounted(previous => new Set(previous).add(step)); }, [step]);
      return mounted;
    }
  `, "fixture.ts");
  assert.equal(finding?.action, "review-state");
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
    ["review-state"]
  );
});

test("keeps an effect with paired cleanup", () => {
  assert.deepEqual(
    actions(`
      import { useEffect } from "react";
      export function Online() {
        useEffect(() => {
          window.addEventListener("online", onOnline);
          return () => window.removeEventListener("online", onOnline);
        }, []);
        return null;
      }
    `),
    ["keep-effect"]
  );
});

test("moves a one-shot deferred reveal sink to an observable leaf without replacing its effect", () => {
  const findings = analyzeSource(`
    import { useEffect, useState } from "react";
    export function Screen() {
      const [ready, setReady] = useState(false);
      useEffect(() => {
        const handle = requestIdleCallback(() => setReady(true));
        return () => cancelIdleCallback(handle);
      }, []);
      return ready ? <HeavyLeaf /> : <Placeholder />;
    }
  `, "fixture.tsx");
  assert.equal(findings.find(finding => finding.name === "ready")?.action, "use-observable");
  assert.equal(findings.find(finding => finding.hook === "useEffect")?.action, "keep-effect");
});

test("recognizes a one-shot render gate that returns a unique const JSX alias", () => {
  const findings = analyzeSource(`
    import { useEffect, useState } from "react";
    export function Screen() {
      const [ready, setReady] = useState(false);
      useEffect(() => {
        const handle = requestIdleCallback(() => setReady(true));
        return () => cancelIdleCallback(handle);
      }, []);
      const placeholder = <Placeholder />;
      if (!ready) return placeholder;
      return <HeavyLeaf />;
    }
  `, "fixture.tsx");
  assert.equal(findings.find(finding => finding.name === "ready")?.action, "use-observable");
});

test("does not treat a nested function JSX return as the owner's render gate", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useState } from "react";
      export function Screen() {
        const [ready, setReady] = useState(false);
        useEffect(() => {
          const handle = requestIdleCallback(() => setReady(true));
          return () => cancelIdleCallback(handle);
        }, []);
        if (ready) {
          const renderLater = () => <HeavyLeaf />;
          report(renderLater);
        }
        return <Placeholder />;
      }
    `),
    ["review-state", "keep-effect"]
  );
});

test("does not promote a multi-phase or dependency-rearmed reveal sink", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useState } from "react";
      export function Screen({ enabled }: { enabled: boolean }) {
        const [phase, setPhase] = useState(0);
        useEffect(() => {
          const handle = requestAnimationFrame(() => { setPhase(1); setPhase(2); });
          return () => cancelAnimationFrame(handle);
        }, [enabled]);
        return phase > 0 ? <HeavyLeaf /> : <Placeholder />;
      }
    `),
    ["review-state", "keep-effect"]
  );
});

test("does not promote deferred booleans used outside a render-selecting gate", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useState } from "react";
      export function Screen({ label }: { label: string }) {
        const [ready, setReady] = useState(false);
        useEffect(() => {
          const handle = requestIdleCallback(() => setReady(true));
          return () => cancelIdleCallback(handle);
        }, []);
        if (ready) reportReady();
        return <div>{label && ready}</div>;
      }
    `),
    ["review-state", "keep-effect"]
  );
});

test("does not promote an unreachable nested deferred setter or shadowed cleanup handle", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useState } from "react";
      export function Screen() {
        const [ready, setReady] = useState(false);
        useEffect(() => {
          const handle = requestIdleCallback(() => {
            const never = () => setReady(true);
          });
          return (handle = 1) => cancelIdleCallback(handle);
        }, []);
        return ready ? <HeavyLeaf /> : <Placeholder />;
      }
    `),
    ["review-state", "keep-effect"]
  );
});

test("matches deferred reveal setters independently in different owners", () => {
  const findings = analyzeSource(`
    import { useEffect, useState } from "react";
    export function First() {
      const [ready, setReady] = useState(false);
      useEffect(() => { const h = requestIdleCallback(() => setReady(true)); return () => cancelIdleCallback(h); }, []);
      return ready ? <FirstLeaf /> : null;
    }
    export function Second() {
      const [ready, setReady] = useState(false);
      useEffect(() => { const h = requestAnimationFrame(() => setReady(true)); return () => cancelAnimationFrame(h); }, []);
      return ready ? <SecondLeaf /> : null;
    }
  `, "fixture.tsx");
  assert.deepEqual(
    findings.filter(finding => finding.hook === "useState").map(finding => finding.action),
    ["use-observable", "use-observable"]
  );
});

test("scopes Legend hook provenance to the owning function", () => {
  const findings = analyzeSource(`
    import { useEffect } from "react";
    import { useValue } from "@legendapp/state/react";
    export function First({ open$ }: { open$: unknown }) {
      const isOpen = useValue(open$);
      return isOpen ? <Panel /> : null;
    }
    export function Second({ isOpen }: { isOpen: boolean }) {
      useEffect(() => report(isOpen), [isOpen]);
      return null;
    }
  `, "fixture.tsx");
  assert.equal(findings.find(finding => finding.hook === "useEffect")?.action, "review-effect");
});

test("rejects same-owner shadowed Legend hook provenance", () => {
  const findings = analyzeSource(`
    import { useEffect } from "react";
    import { useValue } from "@legendapp/state/react";
    export function Screen({ open$ }: { open$: unknown }) {
      const value = useValue(open$);
      const reportOther = (value: boolean) => value;
      useEffect(() => report(value), [value]);
      return reportOther(false) ? <Panel /> : null;
    }
  `, "fixture.tsx");
  assert.equal(findings.find(finding => finding.hook === "useEffect")?.action, "review-effect");
});

test("reviews setup-only empty effects because useMount changes Strict Mode semantics", () => {
  assert.deepEqual(
    actions(`
      import { useEffect } from "react";
      export function Analytics() {
        useEffect(() => { trackVisit(); }, []);
        return null;
      }
    `),
    ["review-effect"]
  );
});

test("keeps one dependency-driven external resource command in React", () => {
  const effects = analyzeSource(`
    import { useEffect } from "react";
    import { openWorkspace } from "./workspace";
    export function Workspace({ policyId }: { policyId: string | null }) {
      useEffect(() => {
        if (!policyId) return;
        openWorkspace(policyId);
      }, [policyId]);
      return null;
    }
    export function Documents({ client, enabled }: { client: { fetch: () => void }; enabled: boolean }) {
      useEffect(() => {
        if (enabled) void client.fetch();
      }, [client, enabled]);
      return null;
    }
  `, "fixture.tsx").filter(finding => finding.hook === "useEffect");
  assert.deepEqual(effects.map(finding => finding.action), ["keep-effect", "keep-effect"]);
});

test("reviews local-state, helper, scheduled, multi-command, collection, and subscription effects", () => {
  const effects = analyzeSource(`
    import { useEffect, useState } from "react";
    import { fetchResource, reportResource, subscribeToResource } from "./resource";
    export function Screen({ id }: { id: string }) {
      const [query, setQuery] = useState("");
      const load = () => fetchResource(id);
      useEffect(() => { fetchResource(query); }, [query]);
      useEffect(() => { load(); }, [load]);
      useEffect(() => { setTimeout(() => fetchResource(id), 10); }, [id]);
      useEffect(() => { fetchResource(id); reportResource(id); }, [id]);
      useEffect(() => { [id].forEach(value => fetchResource(value)); }, [id]);
      useEffect(() => { subscribeToResource(id); }, [id]);
      return <input value={query} onChange={event => setQuery(event.target.value)} />;
    }
  `, "fixture.tsx").filter(finding => finding.hook === "useEffect");
  assert.deepEqual(effects.map(finding => finding.action), [
    "review-effect",
    "review-effect",
    "review-effect",
    "review-effect",
    "review-effect",
    "review-effect",
  ]);
});

test("keeps effects that operate on committed refs", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useRef, useState } from "react";
      export function Screen({ open }: { open: boolean }) {
        const inputRef = useRef<HTMLInputElement>(null);
        const containerRef = useRef<HTMLDivElement>(null);
        const [container, setContainer] = useState<HTMLDivElement | null>(null);
        useEffect(() => { inputRef.current?.focus(); }, [open]);
        useEffect(() => { setContainer(containerRef.current); }, [containerRef]);
        useEffect(() => { setTimeout(() => inputRef.current?.focus(), 0); }, []);
        return <><input ref={inputRef} /><div ref={containerRef}>{container?.id}</div></>;
      }
    `),
    ["review-state", "keep-effect", "keep-effect", "keep-effect"]
  );
});

test("reviews empty ref effects that intentionally capture a render snapshot", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useRef } from "react";
      export function Screen({ scrollPosition }: { scrollPosition: number }) {
        const containerRef = useRef<HTMLDivElement>(null);
        useEffect(() => {
          if (scrollPosition > 0) containerRef.current?.scrollTo(0, scrollPosition);
        }, []);
        return <div ref={containerRef} />;
      }
    `),
    ["review-effect"]
  );
});

test("does not call a latest-value ref mirror post-commit integration", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useRef } from "react";
      export function Screen({ value }: { value: string }) {
        const latest = useRef(value);
        useEffect(() => { latest.current = value; }, [value]);
        return null;
      }
    `),
    ["review-effect"]
  );
});

test("suggests useMount only for module-global setup without owner-local captures", () => {
  const [finding] = analyzeSource(`
    import { useEffect } from "react";
    import { warmCache } from "./cache";
    export function App() {
      useEffect(() => { warmCache(); }, []);
      return null;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-mount");
  assert.equal(finding?.disposition, "candidate");

  assert.deepEqual(
    actions(`
      import { useEffect } from "react";
      export function App({ client }: { client: { warm: () => void } }) {
        useEffect(() => { client.warm(); }, []);
        return null;
      }
    `),
    ["review-effect"]
  );
});

test("suggests useObserveEffect only for dependencies sourced from useValue", () => {
  assert.deepEqual(
    actions(`
      import { useEffect } from "react";
      import { useValue } from "@legendapp/state/react";
      export function Title({ title$ }: { title$: unknown }) {
        const title = useValue(title$);
        useEffect(() => { document.title = title; }, [title]);
        return null;
      }
    `),
    ["use-observe-effect"]
  );
});

test("allows stable useObservable handles beside changing useValue dependencies", () => {
  assert.deepEqual(
    actions(`
      import { useEffect } from "react";
      import { useObservable, useValue } from "@legendapp/state/react";
      export function Dialog({ open$ }: { open$: unknown }) {
        const open = useValue(open$);
        const draft$ = useObservable("");
        useEffect(() => { if (open) draft$.set(""); }, [open, draft$]);
        return null;
      }
    `),
    ["use-observe-effect"]
  );
});

test("does not infer an observable reaction when the effect never reads the useValue dependency", () => {
  assert.deepEqual(
    actions(`
      import { useEffect } from "react";
      import { useValue } from "@legendapp/state/react";
      export function Dialog({ open$ }: { open$: unknown }) {
        const open = useValue(open$);
        useEffect(() => { refresh(); }, [open]);
        return null;
      }
    `),
    ["review-effect"]
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
    ["review-state"]
  );
});
