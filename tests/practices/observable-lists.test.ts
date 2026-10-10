import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

function listPractices(body: string, extra = ""): ReturnType<typeof analyzeLegendPractices> {
  return analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const todos$ = observable([{ id: "a", title: "A" }]);
    ${extra}
    export function Todos({ onSelect, highlight }) {
      const todos = useValue(todos$);
      return <main>
        <Header />
        ${body}
      </main>;
    }
  `,
    fileName: "fixture.tsx",
  });
}

const forFindings = (body: string, extra?: string): readonly string[] =>
  listPractices(body, extra)
    .filter((finding) => finding.action === "render-list-with-for")
    .map((finding) => finding.message);

test("renders a keyed map that is the list's only read with For", () => {
  const [message] = forFindings(
    "<ul>{todos.map((todo) => <TodoRow key={todo.id} todo={todo} />)}</ul>",
  );
  assert.match(
    requireValue(message),
    /`<For each=\{todos\$\}>\{\(todo\$\) => \{ const todo = todo\$\.get\(\); return <TodoRow … \/>; \}\}<\/For>`/u,
  );
});

test("keeps the map when For would change the rows' keys, captures, or mounts", () => {
  for (const body of [
    "<ul>{todos.map((todo, index) => <TodoRow key={index} todo={todo} />)}</ul>",
    "<ul>{todos.map((todo) => <TodoRow key={todo.title} todo={todo} />)}</ul>",
    "<ul>{todos.map((todo) => <TodoRow key={todo.id} todo={todo} onPress={onSelect} />)}</ul>",
    "<ul>{todos.map((todo) => <TodoRow key={todo.id} active={todo.id === highlight} />)}</ul>",
    "<ul>{todos.map((todo) => <TodoRow key={todo.id} title={title$.get()} />)}</ul>",
    "<List>{todos.map((todo) => <TodoRow key={todo.id} todo={todo} />)}</List>",
    "<ul>{todos.length}{todos.map((todo) => <TodoRow key={todo.id} todo={todo} />)}</ul>",
    "<ul>{todos.filter(Boolean).map((todo) => <TodoRow key={todo.id} todo={todo} />)}</ul>",
  ]) {
    assert.deepEqual(forFindings(body, "const title$ = observable('');"), [], body);
  }
});

test("keeps a plain array mapped into rows", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import { useValue } from "@legendapp/state/react";
    export function Todos({ todos }) {
      const items = useValue(() => todos);
      return <ul>{items.map((todo) => <TodoRow key={todo.id} todo={todo} />)}</ul>;
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.equal(
    findings.some((finding) => finding.action === "render-list-with-for"),
    false,
  );
});

function keyPractices(source: string): ReturnType<typeof analyzeLegendPractices> {
  return analyzeLegendPractices({ sourceText: source, fileName: "fixture.tsx" }).filter(
    (finding) => finding.action === "use-peek-for-snapshot",
  );
}

test("asks to read a row key with peek inside an observer or a For child", () => {
  for (const render of [
    "export const Todos = observer(function Todos() { return <ul>{todos$.map((todo$) => <TodoRow key={todo$.id.get()} todo$={todo$} />)}</ul>; });",
    "export function Todos() { return <ul><For each={todos$}>{(todo$) => <TodoRow key={todo$.id.get()} todo$={todo$} />}</For></ul>; }",
  ]) {
    const [finding] = keyPractices(`
      import { observable } from "@legendapp/state";
      import { For, observer } from "@legendapp/state/react";
      const todos$ = observable([{ id: "a" }]);
      ${render}
    `);
    assert.equal(requireValue(finding).disposition, "candidate", render);
    assert.match(requireValue(finding).message, /`todo\$\.id\.peek\(\)`/u);
    assert.equal(requireValue(finding).edits?.[0]?.newText, "peek");
  }
});

test("leaves keys outside a tracking render and non-observable keys alone", () => {
  for (const render of [
    "export function Todos() { return <ul>{todos$.map((todo$) => <TodoRow key={todo$.id.get()} todo$={todo$} />)}</ul>; }",
    "export const Todos = observer(function Todos({ rows }) { return <ul>{rows.map((row) => <TodoRow key={row.get()} />)}</ul>; });",
    "export const Todos = observer(function Todos() { return <ul>{todos$.map((todo$) => <TodoRow key={todo$.id.peek()} todo$={todo$} />)}</ul>; });",
  ]) {
    const findings = keyPractices(`
      import { observable } from "@legendapp/state";
      import { observer } from "@legendapp/state/react";
      const todos$ = observable([{ id: "a" }]);
      ${render}
    `);
    assert.equal(
      findings.some((finding) => finding.message.includes("row key")),
      false,
      render,
    );
  }
});
