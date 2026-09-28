import type { HookFinding } from "../../src/core/types.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

const HELPER_ELEMENTS = "<A /><B /><C /><D /><E /><F /><G /><H /><I /><J />";

const CHROME =
  "<Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />";

function findingOf(source: string, name: string): HookFinding {
  return requireValue(
    analyzeSource(source, "fixture.tsx").find((finding) => finding.name === name),
  );
}

function actionOf(source: string, name: string): string {
  return findingOf(source, name).action;
}

function groupedActions(source: string): string[] {
  return analyzeSource(source, "fixture.tsx")
    .filter((finding) => finding.group)
    .map((finding) => finding.action);
}

test("keeps a nullable dialog payload up when the dialog calls a large owner-local helper", () => {
  const source = (dialogBody: string, outside: string): string => `
    import { useState } from "react";
    interface Item { id: string; name: string }
    export function Screen({ item }: { item: Item }) {
      const [target, setTarget] = useState<Item | null>(null);
      const confirm = () => {
        if (!target) return;
        remove(target.id);
        setTarget(null);
      };
      const renderDetails = () => <section>${HELPER_ELEMENTS}</section>;
      return <main>
        ${CHROME}<Details />${HELPER_ELEMENTS}
        <button onClick={() => setTarget(item)}>Delete</button>
        ${outside}
        {target && <dialog open>
          <h2>Delete {target.name}</h2>
          ${dialogBody}
          <button onClick={confirm}>Confirm</button>
        </dialog>}
      </main>;
    }
  `;
  assert.equal(actionOf(source("", "{renderDetails()}"), "target"), "use-observable");
  assert.notEqual(actionOf(source("{renderDetails()}", ""), "target"), "use-observable");
});

test("keeps a controlled projection up when its sibling calls a large owner-local helper", () => {
  const source = (hint: string, outside: string): string => `
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    function Preview() { return null; }
    function Submit(_props: unknown) { return null; }
    export function Form() {
      const [query, setQuery] = useState("");
      const submit = () => save(query);
      const renderHint = () => <ul>${HELPER_ELEMENTS}</ul>;
      return <main>
        <Preview />${outside}
        <Field value={query} onChange={event => setQuery(event.target.value)} />
        <Submit disabled={!query.trim()} onClick={submit} ${hint} />
      </main>;
    }
  `;
  assert.equal(actionOf(source("", "{renderHint()}"), "query"), "use-observable");
  assert.notEqual(actionOf(source("hint={renderHint()}", ""), "query"), "use-observable");
});

test("keeps a sibling preview up when it calls a large owner-local helper", () => {
  const source = (legend: string, outside: string): string => `
    import { useCallback, useState } from "react";
    export function Picker({ items }: { items: string[] }) {
      const [active, setActive] = useState<string | null>(null);
      const handleActive = useCallback((item: string) => setActive(item), []);
      const renderLegend = () => <ul>${HELPER_ELEMENTS}</ul>;
      return <main>
        <Grid items={items} onItemActive={handleActive} />
        <Preview item={active ?? chooseFallback(items)} ${legend} />
        <Footer /><Help /><Status />${outside}
      </main>;
    }
  `;
  assert.equal(actionOf(source("", "{renderLegend()}"), "active"), "use-observable");
  assert.notEqual(actionOf(source("legend={renderLegend()}", ""), "active"), "use-observable");
});

test("keeps payload-gated feedback grouped only while its leaf stays small", () => {
  const source = (fallback: string, outside: string): string => `
    import { useState } from "react";
    function Dialog(_props: unknown) { return null; }
    function Button(_props: unknown) { return null; }
    export function ResetDialog({ account }: { account: { id: string } }) {
      const [password, setPassword] = useState<string | null>(null);
      const [copied, setCopied] = useState(false);
      useResetPassword({
        onSuccess: (result: { password: string }) => setPassword(result.password),
      });
      const copy = async () => {
        if (!password) return;
        await navigator.clipboard.writeText(password);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      };
      const close = () => {
        setPassword(null);
        setCopied(false);
        dismiss();
      };
      const renderCopyHint = () => <span>${HELPER_ELEMENTS}</span>;
      if (!account) return null;
      ${"\n".repeat(100)}
      return <Dialog onClose={close}><Header /><Toolbar /><Summary /><Fields /><Preview /><Help />
        <Status /><History /><Aside /><Footer /><Actions />${outside}
        {password ? <section><code>{password}</code><Button onClick={copy}>{copied ? "Copied" : ${fallback}}</Button></section> : <Confirm account={account} />}
      </Dialog>;
    }
  `;
  assert.deepEqual(groupedActions(source('"Copy"', "{renderCopyHint()}")), [
    "use-observable",
    "use-observable",
  ]);
  assert.deepEqual(groupedActions(source("renderCopyHint()", "")), []);
});

test("charges render sites for the JSX a moved derived constant builds", () => {
  const source = (breakdown: string): string => `
    import { useState } from "react";
    export function Dashboard({ total }: { total: number }) {
      const [count, setCount] = useState(0);
      const breakdown = count > 3 ? ${breakdown} : null;
      return (
        <section className="dashboard">
          ${CHROME}
          <p>{count} of {total}</p>
          <button onClick={() => setCount(count + 1)}>Add</button>
          <footer>{breakdown}</footer>
        </section>
      );
    }
  `;
  assert.equal(actionOf(source("<strong>Many</strong>"), "count"), "use-observable");
  assert.notEqual(actionOf(source(`<ul>${HELPER_ELEMENTS}</ul>`), "count"), "use-observable");
});

test("does not bound an effect-split presentation leaf that calls a large owner-local helper", () => {
  const source = (leaf: string, outside: string): string => `
    import { useEffect, useState } from "react";
    export function Dashboard({ items }: { items: string[] }) {
      const [count, setCount] = useState(0);
      useEffect(() => { setCount(items.length); }, [items]);
      const renderBreakdown = () => <ul>${HELPER_ELEMENTS}</ul>;
      return (
        <section>
          ${CHROME}
          <p>{count} items${leaf}</p>${outside}
          <footer>{count > 3 ? <strong>Many</strong> : null}</footer>
        </section>
      );
    }
  `;
  const presentationLeaves = /bounded presentation leaves/u;
  assert.match(
    findingOf(source("", "<aside>{renderBreakdown()}</aside>"), "count").message ?? "",
    presentationLeaves,
  );
  assert.doesNotMatch(
    findingOf(source(" {renderBreakdown()}", "<aside />"), "count").message ?? "",
    presentationLeaves,
  );
});

test("does not bound a repeated effect-split leaf whose rows call a large owner-local helper", () => {
  const source = (row: string, outside: string): string => `
    import { useEffect, useState } from "react";
    const rows = [{ id: "one", start: 0 }, { id: "two", start: 10 }];
    export function SafeTicker() {
      const [elapsed, setElapsed] = useState(0);
      useEffect(() => {
        setElapsed(0);
        const timer = setInterval(() => setElapsed(Date.now()), 200);
        return () => clearInterval(timer);
      }, []);
      const active = Math.floor(elapsed / 10);
      const renderMarker = () => <span><A /><B /><C /><D /><E /><F /><G /></span>;
      return <main>
        <ol>{rows.map(row => <li key={row.id} data-active={row.start === active}>{row.id}${row}</li>)}</ol>
        <progress value={elapsed / 100}/>${outside}
        <Header/><Summary/><Chart/><List/><Footer/><Aside/><Toolbar/><Legend/><Caption/><Logo/><Badge/><Actions/>
        <Nav/><Search/><Help/><Status/>
      </main>;
    }
  `;
  assert.equal(actionOf(source("", "{renderMarker()}"), "elapsed"), "use-observable");
  assert.notEqual(actionOf(source("{renderMarker()}", ""), "elapsed"), "use-observable");
});

test("does not group a dialog model whose gated branch calls a broad owner-local helper", () => {
  const source = (children: string, outside: string): string => `
    import { useState } from "react";
    interface Item { id: string }
    function ItemDialog(_props: unknown) { return null; }
    export function Screen({ item }: { item: Item }) {
      const [target, setTarget] = useState<Item | null>(null);
      const [open, setOpen] = useState(false);
      const show = () => { setTarget(item); setOpen(true); };
      const renderBody = () => <section>${HELPER_ELEMENTS}<K /><L /><M /></section>;
      ${"\n".repeat(100)}
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
        <Aside /><Help /><Status /><Actions /><Preview />${outside}
        {target && <ItemDialog target={target} open={open} onOpenChange={setOpen} onShow={show}>
          ${children}
        </ItemDialog>}
      </main>;
    }
  `;
  assert.deepEqual(groupedActions(source("", "{renderBody()}")), [
    "use-observable",
    "use-observable",
  ]);
  assert.deepEqual(groupedActions(source("{renderBody()}", "")), []);
});

test("keeps keyed selection up when its footer calls a large owner-local helper", () => {
  const source = (tips: string, outside: string): string => `
    import { useState } from "react";
    export function Results({ rows }: { rows: Array<{ id: string }> }) {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      const selected = rows.find(row => row.id === selectedId) ?? null;
      const accept = () => selected && save(selected);
      const renderTips = () => <ul>${HELPER_ELEMENTS}</ul>;
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Status /><Help />
        <Sidebar /><Banner /><Search /><Preview />${outside}
        {rows.map(row => <Row key={row.id} selected={selectedId === row.id}
          onPress={() => setSelectedId(row.id)} />)}
        <Footer disabled={!selected} onAccept={accept} ${tips} />
      </Screen>;
    }
  `;
  assert.equal(actionOf(source("", "{renderTips()}"), "selectedId"), "use-observable");
  assert.notEqual(actionOf(source("tips={renderTips()}", ""), "selectedId"), "use-observable");
});

test("keeps keyed membership up when its summary gate calls a large owner-local helper", () => {
  const source = (gated: string, outside: string): string => `
    import { useState } from "react";
    export function Labels({ rows }: { rows: Array<{ id: string; name: string }> }) {
      const [selectedIds, setSelectedIds] = useState<string[]>([]);
      const selectedIdSet = new Set(selectedIds);
      const selectedRows = rows.filter(row => selectedIdSet.has(row.id));
      const toggle = (id: string) => setSelectedIds(previous =>
        previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]
      );
      const renderLegend = () => <ul>${HELPER_ELEMENTS}</ul>;
      return <Screen><Header /><Toolbar /><Summary count={selectedIds.length} /><Filters /><Actions /><Status /><Help /><Footer /><Sidebar /><Banner /><Search />${outside}
        {selectedRows.length > 0 && <aside>${gated}{selectedRows.map(row => <Badge key={row.id} onClick={() => toggle(row.id)}>{row.name}</Badge>)}</aside>}
        {rows.map(row => <Row key={row.id} selected={selectedIdSet.has(row.id)} onPress={() => toggle(row.id)} />)}
      </Screen>;
    }
  `;
  assert.equal(actionOf(source("", "{renderLegend()}"), "selectedIds"), "use-observable");
  assert.notEqual(actionOf(source("{renderLegend()}", ""), "selectedIds"), "use-observable");
});

test("keeps an object draft up when a property leaf calls a large owner-local helper", () => {
  const source = (icon: string, outside: string): string => `
    import { useState } from "react";
    interface Draft { title: string; notes: string; }
    const EMPTY_DRAFT: Draft = { title: "", notes: "" };
    export function Form() {
      const [draft, setDraft] = useState(EMPTY_DRAFT);
      const submit = () => save(draft.title, draft.notes);
      const renderIcon = () => <svg>${HELPER_ELEMENTS}</svg>;
      return <form onSubmit={submit}>
        <Header /><Summary /><Help /><Preview /><History /><Status /><Aside /><Footer /><Actions /><Metrics />${outside}
        <input value={draft.title} onChange={event => setDraft(previous => ({ ...previous, title: event.target.value }))} />
        <textarea value={draft.notes} onChange={event => setDraft(previous => ({ ...previous, notes: event.target.value }))} />
        <button disabled={!draft.title}>${icon}Save</button>
      </form>;
    }
  `;
  assert.equal(actionOf(source("", "{renderIcon()}"), "draft"), "use-observable");
  assert.notEqual(actionOf(source("{renderIcon()}", ""), "draft"), "use-observable");
});

test("keeps a synchronized draft up when its local cut calls an owner-local helper", () => {
  const source = (inside: string, outside: string): string => `
    import { useEffect, useState } from "react";
    export function Editor({ open, saved }: { open: boolean; saved: string }) {
      const [value, setValue] = useState(saved);
      const [error, setError] = useState<string | null>(null);
      useEffect(() => { if (open) { setValue(saved); setError(null); } }, [open, saved]);
      const renderHints = () => <ul><li>Use plain text</li></ul>;
      return <Dialog>
        <Header /><Description />${outside}
        <section>
          <textarea value={value} onChange={event => { setValue(event.target.value); setError(null); }} />
          {error && <p>{error}</p>}${inside}
        </section>
        <Footer /><Cancel /><Save onError={() => setError("invalid")} />
      </Dialog>;
    }
  `;
  assert.equal(actionOf(source("", "{renderHints()}"), "value"), "use-observable");
  assert.notEqual(actionOf(source("{renderHints()}", ""), "value"), "use-observable");
});

test("keeps a synchronized draft up when its transport target calls a large owner-local helper", () => {
  const source = (label: string, outside: string): string => `
    import { useEffect, useState } from "react";
    export function DeletePanel({ initial, rows }: { initial: boolean; rows: string[] }) {
      const [decrement, setDecrement] = useState(initial);
      useEffect(() => { setDecrement(initial); }, [initial]);
      const remove = async () => {
        await Promise.all(rows.map(id => destroy(id, { decrement })));
      };
      const renderLabel = () => <label>${HELPER_ELEMENTS}</label>;
      return <main><Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation />${outside}
        <Checkbox checked={decrement} onCheckedChange={setDecrement} ${label} /><button onClick={remove} />
      </main>;
    }
  `;
  assert.equal(actionOf(source("", "{renderLabel()}"), "decrement"), "use-observable");
  assert.notEqual(actionOf(source("label={renderLabel()}", ""), "decrement"), "use-observable");
});
