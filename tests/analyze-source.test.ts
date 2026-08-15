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

test("keeps call-site-owned state above a conditionally mounted controlled leaf", () => {
  for (const alternateReturn of [false, true]) {
    const [finding] = analyzeSource(`
      import { useState } from "react";
      function Menu(_props: unknown) { return null; }
      function Alternative() { return null; }
      export function Toolbar({ compact, enabled }: { compact: boolean; enabled: boolean }) {
        const [open, setOpen] = useState(false);
        ${alternateReturn ? "if (compact) return <Alternative />;" : ""}
        return <main>
          <Header /><Summary /><Search /><Filters /><Actions /><Help />
          {enabled && <Menu open={open} onOpenChange={setOpen} />}
          <Status /><Footer /><Aside /><Preview /><Details /><Metrics />
        </main>;
      }
    `, "fixture.tsx");
    assert.equal(finding?.action, "use-observable");
    assert.match(finding?.message ?? "", /keep ownership at this owner/i);
  }
});

test("does not isolate call-site-owned state when it controls the child mount", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    function Menu(_props: unknown) { return null; }
    export function Toolbar() {
      const [open, setOpen] = useState(false);
      return <main>
        <Header /><Summary /><Search /><Filters /><Actions /><Help />
        {open && <Menu open={open} onOpenChange={setOpen} />}
        <Status /><Footer /><Aside /><Preview /><Details /><Metrics />
      </main>;
    }
  `, "fixture.tsx");
  assert.notEqual(finding?.action, "use-observable");
});

test("does not isolate call-site-owned state in repeated controlled leaves", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    function Menu(_props: unknown) { return null; }
    export function Toolbar({ rows }: { rows: Array<{ id: string }> }) {
      const [open, setOpen] = useState(false);
      return <main>
        <Header /><Summary /><Search /><Filters /><Actions /><Help />
        {rows.map(row => <Menu key={row.id} open={open} onOpenChange={setOpen} />)}
        <Status /><Footer /><Aside /><Preview /><Details /><Metrics />
      </main>;
    }
  `, "fixture.tsx");
  assert.doesNotMatch(finding?.message ?? "", /branch-local `Menu` call site/);
});

test("does not treat an arbitrary setter prop as call-site-owned state", () => {
  for (const callback of ["register", "setCache"]) {
    for (const conditional of [false, true]) {
      const [finding] = analyzeSource(`
        import { useState } from "react";
        function Registry(_props: unknown) { return null; }
        function Alternative() { return null; }
        export function Screen({ compact }: { compact: boolean }) {
          const [value, setValue] = useState(false);
          ${conditional ? "if (compact) return <Alternative />;" : ""}
          return <main>
            <Header /><Summary /><Search /><Filters /><Actions /><Help />
            <Registry value={value} ${callback}={setValue} />
            <Status /><Footer /><Aside /><Preview /><Details /><Metrics />
          </main>;
        }
      `, "fixture.tsx");
      assert.notEqual(
        finding?.action,
        conditional ? "use-observable" : "move-state-down",
        `${callback}/${conditional}`
      );
    }
  }
});

test("recognizes explicit setter props as value-transition APIs", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    function Editor(_props: unknown) { return null; }
    function Alternative() { return null; }
    export function Form({ compact }: { compact: boolean }) {
      const [firstRender, setFirstRender] = useState(true);
      if (compact) return <Alternative />;
      return <main>
        <Header /><Summary /><Search /><Filters /><Actions /><Help />
        <Editor firstRender={firstRender} setFirstRender={setFirstRender} />
        <Status /><Footer /><Aside /><Preview /><Details /><Metrics />
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
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

test("uses an unresolved JSX component sibling as a controlled render-cut witness", () => {
  const [finding] = analyzeSource(`
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
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
});

test("does not treat a Fragment as an independent component boundary", () => {
  const [finding] = analyzeSource(`
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
  `, "fixture.tsx");
  assert.equal(finding?.action, "review-state");
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

test("tracks state reads and writes through React lifecycle callback bindings", () => {
  const siblings = "<Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Preview />";
  const findings = analyzeSource(`
    import React, {
      useCallback,
      useEffect,
      useInsertionEffect as useInsert,
      useLayoutEffect,
      useState,
    } from "react";
    function Leaf() { return null; }

    export function InlineLayout({ source }: { source: boolean }) {
      const [visible, setVisible] = useState(false);
      useLayoutEffect(() => { setVisible(source); report(visible); }, [source]);
      return <main>${siblings}{visible && <Leaf />}</main>;
    }

    export function MemoizedLayout({ source }: { source: boolean }) {
      const [visible, setVisible] = useState(false);
      const synchronize = useCallback(() => setVisible(source), [source]);
      React.useLayoutEffect(synchronize, [synchronize]);
      return <main>${siblings}{visible && <Leaf />}</main>;
    }

    export function AliasedInsertion() {
      const [visible, setVisible] = useState(false);
      function read() { report(visible); }
      const synchronize = read;
      useInsert(synchronize, [synchronize]);
      return <main>${siblings}<button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}</main>;
    }

    export function NamedEffect({ source }: { source: boolean }) {
      const [visible, setVisible] = useState(false);
      const synchronize = () => setVisible(source);
      useEffect(synchronize, [synchronize]);
      return <main>${siblings}{visible && <Leaf />}</main>;
    }
  `, "fixture.tsx");
  const stateFor = (owner: string) => findings.find(finding =>
    finding.hook === "useState" && finding.evidence[0]?.startsWith(`owner: ${owner},`)
  );

  assert.equal(stateFor("InlineLayout")?.action, "review-state");
  assert.match(stateFor("InlineLayout")?.evidence[1] ?? "", /effects 1/);
  assert.match(stateFor("InlineLayout")?.evidence[2] ?? "", /effect writes 1/);
  assert.equal(stateFor("MemoizedLayout")?.action, "review-state");
  assert.match(stateFor("MemoizedLayout")?.evidence[2] ?? "", /effect writes 1/);
  assert.equal(stateFor("AliasedInsertion")?.action, "review-state");
  assert.match(stateFor("AliasedInsertion")?.evidence[1] ?? "", /effects 1/);
  assert.equal(stateFor("NamedEffect")?.action, "review-state");
  assert.match(stateFor("NamedEffect")?.evidence[2] ?? "", /effect writes 1/);
  assert.equal(
    findings.filter(finding => finding.hook === "useEffect").length,
    1
  );
});

test("does not isolate state whose update is scheduled by a React transition", () => {
  const findings = analyzeSource(`
    import { startTransition as schedule, useState, useTransition } from "react";
    function Leaf(_props: unknown) { return null; }
    function Shell(_props: unknown) { return null; }
    export function PlainUpdate() {
      const [visible, setVisible] = useState(false);
      return <main><Shell /><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <button onClick={() => setVisible(true)}>Open</button>
        {visible && <Leaf />}
      </main>;
    }
    export function StaticTransition() {
      const [visible, setVisible] = useState(false);
      return <main><Shell /><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <button onClick={() => schedule(() => setVisible(true))}>Open</button>
        {visible && <Leaf />}
      </main>;
    }
    export function HookTransition() {
      const [visible, setVisible] = useState(false);
      const [, begin] = useTransition();
      return <main><Shell /><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <button onClick={() => begin(() => setVisible(true))}>Open</button>
        {visible && <Leaf />}
      </main>;
    }
    export function NamedTransition() {
      const [visible, setVisible] = useState(false);
      function update() { setVisible(true); }
      return <main><Shell /><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <button onClick={() => schedule(update)}>Open</button>
        {visible && <Leaf />}
      </main>;
    }
    export function AliasedTransition() {
      const [visible, setVisible] = useState(false);
      const begin = schedule;
      const update = () => setVisible(true);
      return <main><Shell /><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <button onClick={() => begin(() => update())}>Open</button>
        {visible && <Leaf />}
      </main>;
    }
    export function ChainedStaticTransition() {
      const [visible, setVisible] = useState(false);
      const first = schedule;
      const begin = first;
      return <main><Shell /><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <button onClick={() => begin(() => setVisible(true))}>Open</button>
        {visible && <Leaf />}
      </main>;
    }
    export function AliasedHookTransition() {
      const [visible, setVisible] = useState(false);
      const [, transition] = useTransition();
      const begin = transition;
      return <main><Shell /><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <button onClick={() => begin(() => setVisible(true))}>Open</button>
        {visible && <Leaf />}
      </main>;
    }
    export function NestedHelperTransition() {
      const [visible, setVisible] = useState(false);
      const update = () => setVisible(true);
      const middle = () => update();
      return <main><Shell /><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <button onClick={() => schedule(() => middle())}>Open</button>
        {visible && <Leaf />}
      </main>;
    }
    export function AssertedTransition() {
      const [visible, setVisible] = useState(false);
      function update() { setVisible(true); }
      return <main><Shell /><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <button onClick={() => schedule(update as () => void)}>Open</button>
        {visible && <Leaf />}
      </main>;
    }
  `, "fixture.tsx");
  const visible = findings.filter(finding => finding.name === "visible");
  assert.deepEqual(
    visible.map(finding => finding.action),
    [
      "use-observable",
      "review-state",
      "review-state",
      "review-state",
      "review-state",
      "review-state",
      "review-state",
      "review-state",
      "review-state",
    ]
  );
});

test("preserves mutable React state when its owner has an every-commit effect", () => {
  for (const [hookImport, hookCall] of [
    ["useEffect", "useEffect"],
    ["useLayoutEffect as useLayout", "useLayout"],
    ["useInsertionEffect", "useInsertionEffect"],
  ]) {
    const findings = analyzeSource(`
      import { ${hookImport}, useState } from "react";
      function Leaf(_props: unknown) { return null; }
      export function Screen() {
        const [visible, setVisible] = useState(false);
        ${hookCall}(() => synchronizeLayout());
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Preview />
          <button onClick={() => setVisible(true)}>Open</button>
          {visible && <Leaf />}
        </main>;
      }
    `, "fixture.tsx");
    assert.equal(findings.find(finding => finding.name === "visible")?.action, "review-state");
  }

  const explicitUndefined = analyzeSource(`
    import { useEffect, useState } from "react";
    function Leaf() { return null; }
    export function Screen() {
      const [visible, setVisible] = useState(false);
      function nested(undefined: unknown) { return undefined; }
      useEffect(() => synchronizeLayout(), undefined);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Preview />
        <button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(
    explicitUndefined.find(finding => finding.name === "visible")?.action,
    "review-state"
  );

  const explicitNull = analyzeSource(`
    import { useEffect, useState } from "react";
    function Leaf() { return null; }
    export function Screen() {
      const [visible, setVisible] = useState(false);
      useEffect(() => synchronizeLayout(), null);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Preview />
        <button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(
    explicitNull.find(finding => finding.name === "visible")?.action,
    "review-state"
  );
});

test("preserves mutable React state when its owner uses an inline callback ref", () => {
  const findings = analyzeSource(`
    import { useState } from "react";
    function Leaf() { return null; }
    export function Screen() {
      const [visible, setVisible] = useState(false);
      return <main ref={node => synchronizeLayout(node)}>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Preview />
        <button onClick={() => setVisible(true)}>Open</button>
        {visible && <Leaf />}
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(findings.find(finding => finding.name === "visible")?.action, "review-state");
});

test("uses an owner-level boundary for fresh refs while allowing stable memoized refs", () => {
  const siblings = "<Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Preview />";
  const findings = analyzeSource(`
    import { useCallback, useState } from "react";
    function Leaf() { return null; }
    export function NamedRef() {
      const [visible, setVisible] = useState(false);
      const setNode = (node: unknown) => synchronizeLayout(node);
      return <main ref={setNode}>${siblings}<button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}</main>;
    }
    export function RepeatedRef({ rows }: { rows: Array<{ id: string }> }) {
      const [visible, setVisible] = useState(false);
      return <main>${siblings}<button onClick={() => setVisible(true)}>Open</button>
        {rows.map(row => <div key={row.id} ref={node => synchronizeRow(row.id, node)} />)}
        {visible && <Leaf />}
      </main>;
    }
    export function MemoizedRef() {
      const [visible, setVisible] = useState(false);
      const setNode = useCallback((node: unknown) => synchronizeLayout(node), []);
      return <main ref={setNode}>${siblings}<button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}</main>;
    }
    export function ConditionalRef({ alternate }: { alternate: boolean }) {
      const [visible, setVisible] = useState(false);
      return <main ref={alternate ? node => synchronizeLayout(node) : node => synchronizeFallback(node)}>
        ${siblings}<button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}
      </main>;
    }
    export function NestedComponentRef() {
      const [visible, setVisible] = useState(false);
      function Nested() { return <div ref={node => synchronizeLayout(node)} />; }
      return <main>${siblings}<button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}</main>;
    }
    export function OpaqueMergedRef({ externalRef }: { externalRef: unknown }) {
      const [visible, setVisible] = useState(false);
      const merged = mergeRefs(externalRef);
      return <main ref={merged}>${siblings}<button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}</main>;
    }
    export function ArrayFromRef({ rows }: { rows: string[] }) {
      const [visible, setVisible] = useState(false);
      return <main>${siblings}{Array.from(rows, row => <div key={row} ref={node => synchronizeRow(row, node)} />)}
        <button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}</main>;
    }
    export function NamedRenderRef({ rows }: { rows: string[] }) {
      const [visible, setVisible] = useState(false);
      function renderRow(row: string) { return <div key={row} ref={node => synchronizeRow(row, node)} />; }
      return <main>${siblings}{rows.map(renderRow)}
        <button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}</main>;
    }
    export function DirectRenderHelperRef() {
      const [visible, setVisible] = useState(false);
      const renderRef = () => <div ref={node => synchronizeLayout(node)} />;
      return <main>${siblings}{renderRef()}<button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}</main>;
    }
    export function LocalComponentRef() {
      const [visible, setVisible] = useState(false);
      function RefChild() { return <div ref={node => synchronizeLayout(node)} />; }
      return <main>${siblings}<RefChild /><button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}</main>;
    }
    export function UnmemoizedCallbackRef() {
      const [visible, setVisible] = useState(false);
      const setNode = useCallback((node: unknown) => synchronizeLayout(node));
      return <main ref={setNode}>${siblings}<button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}</main>;
    }
    export function ConditionalBindingRef({ alternate }: { alternate: boolean }) {
      const [visible, setVisible] = useState(false);
      const setNode = alternate
        ? (node: unknown) => synchronizeLayout(node)
        : (node: unknown) => synchronizeFallback(node);
      return <main ref={setNode}>${siblings}<button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}</main>;
    }
  `, "fixture.tsx");
  const visible = findings.filter(finding => finding.name === "visible");
  assert.deepEqual(
    visible.map(finding => finding.action),
    [
      "review-state",
      "review-state",
      "use-observable",
      "review-state",
      "review-state",
      "review-state",
      "review-state",
      "review-state",
      "review-state",
      "review-state",
      "review-state",
      "review-state",
    ]
  );
});

test("does not call a nonliteral dependency array an every-commit effect", () => {
  const findings = analyzeSource(`
    import { useEffect, useState } from "react";
    function Leaf() { return null; }
    export function Screen({ dependency }: { dependency: string }) {
      const [visible, setVisible] = useState(false);
      const dependencies = [dependency];
      useEffect(() => synchronizeLayout(), dependencies);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Preview />
        <button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(findings.find(finding => finding.name === "visible")?.action, "use-observable");
});

test("does not trust shadowed React effect bindings", () => {
  const findings = analyzeSource(`
    import { useEffect, useState } from "react";
    function Leaf() { return null; }
    export function Screen({ useEffect }: { useEffect: (callback: () => void) => void }) {
      const [visible, setVisible] = useState(false);
      useEffect(() => synchronizeLayout());
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Preview />
        <button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(findings.find(finding => finding.name === "visible")?.action, "use-observable");
  assert.equal(findings.filter(finding => finding.hook === "useEffect").length, 0);

  const unrelatedNestedShadow = analyzeSource(`
    import { useEffect, useState } from "react";
    function Leaf() { return null; }
    export function Screen() {
      const [visible, setVisible] = useState(false);
      function nested(useEffect: (callback: () => void) => void) { useEffect(() => work()); }
      useEffect(() => synchronizeLayout());
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Preview />
        <button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(
    unrelatedNestedShadow.find(finding => finding.name === "visible")?.action,
    "review-state"
  );
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

test("preserves lazy draft initialization as a once-only snapshot", () => {
  const findings = analyzeSource(`
    import { useEffect, useState } from "react";
    export function Permissions({ saved }: { saved: string[] }) {
      const [draft, setDraft] = useState(() => new Set(saved));
      useEffect(() => { setDraft(new Set(saved)); }, [saved]);
      return <main>
        <Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation /><Content />
        <PermissionsEditor value={draft} onChange={setDraft} />
      </main>;
    }
  `, "fixture.tsx");
  const state = findings.find(finding => finding.hook === "useState");
  assert.equal(state?.action, "use-observable");
  assert.match(state?.message ?? "", /once-only owner snapshot/);
  assert.match(state?.message ?? "", /not pass it to Legend as a computed/);
});

test("keeps a synchronized local draft beside its value-forwarding upstream command", () => {
  const findings = analyzeSource(`
    import { useCallback, useEffect, useMemo, useState } from "react";
    export function Profile({ initialName, onChange }: { initialName: string; onChange: (value: string) => void }) {
      const [name, setName] = useState(initialName);
      useEffect(() => { setName(initialName); }, [initialName]);
      const debouncedChange = useMemo(() => debounce(onChange, 100), [onChange]);
      const edit = useCallback((next: string) => {
        const updated = name === next ? name : next.trimStart();
        setName(updated);
        debouncedChange(updated);
      }, [name, debouncedChange]);
      return <main>
        <Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation /><Content />
        <input value={name} onChange={event => edit(event.target.value)} />
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(findings.find(finding => finding.name === "name")?.action, "use-observable");
  assert.equal(findings.find(finding => finding.hook === "useEffect")?.action, "review-effect");
});

test("does not call unrelated or stateful work a synchronized draft forwarding command", () => {
  for (const edit of [
    `const edit = (next: string) => { const updated = next.trim(); setName(updated); notify(); };`,
    `const edit = (next: string) => { const updated = next.trim(); notify(updated); setName(updated); };`,
    `const edit = (next: string) => { const updated = next.trim(); setName(updated); notify(initialName); };`,
    `const markDirty = (next: string) => setDirty(next !== "");
     const edit = (next: string) => { const updated = next.trim(); setName(updated); markDirty(updated); };`,
  ]) {
    const findings = analyzeSource(`
      import { useEffect, useState } from "react";
      export function Profile({ initialName }: { initialName: string }) {
        const [name, setName] = useState(initialName);
        const [dirty, setDirty] = useState(false);
        useEffect(() => { setName(initialName); }, [initialName]);
        ${edit}
        return <main>
          <Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation /><Content />
          <input value={name} onChange={event => edit(event.target.value)} /><p>{dirty}</p>
        </main>;
      }
    `, "fixture.tsx");
    assert.notEqual(
      findings.find(finding => finding.name === "name")?.action,
      "use-observable",
      edit
    );
  }
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

test("keeps callable React state out of projection and sibling leaf rules", () => {
  for (const state of [
    {
      declaration: "const [value, setValue] = useState<(() => void) | null>(null);",
      write: "setValue(() => work)",
    },
    {
      declaration: "type Handler = () => void; const [value, setValue] = useState<Handler | null>(null);",
      write: "setValue(() => work)",
    },
    {
      declaration: "const [value, setValue] = useState(() => work);",
      write: "setValue(() => next)",
    },
    {
      declaration: "interface DialogState { id: string; onConfirm(): void } const [value, setValue] = useState<DialogState | null>(null);",
      write: "setValue({ id: 'x', onConfirm: work })",
    },
    {
      declaration: "const [value, setValue] = useState(null);",
      write: "setValue({ onConfirm: () => work() })",
    },
  ]) {
    const [finding] = analyzeSource(`
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
    `, "fixture.tsx");
    assert.notEqual(finding?.action, "use-observable", state.declaration);
    assert.notEqual(finding?.action, "move-state-down", state.declaration);
  }
});

test("does not mistake ordinary local state aliases for callable state", () => {
  for (const alias of ["Selection", "FC", "ComponentType"]) {
    const [finding] = analyzeSource(`
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
    `, "fixture.tsx");
    assert.equal(finding?.action, "use-observable", alias);
  }
});

test("resolves callable aliases in the nearest lexical scope", () => {
  const findings = analyzeSource(`
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
  `, "fixture.tsx");
  const finding = findings.find(candidate => candidate.name === "value" && candidate.location.line > 8);
  assert.notEqual(finding?.action, "use-observable");
  assert.notEqual(finding?.action, "move-state-down");
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

test("isolates one unresolved JSX leaf without requiring its prop contract", () => {
  const findings = analyzeSource(`
    import { useState } from "react";
    import { RemoteDialog, RemoteStatus } from "third-party-ui";
    export function StatusScreen() {
      const [busy, setBusy] = useState(false);
      const save = async () => { setBusy(true); await persist(); setBusy(false); };
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Preview /><Actions />
        <button onClick={save}>Save</button><RemoteStatus loading={busy} /></main>;
    }
    export function DialogScreen() {
      const [target, setTarget] = useState<string | null>(null);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Preview /><Actions />
        <button onClick={() => setTarget("item")}>Open</button>
        <RemoteDialog target={target} onClose={() => setTarget(null)} />
      </main>;
    }
  `, "fixture.tsx");
  assert.deepEqual(
    findings.filter(finding => ["busy", "target"].includes(finding.name ?? "")).map(finding => finding.action),
    ["use-observable", "use-observable"]
  );
});

test("does not mistake unresolved boundaries for proof of leaf ownership", () => {
  const findings = analyzeSource(`
    import { useEffect, useState } from "react";
    import { RemoteLeaf, RemoteMenu } from "third-party-ui";
    export function CohesiveMenu() {
      const [open, setOpen] = useState(false);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Preview /><Actions />
        <RemoteMenu open={open} onOpenChange={setOpen}>
          <button onClick={() => setOpen(false)}>Close</button><One /><Two /><Three /><Four />
        </RemoteMenu>
      </main>;
    }
    export function TwoConsumers() {
      const [visible, setVisible] = useState(false);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Preview /><Actions />
        <button onClick={() => setVisible(true)}>Open</button>
        <RemoteLeaf visible={visible} /><RemoteLeaf visible={visible} />
      </main>;
    }
    export function EffectConsumer() {
      const [visible, setVisible] = useState(false);
      useEffect(() => report(visible), [visible]);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Preview /><Actions />
        <button onClick={() => setVisible(true)}>Open</button><RemoteLeaf visible={visible} />
      </main>;
    }
    export function AtomicCompanion() {
      const [dirty, setDirty] = useState(false);
      const [visible, setVisible] = useState(false);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Preview /><Actions />
        <button onClick={() => { setVisible(true); setDirty(true); }}>Open</button>
        <RemoteLeaf visible={visible} onClose={() => { setVisible(false); setDirty(false); }} />
        <output>{String(dirty)}</output>
      </main>;
    }
  `, "fixture.tsx");
  for (const name of ["open", "visible"]) {
    const matching = findings.filter(finding => finding.name === name);
    assert.ok(matching.length > 0);
    assert.ok(matching.every(finding => finding.action !== "use-observable"));
  }
});

test("reviews a literal boolean leaf commanded by memoized event options", () => {
  const [finding] = analyzeSource(`
    import { useMemo, useState } from "react";
    function DecisionModal(props: { isVisible: boolean; onClose: () => void }) { return null; }
    export function Screen() {
      const [failureVisible, setFailureVisible] = useState(false);
      const actions = useMemo(() => [{
        label: "Download",
        onSelected: () => downloadReport(() => setFailureVisible(true)),
      }], []);
      return <main><Header /><Toolbar actions={actions} /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <DecisionModal isVisible={failureVisible} onClose={() => setFailureVisible(false)} />
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "review-state");
});

test("does not treat lifecycle options passed to an unknown hook as JSX events", () => {
  const [finding] = analyzeSource(`
    import { useMemo, useState } from "react";
    function DecisionModal(props: { isVisible: boolean; onClose: () => void }) { return null; }
    export function Screen() {
      const [visible, setVisible] = useState(false);
      const lifecycle = useMemo(() => ({
        onOpen: () => setVisible(true),
        onCleanup: () => setVisible(false),
      }), []);
      useLibraryLifecycle(lifecycle);
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <DecisionModal isVisible={visible} onClose={() => setVisible(false)} />
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "review-state");
});

test("does not treat event options wrapped by a JSX-time registrar as direct events", () => {
  const [finding] = analyzeSource(`
    import { useMemo, useState } from "react";
    function DecisionModal(props: { isVisible: boolean; onClose: () => void }) { return null; }
    export function Screen() {
      const [visible, setVisible] = useState(false);
      const actions = useMemo(() => [{ onSelected: () => setVisible(true) }], []);
      return <main><Header /><Toolbar actions={register(actions)} /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <DecisionModal isVisible={visible} onClose={() => setVisible(false)} />
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "review-state");
});

test("requires literal leaf setters to be event-rooted and independently useful", () => {
  const findings = analyzeSource(`
    import { useMemo, useState } from "react";
    function DecisionModal(props: { isVisible: boolean; onClose: () => void }) { return null; }
    export function RenderWrite() {
      const [visible, setVisible] = useState(false);
      useMemo(() => { setVisible(true); return []; }, []);
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <DecisionModal isVisible={visible} onClose={() => setVisible(false)} />
      </main>;
    }
    export function OpaqueCallback() {
      const [visible, setVisible] = useState(false);
      const actions = useMemo(() => [{ compute: () => invokeNow(() => setVisible(true)) }], []);
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <DecisionModal isVisible={visible} onClose={() => setVisible(false)} />
      </main>;
    }
    export function CompanionWrite() {
      const [dirty, setDirty] = useState(false);
      const [visible, setVisible] = useState(false);
      const actions = useMemo(() => [{ onSelected: () => { setVisible(true); setDirty(true); } }], []);
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <DecisionModal isVisible={visible} onClose={() => setVisible(false)} /><output>{String(dirty)}</output>
      </main>;
    }
    export function MutationOwned() {
      const mutation = useSaveMutation();
      const [visible, setVisible] = useState(false);
      const actions = useMemo(() => [{
        onSelected: async () => {
          setVisible(true);
          await mutation.mutateAsync();
          setVisible(false);
        },
      }], [mutation]);
      return <main><Header /><Toolbar actions={actions} /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <DecisionModal isVisible={visible} onClose={() => setVisible(false)} />
      </main>;
    }
  `, "fixture.tsx");
  const candidates = findings.filter(candidate => candidate.name === "visible");
  assert.equal(candidates.length, 4);
  for (const finding of candidates) {
    assert.equal(finding.action, "review-state");
  }
});

test("isolates an async pending flag at one stable leaf without changing its completion boundary", () => {
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
  assert.match(finding?.message ?? "", /async completion boundary/);
});

test("keeps async status label projections inside the same subscribed leaf", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function Form() {
      const [saving, setSaving] = useState(false);
      async function save() {
        setSaving(true);
        try { await persist(); } finally { setSaving(false); }
      }
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <Button disabled={saving} onClick={save}>
          {saving ? translate("Saving") : translate("Save")}
        </Button>
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /stable `Button` call site/);
});

test("does not fold unsafe or external async status projections into a leaf", () => {
  const findings = analyzeSource(`
    import { useState } from "react";
    export function UnsafeCondition() {
      const [saving, setSaving] = useState(false);
      async function save() { setSaving(true); await persist(); setSaving(false); }
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <Button loading={saving} onClick={save}>{track(saving) ? "Saving" : "Save"}</Button>
      </main>;
    }
    export function SiblingRead() {
      const [saving, setSaving] = useState(false);
      async function save() { setSaving(true); await persist(); setSaving(false); }
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <Button loading={saving} onClick={save} /><output>{saving ? "Saving" : "Save"}</output>
      </main>;
    }
    export function SelfGate() {
      const [saving, setSaving] = useState(false);
      async function save() { setSaving(true); await persist(); setSaving(false); }
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <button onClick={save}>Save</button>{saving && <Button loading={saving} />}
      </main>;
    }
  `, "fixture.tsx");
  for (const finding of findings.filter(candidate => candidate.name === "saving")) {
    assert.notEqual(finding.action, "use-observable");
  }
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

test("traces async pending state through a direct JSX event adapter", () => {
  const findings = analyzeSource(`
    import { useState } from "react";
    import { useForm } from "react-hook-form";
    function LoadingButton(props: { loading: boolean }) { return <button>{String(props.loading)}</button>; }
    export function DirectAdapter() {
      const [saving, setSaving] = useState(false);
      const { handleSubmit } = useForm();
      const save = async () => {
        setSaving(true);
        try { await persist(); } finally { setSaving(false); }
      };
      return <form onSubmit={handleSubmit(save)}><Header /><Fields /><LoadingButton loading={saving} /></form>;
    }
    export function InlineAdapter() {
      const [saving, setSaving] = useState(false);
      const form = useForm();
      const save = async () => {
        setSaving(true);
        try { await persist(); } finally { setSaving(false); }
      };
      return <form onSubmit={event => { event.preventDefault(); form.handleSubmit(save)(); }}>
        <Header /><Fields /><LoadingButton loading={saving} />
      </form>;
    }
    export function DestructuredAlias() {
      const [saving, setSaving] = useState(false);
      const form = useForm();
      const { handleSubmit } = form;
      const save = async () => {
        setSaving(true);
        try { await persist(); } finally { setSaving(false); }
      };
      return <form onSubmit={handleSubmit(save)}><Header /><Fields /><LoadingButton loading={saving} /></form>;
    }
  `, "fixture.tsx").filter(finding => finding.name === "saving");
  assert.deepEqual(
    findings.map(finding => finding.action),
    ["use-observable", "use-observable", "use-observable"]
  );
});

test("traces an async pending helper through a proven React Hook Form event adapter", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    import { useForm } from "react-hook-form";
    function LoadingButton(props: { loading: boolean }) { return <button>{String(props.loading)}</button>; }
    export function Form() {
      const [testing, setTesting] = useState(false);
      const { handleSubmit } = useForm();
      const testEndpoint = async () => {
        setTesting(true);
        try { await ping(); } finally { setTesting(false); }
      };
      const submit = async () => {
        await testEndpoint();
        await save();
      };
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <form onSubmit={handleSubmit(submit)}>
          <button type="button" onClick={testEndpoint}>Test</button>
          <LoadingButton loading={testing} />
        </form>
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /async completion boundary/);
});

test("does not treat deferred or non-event callback adapters as event roots", () => {
  const findings = analyzeSource(`
    import { useState } from "react";
    import { useForm } from "react-hook-form";
    function LoadingButton(props: { loading: boolean }) { return <button>{String(props.loading)}</button>; }
    export function Deferred() {
      const [saving, setSaving] = useState(false);
      const { handleSubmit } = useForm();
      const save = async () => { setSaving(true); await persist(); setSaving(false); };
      return <form onSubmit={() => setTimeout(() => handleSubmit(save)(), 0)}>
        <Header /><Fields /><LoadingButton loading={saving} />
      </form>;
    }
    export function NonEvent() {
      const [saving, setSaving] = useState(false);
      const { handleSubmit } = useForm();
      const save = async () => { setSaving(true); await persist(); setSaving(false); };
      return <Form submit={handleSubmit(save)}><Header /><Fields /><LoadingButton loading={saving} /></Form>;
    }
    export function UnknownAdapter({ invokeNow }: { invokeNow: (submit: () => Promise<void>) => () => void }) {
      const [saving, setSaving] = useState(false);
      const save = async () => { setSaving(true); await persist(); setSaving(false); };
      return <form onSubmit={invokeNow(save)}><Header /><Fields /><LoadingButton loading={saving} /></form>;
    }
    export function WrongReactHookFormMethod() {
      const [saving, setSaving] = useState(false);
      const { reset } = useForm();
      const save = async () => { setSaving(true); await persist(); setSaving(false); };
      return <form onSubmit={reset(save)}><Header /><Fields /><LoadingButton loading={saving} /></form>;
    }
    export function ShadowedFactory({ useForm }: { useForm: () => { handleSubmit: Function } }) {
      const [saving, setSaving] = useState(false);
      const { handleSubmit } = useForm();
      const save = async () => { setSaving(true); await persist(); setSaving(false); };
      return <form onSubmit={handleSubmit(save)}><Header /><Fields /><LoadingButton loading={saving} /></form>;
    }
  `, "fixture.tsx").filter(finding => finding.name === "saving");
  for (const finding of findings) {
    assert.doesNotMatch(finding.message, /async pending flag/);
  }
});

test("isolates a Promise-chain status rendered through one reachable JSX callback leaf", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    function LoadingButton(props: { loading: boolean }) { return <button>{String(props.loading)}</button>; }
    export function Importer() {
      const [reading, setReading] = useState(false);
      function read() {
        setReading(true);
        loadFile().then(parseFile).catch(reportError).finally(() => setReading(false));
      }
      const picker = <FilePicker>{() => <LoadingButton loading={reading} />}</FilePicker>;
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <button onClick={read}>Read</button>{picker}
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /async completion boundary/);
});

test("requires a Promise-chain leaf alias to be live, unique, and non-repeated", () => {
  for (const render of [
    `const picker = <LoadingButton loading={reading} />; return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />{picker}{picker}</main>;`,
    `const picker = <LoadingButton loading={reading} />; return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions /></main>;`,
    `return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />{rows.map(row => <LoadingButton key={row.id} loading={reading} />)}</main>;`,
  ]) {
    const [finding] = analyzeSource(`
      import { useState } from "react";
      export function Importer({ rows }: { rows: Array<{ id: string }> }) {
        const [reading, setReading] = useState(false);
        function read() {
          setReading(true);
          loadFile().finally(() => setReading(false));
        }
        ${render}
      }
    `, "fixture.tsx");
    assert.doesNotMatch(finding?.message ?? "", /async pending flag/);
  }
});

test("does not flatten timers or unrelated Promise continuations into one async command", () => {
  const findings = analyzeSource(`
    import { useState } from "react";
    function LoadingButton(props: { loading: boolean }) { return <button>{String(props.loading)}</button>; }
    export function Timer() {
      const [reading, setReading] = useState(false);
      const read = () => {
        setReading(true);
        setTimeout(() => loadFile().finally(() => setReading(false)), 10);
      };
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <button onClick={read}>Read</button><LoadingButton loading={reading} />
      </main>;
    }
    export function SplitCommands() {
      const [reading, setReading] = useState(false);
      const read = () => setReading(true);
      const finish = () => loadFile().finally(() => setReading(false));
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <button onClick={read}>Read</button><button onClick={finish}>Finish</button><LoadingButton loading={reading} />
      </main>;
    }
  `, "fixture.tsx");
  for (const finding of findings.filter(candidate => candidate.name === "reading")) {
    assert.doesNotMatch(finding.message, /async pending flag/);
  }
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
  assert.match(finding?.message ?? "", /async completion boundary/);
});

test("isolates async status after bounded synchronous command preparation", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    function LoadingButton(props: { loading: boolean }) { return <button>{String(props.loading)}</button>; }
    export function Form() {
      const [saving, setSaving] = useState(false);
      async function save() {
        setSaving(true);
        const payload = buildPayload();
        auditPayload(payload);
        try { await persist(payload); } finally { setSaving(false); }
      }
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <form onSubmit={save}><LoadingButton loading={saving} /></form>
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /async completion boundary/);
});

test("allows an event-rooted reset-only helper beside one async activation", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    function LoadingButton(props: { loading: boolean }) { return <button>{String(props.loading)}</button>; }
    export function Form() {
      const [saving, setSaving] = useState(false);
      const reset = () => setSaving(false);
      async function save() {
        setSaving(true);
        try { await persist(); } finally { reset(); }
      }
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <button onClick={reset}>Reset</button><form onSubmit={save}><LoadingButton loading={saving} /></form>
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
});

test("recognizes an async command selected by a JSX event conditional", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    function LoadingButton(props: { loading: boolean }) { return <button>{String(props.loading)}</button>; }
    export function Form({ alreadySaved }: { alreadySaved: boolean }) {
      const [saving, setSaving] = useState(false);
      async function save() {
        setSaving(true);
        try { await persist(); } finally { setSaving(false); }
      }
      const openSaved = () => navigate("saved");
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <form onSubmit={alreadySaved ? openSaved : save}><LoadingButton loading={saving} /></form>
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /async completion boundary/);
});

test("does not treat a callback used as an event condition as the selected handler", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    function LoadingButton(props: { loading: boolean }) { return <button>{String(props.loading)}</button>; }
    export function Form() {
      const [saving, setSaving] = useState(false);
      async function save() {
        setSaving(true);
        try { await persist(); } finally { setSaving(false); }
      }
      const noop = () => {};
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <form onSubmit={save ? noop : undefined}><LoadingButton loading={saving} /></form>
      </main>;
    }
  `, "fixture.tsx");
  assert.doesNotMatch(finding?.message ?? "", /async pending flag/);
});

test("does not hide a synchronous companion write inside a Promise-chain argument", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    function LoadingButton(props: { loading: boolean }) { return <button>{String(props.loading)}</button>; }
    export function Form({ rows }: { rows: string[] }) {
      const [dirty, setDirty] = useState(false);
      const [saving, setSaving] = useState(false);
      function save() {
        setSaving(true);
        persist(rows.map(row => {
          setDirty(true);
          return row;
        })).finally(() => setSaving(false));
      }
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <button onClick={save}>Save</button><LoadingButton loading={saving} /><output>{String(dirty)}</output>
      </main>;
    }
  `, "fixture.tsx");
  assert.doesNotMatch(finding?.message ?? "", /async pending flag/);
});

test("does not isolate a Promise-chain status before later synchronous owner work", () => {
  const finding = analyzeSource(`
    import { useState } from "react";
    function LoadingButton(props: { loading: boolean }) { return <button>{String(props.loading)}</button>; }
    export function Form({ enabled }: { enabled: boolean }) {
      const [email, setEmail] = useState("");
      const [saving, setSaving] = useState(false);
      function save(nextEmail: string) {
        if (enabled) {
          setSaving(true);
          persist().finally(() => setSaving(false));
        }
        setEmail(nextEmail);
      }
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <button onClick={() => save("next@example.com")}>Save</button>
        <LoadingButton loading={saving} /><output>{email}</output>
      </main>;
    }
  `, "fixture.tsx").find(candidate => candidate.name === "saving");
  assert.doesNotMatch(finding?.message ?? "", /async pending flag/);
});

test("does not isolate prepared async status when owner state can update before suspension", () => {
  const findings = analyzeSource(`
    import { useState } from "react";
    function LoadingButton(props: { loading: boolean }) { return <button>{String(props.loading)}</button>; }
    export function DirectCompanion() {
      const [dirty, setDirty] = useState(false);
      const [saving, setSaving] = useState(false);
      async function save() {
        setSaving(true);
        setDirty(true);
        await persist();
        setSaving(false);
      }
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <form onSubmit={save}><LoadingButton loading={saving} /></form><output>{String(dirty)}</output>
      </main>;
    }
    export function HiddenCompanion() {
      const [dirty, setDirty] = useState(false);
      const [saving, setSaving] = useState(false);
      const markDirty = () => setDirty(true);
      async function save() {
        setSaving(true);
        markDirty();
        await persist();
        setSaving(false);
      }
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <form onSubmit={save}><LoadingButton loading={saving} /></form><output>{String(dirty)}</output>
      </main>;
    }
  `, "fixture.tsx");
  for (const finding of findings.filter(candidate => candidate.name === "saving")) {
    assert.doesNotMatch(finding.message, /async pending flag/);
  }
});

test("does not cross an early exit or scheduled reset to prove async status", () => {
  const findings = analyzeSource(`
    import { useState } from "react";
    function LoadingButton(props: { loading: boolean }) { return <button>{String(props.loading)}</button>; }
    export function EarlyExit({ valid }: { valid: boolean }) {
      const [saving, setSaving] = useState(false);
      async function save() {
        setSaving(true);
        if (!valid) return;
        await persist();
        setSaving(false);
      }
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <form onSubmit={save}><LoadingButton loading={saving} /></form>
      </main>;
    }
    export function ScheduledReset() {
      const [saving, setSaving] = useState(false);
      async function save() {
        setSaving(true);
        await persist();
        setSaving(false);
      }
      setTimeout(() => setSaving(false), 100);
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <form onSubmit={save}><LoadingButton loading={saving} /></form>
      </main>;
    }
  `, "fixture.tsx");
  for (const finding of findings.filter(candidate => candidate.name === "saving")) {
    assert.doesNotMatch(finding.message, /async pending flag/);
  }
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
  assert.match(finding?.message ?? "", /async completion boundary/);
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
  const findings = analyzeSource(`
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
    export function ResettableForm() {
      const mutation = useSaveMutation();
      const [saving, setSaving] = useState(false);
      async function save() {
        setSaving(true);
        try { await mutation.mutateAsync(); } finally { setSaving(false); }
      }
      const reset = () => setSaving(false);
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <button onClick={reset}>Reset</button>
        <form onSubmit={save}><LoadingButton loading={saving} /></form>
      </main>;
    }
  `, "fixture.tsx");
  for (const finding of findings.filter(candidate => candidate.name === "saving")) {
    assert.notEqual(finding.action, "use-observable");
  }
});

test("keeps a proven independent UI transition beside a reactive mutation path", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function Form() {
      const mutation = useSaveMutation();
      const [open, setOpen] = useState(false);
      async function confirm() {
        await mutation.mutateAsync();
        setOpen(false);
      }
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <button onClick={() => setOpen(true)}>Open</button>
        <Dialog open={open} onOpenChange={setOpen} onConfirm={confirm} />
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
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

test("keeps exact async status in React when the owner is already the status leaf", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    export function SaveButton() {
      const [saving, setSaving] = useState(false);
      async function save() {
        setSaving(true);
        try { await persist(); } finally { setSaving(false); }
      }
      return <Button loading={saving} onClick={save}>Save</Button>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "keep-state");
  assert.match(finding?.message ?? "", /cohesive owner boundary/);
});

test("isolates async status in a compact owner with an independent render cut", () => {
  const [finding] = analyzeSource(`
    import { useState } from "react";
    function LoadingButton(props: { loading: boolean }) { return <button>{String(props.loading)}</button>; }
    export function CompactForm() {
      const [saving, setSaving] = useState(false);
      async function save() { setSaving(true); await persist(); setSaving(false); }
      return <form onSubmit={save}>
        <Header />
        <Fields />
        <LoadingButton loading={saving} />
      </form>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /independent owner content/);
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

test("does not treat a namespace hook callback as an event command", () => {
  const [finding] = analyzeSource(`
    import React, { useState } from "react";
    function Dialog(props: { open: boolean; onClose: () => void }) { return null; }
    export function Screen() {
      const [open, setOpen] = useState(false);
      React.useMemo(() => { (() => setOpen(true))(); return []; }, []);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <Dialog open={open} onClose={() => setOpen(false)} />
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

test("isolates a child-controlled close path from a coupled parent opener", () => {
  const findings = analyzeSource(`
    import { useState } from "react";
    interface Item { id: string }
    function Dialog(_props: unknown) { return null; }
    export function Screen({ item }: { item: Item }) {
      const [target, setTarget] = useState<Item | null>(null);
      const [open, setOpen] = useState(false);
      const show = () => { setTarget(item); setOpen(true); };
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
        <button onClick={show}>Open</button>
        <Dialog target={target} open={open} setOpen={setOpen} />
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(findings.find(finding => finding.name === "open")?.action, "use-observable");
  assert.equal(findings.find(finding => finding.name === "target")?.action, "review-state");
});

test("does not put a subscriber inside its own false visibility gate", () => {
  const findings = analyzeSource(`
    import { useState } from "react";
    interface Item { id: string }
    function Dialog(_props: unknown) { return null; }
    export function Screen({ item }: { item: Item }) {
      const [target, setTarget] = useState<Item | null>(null);
      const [open, setOpen] = useState(false);
      const show = () => { setTarget(item); setOpen(true); };
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
        <button onClick={show}>Open</button>
        {open && <Dialog target={target} open={open} setOpen={setOpen} />}
      </main>;
    }
  `, "fixture.tsx");
  const open = findings.find(finding => finding.name === "open");
  assert.equal(open?.action, "review-state");
});

test("does not treat arbitrary direct setter props as independent child commands", () => {
  const findings = analyzeSource(`
    import { useState } from "react";
    function Registry(_props: unknown) { return null; }
    export function Screen() {
      const [dirty, setDirty] = useState(false);
      const [open, setOpen] = useState(false);
      const show = () => { setDirty(true); setOpen(true); };
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
        <button onClick={show}>Open</button>
        <Registry value={open} register={setOpen} />
        <output>{String(dirty)}</output>
      </main>;
    }
  `, "fixture.tsx");
  assert.equal(findings.find(finding => finding.name === "open")?.action, "review-state");
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

test("keeps observable ownership above a receiving leaf with an outside setter command", () => {
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
    ["use-observable"]
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

test("isolates a lazy-initialized value inside one stable JSX child callback", () => {
  const [finding] = analyzeSource(`
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
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /created exactly once/);
  assert.match(finding?.message ?? "", /do not turn the initializer into a computed/);
  assert.match(finding?.message ?? "", /ImageField/);
});

test("keeps lazy callback transport without one stable independent leaf cut", () => {
  for (const body of [
    `<FormField>{field => <ImageField field={field} preview={preview} />}</FormField>`,
    `<main><VirtualList renderItem={() => <ImageField preview={preview} />} /><Details /></main>`,
    `<main>{rows.map(row => <FormField key={row.id}>{() => <ImageField preview={preview} />}</FormField>)}<Details /></main>`,
    `<main>{show && <FormField>{() => <ImageField preview={preview} />}</FormField>}<Details /></main>`,
  ]) {
    const [finding] = analyzeSource(`
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
    `, "fixture.tsx");
    assert.notEqual(finding?.action, "use-observable", body);
  }
});

test("does not put a lazy callable value into a nested observable leaf", () => {
  const [finding] = analyzeSource(`
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
  `, "fixture.tsx");
  assert.notEqual(finding?.action, "use-observable");
});

test("keeps a lazy callback leaf when its write command also invalidates the owner", () => {
  const findings = analyzeSource(`
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
  `, "fixture.tsx");
  const preview = findings.find(finding => finding.name === "preview");
  assert.notEqual(preview?.action, "use-observable");
});

test("does not promote broad transported state when every write also invalidates the owner", () => {
  const padding = "\n".repeat(150);
  const findings = analyzeSource(`
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
  `, "fixture.tsx");
  assert.equal(findings.find(finding => finding.name === "value")?.action, "review-state");
});

test("does not split a broad transported preview from a companion React transition", () => {
  const padding = "\n".repeat(150);
  const findings = analyzeSource(`
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
  `, "fixture.tsx");
  assert.equal(findings.find(finding => finding.name === "preview")?.action, "review-state");
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

test("keeps conditional child state at the owner and rejects multiple instances", () => {
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
    ["use-observable"]
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

test("deletes derived state only when transparent inputs match effect dependencies", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useState } from "react";
      export function Status({ login }: { login: { validated?: boolean; error?: string } }) {
        const [visible, setVisible] = useState(true);
        useEffect(() => { setVisible(!login.validated); }, [login.validated, login.error]);
        return <span>{String(visible)}</span>;
      }
    `),
    ["delete-derived-state", "delete-effect"]
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
      ["review-state", "review-effect"],
      body
    );
  }
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

test("keeps a same-owner reset effect behind an opaque controlled component", () => {
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
    ["review-state", "review-state", "review-effect"]
  );
});

test("does not move reset effects into opaque custom-component callbacks", () => {
  for (const mutation of [
    `<Controller onRender={setCategory} />`,
    `<Controller onMount={() => setCategory("next")} />`,
    `<Controller onChange={setCategory} />`,
  ]) {
    assert.deepEqual(
      actions(`
        import { useEffect, useState } from "react";
        export function Browser() {
          const [category, setCategory] = useState("all");
          const [detailIndex, setDetailIndex] = useState(0);
          useEffect(() => setDetailIndex(0), [category]);
          return <main>
            ${mutation}
            <button onClick={() => setDetailIndex(value => value + 1)}>{detailIndex}</button>
          </main>;
        }
      `),
      ["review-state", "review-state", "review-effect"],
      mutation
    );
  }
});

test("moves reset effects into intrinsic event callbacks", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useState } from "react";
      export function Browser() {
        const [category, setCategory] = useState("all");
        const [detailIndex, setDetailIndex] = useState(0);
        useEffect(() => setDetailIndex(0), [category]);
        return <main>
          <button onClick={() => setCategory("next")}>Next category</button>
          <button onClick={() => setDetailIndex(value => value + 1)}>{detailIndex}</button>
        </main>;
      }
    `),
    ["review-state", "review-state", "move-to-event"]
  );
});

test("does not move reset effects whose initializer evaluation is not stable", () => {
  for (const reset of ["nextPage()", "{}", "[]"]) {
    const findings = analyzeSource(`
        import { useEffect, useState } from "react";
        export function Browser() {
          const [category, setCategory] = useState("all");
          const [page, setPage] = useState(${reset});
          useEffect(() => setPage(${reset}), [category]);
          return <main>
            <button onClick={() => setCategory("next")}>Next category</button>
            <button onClick={() => setPage(${reset})}>Next page</button>
          </main>;
        }
      `, "fixture.tsx");
    assert.equal(
      findings.find(finding => finding.hook === "useEffect")?.action,
      "review-effect",
      reset
    );
  }
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

test("preserves React lifecycle timing when command-only state becomes a ref", () => {
  const findings = analyzeSource(`
    import { useLayoutEffect, useState } from "react";
    export function ChartPreview({ source }: { source: number[] }) {
      const [elements, setElements] = useState<number[]>([]);
      useLayoutEffect(() => {
        if (source.length === 0) setElements([]);
        else setElements(source.map(value => value * 2));
      }, [source]);
      const insert = () => save(elements);
      return <Button onPress={insert} />;
    }
  `, "fixture.tsx");
  const state = findings.find(finding => finding.hook === "useState");
  assert.equal(state?.action, "use-ref");
  assert.match(state?.message ?? "", /preserve any existing React lifecycle hook/i);
  assert.match(state?.evidence[2] ?? "", /effect writes 2/);
});

test("does not move lifecycle-written rendered or self-read state into a ref", () => {
  const rendered = analyzeSource(`
    import { useLayoutEffect, useState } from "react";
    export function Preview({ source }: { source: boolean }) {
      const [visible, setVisible] = useState(false);
      useLayoutEffect(() => setVisible(source), [source]);
      const report = () => save(visible);
      return <main><Button onPress={report} />{visible && <Panel />}</main>;
    }
  `, "fixture.tsx").find(finding => finding.hook === "useState");
  assert.notEqual(rendered?.action, "use-ref");

  const selfRead = analyzeSource(`
    import { useLayoutEffect, useState } from "react";
    export function Preview({ source }: { source: boolean }) {
      const [visible, setVisible] = useState(false);
      useLayoutEffect(() => { if (!visible) setVisible(source); }, [source, visible]);
      const report = () => save(visible);
      return <Button onPress={report} />;
    }
  `, "fixture.tsx").find(finding => finding.hook === "useState");
  assert.notEqual(selfRead?.action, "use-ref");
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

test("counts immediately invoked render computations as render reads", () => {
  const finding = analyzeSource(`
    import { useEffect, useState } from "react";
    export function Filter({ custom }: { custom: boolean }) {
      const [enabled, setEnabled] = useState(custom);
      useEffect(() => setEnabled(custom), [custom]);
      const selected = (() => enabled ? "custom" : "preset")();
      return <Select value={selected} onChange={() => setEnabled(true)} />;
    }
  `, "fixture.tsx").find(candidate => candidate.hook === "useState");
  assert.notEqual(finding?.action, "use-ref");
  assert.match(finding?.evidence[1] ?? "", /reads: render 1/);
});

test("does not call custom-hook reactions or returned commands event-rooted", () => {
  const focusReaction = analyzeSource(`
    import { useEffect, useState } from "react";
    export function Map() {
      const [idle, setIdle] = useState(false);
      useEffect(() => setIdle(false), []);
      useFocusEffect(() => { if (idle) fitBounds(); });
      return <MapView onIdle={() => setIdle(true)} />;
    }
  `, "fixture.tsx").find(candidate => candidate.hook === "useState");
  assert.notEqual(focusReaction?.action, "use-ref");

  const returnedCommand = analyzeSource(`
    import { useEffect, useState } from "react";
    export function useSteps(source: string) {
      const [next, setNext] = useState("");
      useEffect(() => setNext(source), [source]);
      const navigate = () => go(next);
      return { navigate };
    }
  `, "fixture.tsx").find(candidate => candidate.hook === "useState");
  assert.notEqual(returnedCommand?.action, "use-ref");
});

test("does not call a value shared by an event and an effect-owned callback command-only", () => {
  const finding = analyzeSource(`
    import { useCallback, useEffect, useState } from "react";
    export function Editor() {
      const [edited, setEdited] = useState(false);
      const confirm = useCallback(() => { if (edited) save(); }, [edited]);
      useEffect(() => {
        window.addEventListener("keydown", confirm);
        return () => window.removeEventListener("keydown", confirm);
      }, [confirm]);
      return <Input onChange={() => { if (!edited) setEdited(true); }} />;
    }
  `, "fixture.tsx").find(candidate => candidate.hook === "useState");
  assert.notEqual(finding?.action, "use-ref");
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

test("isolates keyed selection with select-all and partial-selection summaries", () => {
  const finding = analyzeSource(`
    import { useState } from "react";
    export function SelectionScreen({ rows }: { rows: Array<{ id: string }> }) {
      const [page, setPage] = useState(1);
      const [selected, setSelected] = useState<Set<string>>(() => new Set());
      const allSelected = rows.length > 0 && rows.every(row => selected.has(row.id));
      const someSelected = rows.some(row => selected.has(row.id));
      const toggleOne = (id: string) => setSelected(previous => {
        const next = new Set(previous);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
      const reset = () => { setPage(1); setSelected(new Set()); };
      return <Screen><Header checked={allSelected ? true : someSelected ? "indeterminate" : false} />
        <Toolbar /><Summary count={selected.size} /><Filters /><Actions onReset={reset} /><Status />
        <Help /><Footer page={page} /><Sidebar /><Banner /><Search />
        {rows.map(row => <Row key={row.id} selected={selected.has(row.id)} onPress={() => toggleOne(row.id)} />)}
      </Screen>;
    }
  `, "fixture.tsx").find(candidate => candidate.name === "selected");
  assert.equal(finding?.action, "use-observable");
});

test("uses keyed collection behavior rather than state names", () => {
  const finding = analyzeSource(`
    import { useState } from "react";
    export function Gallery({ rows }: { rows: Array<{ id: string; src: string }> }) {
      const [failures, setFailures] = useState<Set<string>>(() => new Set());
      const markFailed = (id: string) => setFailures(previous => new Set(previous).add(id));
      return <Screen><Header /><Toolbar /><Summary count={failures.size} /><Filters /><Actions />
        <Status /><Help /><Footer /><Sidebar /><Banner /><Search />
        {rows.map(row => <ImageRow key={row.id} fallback={failures.has(row.id)} onError={() => markFailed(row.id)} />)}
      </Screen>;
    }
  `, "fixture.tsx").find(candidate => candidate.name === "failures");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /per-row/);
});

test("rejects lifecycle and mount-control collections without name heuristics", () => {
  const findings = analyzeSource(`
    import { useEffect, useState } from "react";
    export function LifecycleRows({ rows }: { rows: Array<{ id: string }> }) {
      const [mounted, setMounted] = useState<Set<string>>(() => new Set());
      useEffect(() => setMounted(new Set(rows.map(row => row.id))), [rows]);
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status /><Help /><Footer />
        <Sidebar /><Banner /><Search />
        {rows.map(row => mounted.has(row.id) && <Row key={row.id} />)}
      </Screen>;
    }
    export function FailedRows({ rows }: { rows: Array<{ id: string }> }) {
      const [failed, setFailed] = useState<Set<string>>(() => new Set());
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status /><Help /><Footer />
        <Sidebar /><Banner /><Search />
        {rows.map(row => !failed.has(row.id) && <Row key={row.id} onError={() => setFailed(new Set([row.id]))} />)}
      </Screen>;
    }
  `, "fixture.tsx");
  for (const name of ["mounted", "failed"]) {
    assert.notEqual(findings.find(candidate => candidate.name === name)?.action, "use-observable");
  }
});

test("keeps keyed selection when summary membership controls row mounting", () => {
  const finding = analyzeSource(`
    import { useState } from "react";
    export function SelectionScreen({ rows }: { rows: Array<{ id: string }> }) {
      const [selected, setSelected] = useState<Set<string>>(() => new Set());
      const anySelected = rows.some(row => selected.has(row.id));
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status /><Help /><Footer />
        <Sidebar /><Banner /><Search />
        {anySelected && rows.map(row => <Row key={row.id} selected={selected.has(row.id)} onPress={() => setSelected(new Set([row.id]))} />)}
      </Screen>;
    }
  `, "fixture.tsx").find(candidate => candidate.name === "selected");
  assert.equal(finding?.action, "review-state");
});

test("requires a synchronous event-rooted collection update without hidden React work", () => {
  for (const update of [
    `const markDirty = () => setDirty(true);
     const toggle = (id: string) => { setSelected(new Set([id])); markDirty(); };`,
    `const toggle = (id: string) => { setTimeout(() => setSelected(new Set([id])), 10); };`,
    `const markDirty = () => setDirty(true);
     const toggle = (id: string) => setSelected(previous => {
       markDirty();
       return new Set(previous).add(id);
     });`,
  ]) {
    const finding = analyzeSource(`
      import { useState } from "react";
      export function SelectionScreen({ rows }: { rows: Array<{ id: string }> }) {
        const [dirty, setDirty] = useState(false);
        const [selected, setSelected] = useState<Set<string>>(() => new Set());
        ${update}
        return <Screen><Header dirty={dirty} /><Toolbar /><Summary count={selected.size} /><Filters /><Actions />
          <Status /><Help /><Footer /><Sidebar /><Banner /><Search />
          {rows.map(row => <Row key={row.id} selected={selected.has(row.id)} onPress={() => toggle(row.id)} />)}
        </Screen>;
      }
    `, "fixture.tsx").find(candidate => candidate.name === "selected");
    assert.equal(finding?.action, "review-state");
  }
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

test("ignores callback dependency references when proving a keyed event command", () => {
  const [finding] = analyzeSource(`
    import { useCallback, useState } from "react";
    export function SelectionScreen({ rows }: { rows: Array<{ id: string }> }) {
      const [selected, setSelected] = useState<Set<string>>(() => new Set());
      const toggle = useCallback((id: string) => {
        vibrate();
        setSelected(previous => {
          const next = new Set(previous);
          next.has(id) ? next.delete(id) : next.add(id);
          return next;
        });
      }, []);
      const renderItem = useCallback(({ item }: { item: { id: string } }) =>
        <Row selected={selected.has(item.id)} onPress={() => toggle(item.id)} />,
        [selected, toggle]
      );
      return <Screen><Header /><Toolbar /><Summary count={selected.size} /><Filters /><Actions /><Status />
        <Help /><Footer /><Sidebar /><Banner /><Search /><List data={rows} renderItem={renderItem} />
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
    import { cacheKey, openWorkspace } from "./workspace";
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
    export function Cache({ client, id }: { client: { invalidate: (input: unknown) => void }; id: string }) {
      useEffect(() => {
        client.invalidate({ key: cacheKey(id) });
      }, [client, id]);
      return null;
    }
  `, "fixture.tsx").filter(finding => finding.hook === "useEffect");
  assert.deepEqual(effects.map(finding => finding.action), ["keep-effect", "keep-effect", "keep-effect"]);
});

test("keeps externally prepared dependency-driven navigation in React", () => {
  const effects = analyzeSource(`
    import { useEffect } from "react";
    import { format, isEmptyObject } from "./values";
    import { Navigation, ROUTES } from "./navigation";
    export function EmptyReport({ report }: { report: object | null }) {
      useEffect(() => {
        if (!report || isEmptyObject(report)) return;
        Navigation.dismissModal();
      }, [report]);
      return null;
    }
    export function Membership({ emails, login }: { emails: string[]; login: string }) {
      useEffect(() => {
        if (!emails.includes(login)) return;
        Navigation.goBack(ROUTES.member(login));
      }, [emails, login]);
      return null;
    }
    export function CurrentPeriod({ period }: { period: string | null }) {
      useEffect(() => {
        const current = format(new Date(), "yyyyMM");
        if (period?.length !== 6 || period > current) Navigation.dismissModal();
      }, [period]);
      return null;
    }
    export function RepeatedCommands({ values }: { values: string[] }) {
      useEffect(() => { for (const value of values) Navigation.navigate(value); }, [values]);
      return null;
    }
  `, "fixture.tsx").filter(finding => finding.hook === "useEffect");
  assert.deepEqual(effects.map(finding => finding.action), [
    "keep-effect",
    "keep-effect",
    "keep-effect",
    "keep-effect",
  ]);
});

test("reviews unsafe dependency-driven command preparation", () => {
  const effects = analyzeSource(`
    import { useEffect, useState } from "react";
    import { Navigation } from "./navigation";
    import { subscribe } from "./resource";
    import { useSharedValue, withRepeat, withTiming } from "./animation";
    export function LocalHelper({ ready }: { ready: boolean }) {
      const [dirty, setDirty] = useState(false);
      const check = () => { setDirty(true); return ready; };
      useEffect(() => { if (check()) Navigation.dismissModal(); }, [ready]);
      return <output>{dirty}</output>;
    }
    export function Subscription({ ready }: { ready: boolean }) {
      useEffect(() => { if (subscribe(ready)) Navigation.dismissModal(); }, [ready]);
      return null;
    }
    export function Scheduled({ ready }: { ready: boolean }) {
      useEffect(() => { if (setTimeout(() => ready, 0)) Navigation.dismissModal(); }, [ready]);
      return null;
    }
    export function ArbitraryConstructor({ ready }: { ready: boolean }) {
      useEffect(() => { const value = new Widget(ready); if (value) Navigation.dismissModal(); }, [ready]);
      return null;
    }
    export function HookResource({ speed }: { speed: number }) {
      const progress = useSharedValue(0);
      useEffect(() => { progress.set(withRepeat(withTiming(speed))); }, [progress, speed]);
      return null;
    }
    export function CallbackResource({ path }: { path: string }) {
      useEffect(() => {
        const onSuccess = () => Navigation.dismissModal();
        loadResource(path, onSuccess);
      }, [path]);
      return null;
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

test("keeps one translated external notification in React", () => {
  const effects = analyzeSource(`
    import { useEffect } from "react";
    import { useTranslation, useTranslation as useI18n } from "react-i18next";
    import { toast } from "sonner";
    export function Users({ count, error }: { count: number; error: Error | null }) {
      const { t } = useTranslation();
      useEffect(() => {
        if (error) toast.error(t("Could not load {{count}} users", { count }));
      }, [t, count, error]);
      return null;
    }
    export function Groups({ error }: { error: Error | null }) {
      const { t: translate } = useI18n();
      useEffect(() => {
        if (error) toast.error(translate("Could not load groups"));
      }, [translate, error]);
      return null;
    }
  `, "fixture.tsx").filter(finding => finding.hook === "useEffect");
  assert.deepEqual(effects.map(finding => finding.action), ["keep-effect", "keep-effect"]);
});

test("does not trust local formatters or lookalike translation hooks in external effects", () => {
  const effects = analyzeSource(`
    import { useEffect } from "react";
    import { useTranslation as useLookalike } from "./translations";
    import { useTranslation } from "react-i18next";
    import { toast } from "sonner";
    export function LocalFormatter({ error }: { error: Error | null }) {
      const t = (message: string) => message;
      useEffect(() => { if (error) toast.error(t("Failed")); }, [t, error]);
      return null;
    }
    export function LookalikeHook({ error }: { error: Error | null }) {
      const { t } = useLookalike();
      useEffect(() => { if (error) toast.error(t("Failed")); }, [t, error]);
      return null;
    }
    export function MissingDependency({ error }: { error: Error | null }) {
      const { t } = useTranslation();
      useEffect(() => { if (error) toast.error(t("Failed")); }, [error]);
      return null;
    }
    export function ShadowedHook({ error }: { error: Error | null }) {
      const useTranslation = () => ({ t: (message: string) => message });
      const { t } = useTranslation();
      useEffect(() => { if (error) toast.error(t("Failed")); }, [t, error]);
      return null;
    }
    export function ArbitraryPreparation({ error }: { error: Error | null }) {
      const { t } = useTranslation();
      useEffect(() => { if (error) toast.error(t(buildMessage(error))); }, [t, error]);
      return null;
    }
  `, "fixture.tsx").filter(finding => finding.hook === "useEffect");
  assert.deepEqual(effects.map(finding => finding.action), [
    "review-effect",
    "review-effect",
    "review-effect",
    "review-effect",
    "review-effect",
  ]);
});

test("keeps dependency-driven browser-storage persistence in React", () => {
  const effects = analyzeSource(`
    import { useEffect, useState } from "react";
    export function Filters({ ready, workspaceId }: { ready: boolean; workspaceId: string }) {
      const [query, setQuery] = useState("");
      const [statuses, setStatuses] = useState<string[]>([]);
      useEffect(() => {
        if (!ready || globalThis.window === undefined) return;
        globalThis.window.localStorage.setItem(
          workspaceId + ":filters",
          JSON.stringify({ query, statuses })
        );
        if (Object.keys(statuses).length > 0) {
          sessionStorage.setItem("has-statuses", "true");
        } else {
          window.sessionStorage.removeItem("has-statuses");
        }
      }, [query, statuses, ready, workspaceId]);
      return <input value={query} onChange={event => setQuery(event.target.value)} />;
    }
  `, "fixture.tsx").filter(finding => finding.hook === "useEffect");
  assert.deepEqual(effects.map(finding => finding.action), ["keep-effect"]);
  assert.match(effects[0]?.message ?? "", /browser storage/i);
});

test("does not call storage hydration, scheduling, arbitrary work, or observable reactions persistence", () => {
  const effects = analyzeSource(`
    import { useEffect, useState } from "react";
    import { useValue } from "@legendapp/state/react";
    export function Hydrate({ value, value$ }: { value: string; value$: unknown }) {
      const [stored, setStored] = useState("");
      const observed = useValue(value$);
      useEffect(() => {
        const next = localStorage.getItem("value");
        if (next) setStored(next);
      }, [value]);
      useEffect(() => { setTimeout(() => localStorage.setItem("value", value), 10); }, [value]);
      useEffect(() => { localStorage.setItem("value", serialize(value)); }, [value]);
      useEffect(() => { localStorage.setItem("value", value); report(value); }, [value]);
      useEffect(async () => { localStorage.setItem("value", value); }, [value]);
      useEffect(() => {
        localStorage.setItem("value", value);
        return () => localStorage.removeItem("value");
      }, [value]);
      useEffect(() => { localStorage.setItem("observed", JSON.stringify(observed)); }, [observed]);
      return <output>{stored}</output>;
    }
    export function ShadowedStorage({ value }: { value: string }) {
      const localStorage = { setItem: (_key: string, _value: string) => undefined };
      useEffect(() => { localStorage.setItem("value", value); }, [value]);
      return null;
    }
    export function ShadowedJson({ value }: { value: string }) {
      const JSON = { stringify: (_value: unknown) => "custom" };
      useEffect(() => { window.localStorage.setItem("value", JSON.stringify(value)); }, [value]);
      return null;
    }
  `, "fixture.tsx").filter(finding => finding.hook === "useEffect");
  assert.deepEqual(effects.map(finding => finding.action), [
    "review-effect",
    "review-effect",
    "review-effect",
    "review-effect",
    "review-effect",
    "keep-effect",
    "use-observe-effect",
    "keep-effect",
    "review-effect",
  ]);
  assert.doesNotMatch(effects[7]?.message ?? "", /browser storage/i);
});

test("reviews local-state, helper, scheduled, multi-command, collection, and subscription effects", () => {
  const effects = analyzeSource(`
    import { useEffect, useState } from "react";
    import { fetchResource, reportResource, resources, subscribeToResource } from "./resource";
    export function Screen({ id }: { id: string }) {
      const [query, setQuery] = useState("");
      const load = () => fetchResource(id);
      useEffect(() => { fetchResource(query); }, [query]);
      useEffect(() => { load(); }, [load]);
      useEffect(() => { setTimeout(() => fetchResource(id), 10); }, [id]);
      useEffect(() => { fetchResource(id); reportResource(id); }, [id]);
      useEffect(() => { [id].forEach(value => fetchResource(value)); }, [id]);
      useEffect(() => { subscribeToResource(id); }, [id]);
      useEffect(() => { animation.set(withRepeat(withTiming(id))); }, [animation, id]);
      useEffect(() => { const key = resourceKey(id); fetchResource(key); }, [id]);
      useEffect(() => { fetchResource(resources.map(resource => resource + id)); }, [id]);
      useEffect(() => { fetchResource({ id, resolve: () => id }); }, [id]);
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
    "review-effect",
    "review-effect",
    "review-effect",
    "review-effect",
  ]);
});

test("honors an adjacent directive that keeps lifecycle ownership in React", () => {
  for (const directive of [
    "react-effect-allow timer: preserve React replay",
    "legend-doctor keep-react-effect",
  ]) {
    const [finding] = analyzeSource(`
      import { useEffect, useRef } from "react";
      export function Screen() {
        const timer = useRef<number | null>(null);
        // ${directive}
        useEffect(() => () => {
          if (timer.current !== null) clearTimeout(timer.current);
        }, []);
        return null;
      }
    `, "fixture.tsx");
    assert.equal(finding?.action, "keep-effect");
    assert.equal(finding?.confidence, "certain");
    assert.match(finding?.message ?? "", /ownership directive/);
  }
});

test("does not apply a detached or unrelated React effect comment", () => {
  for (const source of [
    `
      import { useEffect } from "react";
      // react-effect-allow timer
      const label = "detached";
      export function Screen() {
        useEffect(() => () => release(), []);
        return label;
      }
    `,
    `
      import { useEffect } from "react";
      export function Screen() {
        const policy = "react-effect-allow";
        useEffect(() => () => release(), []);
        return policy;
      }
    `,
    `
      import { useEffect } from "react";
      export function Screen() {
        // Documentation mentions legend-doctor keep-react-effect, but this is not a directive.
        useEffect(() => () => release(), []);
        return null;
      }
    `,
    `
      import { useEffect } from "react";
      export function Screen() {
        // legend-doctor keep-react-effect

        useEffect(() => () => release(), []);
        return null;
      }
    `,
  ]) {
    const [finding] = analyzeSource(source, "fixture.tsx");
    assert.equal(finding?.action, "use-unmount");
  }
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

test("keeps exact latest-value ref mirrors in React post-commit timing", () => {
  const findings = analyzeSource(`
    import React, { useEffect, useRef as useLatestRef } from "react";
    export function Named({ value }: { value: string }) {
      const latest = useLatestRef(value);
      useEffect(() => { latest.current = value; }, [value]);
      return null;
    }
    export function Namespace({ items }: { items: string[] }) {
      const count = React.useRef(items.length);
      React.useEffect(() => { count.current = items.length; }, [items.length]);
      return null;
    }
    export function EveryCommit({ value }: { value: string }) {
      const previous = React.useRef(value);
      React.useEffect(() => { previous.current = value; });
      return null;
    }
  `, "fixture.tsx").filter(finding => finding.hook === "useEffect");
  assert.deepEqual(findings.map(finding => finding.action), ["keep-effect", "keep-effect", "keep-effect"]);
  for (const finding of findings) assert.match(finding.message, /committed ref/i);
});

test("reviews unproven or behaviorally different ref mirror effects", () => {
  const effects = analyzeSource(`
    import { useEffect, useRef } from "react";
    export function WrongDependency({ value, other }: { value: string; other: string }) {
      const latest = useRef(value);
      useEffect(() => { latest.current = value; }, [other]);
      return null;
    }
    export function EmptyDependency({ value }: { value: string }) {
      const firstCommit = useRef(value);
      useEffect(() => { firstCommit.current = value; }, []);
      return null;
    }
    export function ExtraWork({ value }: { value: string }) {
      const latest = useRef(value);
      useEffect(() => { latest.current = value; report(value); }, [value]);
      return null;
    }
    export function Compound({ value }: { value: number }) {
      const total = useRef(value);
      useEffect(() => { total.current += value; }, [value]);
      return null;
    }
    export function Shadowed({ value, useRef }: { value: string; useRef: (value: string) => { current: string } }) {
      const latest = useRef(value);
      useEffect(() => { latest.current = value; }, [value]);
      return null;
    }
    export function SelfRead() {
      const latest = useRef(0);
      useEffect(() => { latest.current = latest.current; }, [latest.current]);
      return null;
    }
    export function RepeatedCall() {
      const latest = useRef(0);
      useEffect(() => { latest.current = read(); }, [read()]);
      return null;
    }
    export function EveryCommitCall() {
      const latest = useRef(0);
      useEffect(() => { latest.current = read(); });
      return null;
    }
    export function EveryCommitSelfRead() {
      const latest = useRef(0);
      useEffect(() => { latest.current = latest.current; });
      return null;
    }
    export function EveryCommitGuard({ enabled, value }: { enabled: boolean; value: string }) {
      const latest = useRef(value);
      useEffect(() => {
        if (enabled) latest.current = value;
      });
      return null;
    }
  `, "fixture.tsx").filter(finding => finding.hook === "useEffect");
  assert.deepEqual(effects.map(finding => finding.action), [
    "review-effect",
    "review-effect",
    "review-effect",
    "review-effect",
    "review-effect",
    "review-effect",
    "review-effect",
    "review-effect",
    "review-effect",
    "review-effect",
  ]);
});

test("keeps a forwarded ref snapshot in React post-commit timing", () => {
  assert.deepEqual(
    actions(`
      import { type RefObject, useEffect, useState } from "react";
      export function Grid({ containerRef }: { containerRef: RefObject<HTMLElement | null> }) {
        const [container, setContainer] = useState<HTMLElement | null>(null);
        useEffect(() => {
          setContainer(containerRef.current);
        }, [containerRef]);
        return <VirtualGrid container={container} />;
      }
    `),
    ["review-state", "keep-effect"]
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

test("keeps a direct latest-value ref mirror in post-commit timing", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useRef } from "react";
      export function Screen({ value }: { value: string }) {
        const latest = useRef(value);
        useEffect(() => { latest.current = value; }, [value]);
        return null;
      }
    `),
    ["keep-effect"]
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

test("keeps conditional useUnmount advice as a candidate", () => {
  const [finding] = analyzeSource(`
    import { useEffect } from "react";
    import { release } from "./resource";
    export function App() {
      useEffect(() => () => release(), []);
      return null;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "use-unmount");
  assert.equal(finding?.disposition, "candidate");
});

test("does not call returned setup work a teardown-only effect", () => {
  for (const cleanup of [
    `subscribe()`,
    `source.listen()`,
    `cleanupRef.current`,
    `ready ? cleanupA : cleanupB`,
  ]) {
    assert.deepEqual(
      actions(`
        import { useEffect } from "react";
        export function Screen() {
          useEffect(() => { return ${cleanup}; }, []);
          return null;
        }
      `),
      ["keep-effect"],
      cleanup
    );
  }
});

test("recognizes direct returned cleanup function values", () => {
  for (const cleanup of [`() => release()`, `function cleanup() { release(); }`, `cleanup`]) {
    assert.deepEqual(
      actions(`
        import { useEffect } from "react";
        export function Screen() {
          useEffect(() => { return ${cleanup}; }, []);
          return null;
        }
      `),
      ["use-unmount"],
      cleanup
    );
  }
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

test("does not move deferred useValue reads into an untracked observable reaction", () => {
  for (const body of [
    `setTimeout(() => report(value), 10);`,
    `Promise.resolve().then(() => report(value));`,
    `source.subscribe(() => report(value));`,
    `const later = () => report(value); register(later);`,
    `report(value); setTimeout(() => report(value), 10);`,
  ]) {
    assert.deepEqual(
      actions(`
        import { useEffect } from "react";
        import { useValue } from "@legendapp/state/react";
        export function Screen({ value$, source }: { value$: unknown; source: { subscribe: (callback: () => void) => void } }) {
          const value = useValue(value$);
          useEffect(() => { ${body} }, [value]);
          return null;
        }
      `),
      ["review-effect"],
      body
    );
  }
});

test("does not replace async effects or callbacks with observable reactions", () => {
  for (const effect of [
    `useEffect(async () => { await load(); report(value); }, [value]);`,
    `useEffect(() => { void (async () => { await load(); report(value); })(); }, [value]);`,
  ]) {
    assert.deepEqual(
      actions(`
        import { useEffect } from "react";
        import { useValue } from "@legendapp/state/react";
        export function Screen({ value$ }: { value$: unknown }) {
          const value = useValue(value$);
          ${effect}
          return null;
        }
      `),
      ["review-effect"],
      effect
    );
  }
});

test("tracks useValue reads through synchronous collection callbacks", () => {
  assert.deepEqual(
    actions(`
      import { useEffect } from "react";
      import { useValue } from "@legendapp/state/react";
      export function Screen({ selected$, items }: { selected$: unknown; items: { id: string }[] }) {
        const selected = useValue(selected$);
        useEffect(() => {
          report(items.find(item => item.id === selected));
        }, [selected]);
        return null;
      }
    `),
    ["use-observe-effect"]
  );
});

test("does not trust collection method names on an unknown scheduler", () => {
  assert.deepEqual(
    actions(`
      import { useEffect } from "react";
      import { useValue } from "@legendapp/state/react";
      export function Screen({ value$, scheduler }: {
        value$: unknown;
        scheduler: { find: (callback: () => boolean) => unknown };
      }) {
        const value = useValue(value$);
        useEffect(() => {
          scheduler.find(() => {
            report(value);
            return true;
          });
        }, [value]);
        return null;
      }
    `),
    ["review-effect"]
  );
});

test("does not trust a shadowed Array type as a synchronous collection", () => {
  assert.deepEqual(
    actions(`
      import { useEffect } from "react";
      import { useValue } from "@legendapp/state/react";
      type Array<T> = { find: (callback: (value: T) => boolean) => T | undefined };
      export function Screen({ selected$, items }: { selected$: unknown; items: Array<{ id: string }> }) {
        const selected = useValue(selected$);
        useEffect(() => {
          report(items.find(item => item.id === selected));
        }, [selected]);
        return null;
      }
    `),
    ["review-effect"]
  );
});

test("does not trust reassigned or method-overridden array receivers", () => {
  for (const setup of [
    `let items: { id: string }[] = []; items = makeScheduler();`,
    `const items: { id: string }[] = []; items.find = schedule;`,
  ]) {
    assert.deepEqual(
      actions(`
        import { useEffect } from "react";
        import { useValue } from "@legendapp/state/react";
        export function Screen({ selected$ }: { selected$: unknown }) {
          const selected = useValue(selected$);
          ${setup}
          useEffect(() => {
            report(items.find(item => item.id === selected));
          }, [selected]);
          return null;
        }
      `),
      ["review-effect"],
      setup
    );
  }
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
