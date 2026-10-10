import type { LegendPracticeFinding } from "../../src/core/types.js";
import assert from "node:assert/strict";
import { practiceFindings } from "./edit-assertions.js";
import { requireValue } from "./harness.js";
import test from "node:test";

const fixture = (body: string): string => `
import { observable } from "@legendapp/state";
import type { Observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";
import { useMemo } from "react";
interface Todo { done: boolean; title: string }
const ui$ = observable({ label: "main", width: 0, settings: { dense: false } });
const todos$ = observable<Todo[]>([]);
const byId$ = observable<Record<string, Todo>>({});
const flag$ = observable<boolean>(false);
const LAYOUTS = { narrow: { columns: 1 }, wide: { columns: 2 } };
${body}
`;

const findings = (source: string): LegendPracticeFinding[] =>
  practiceFindings(source, "select-stable-selector-result");

const panel = (selector: string, rest = ""): string =>
  fixture(`export function Panel() {
  const layout = useValue(${selector});
  ${rest}
  return <output>{String(layout)}</output>;
}`);

test("asks about a fresh object whose tracked path reaches it only through a comparison", () => {
  const finding = requireValue(
    findings(panel(`() => ({ label: ui$.label.get(), wide: ui$.width.get() > 800 })`))[0],
  );
  assert.equal(finding.disposition, "candidate");
  assert.equal(finding.confidence, "probable");
  assert.equal(finding.practice, "reactivity");
  assert.equal(finding.location.line, 13);
  assert.match(
    finding.message,
    /so `Panel` re-renders on every `ui\$\.width` change, even when the comparisons that read it keep their outcome/u,
  );
  assert.match(finding.evidence.join("\n"), /no shallow or custom equality option/u);
});

test("follows const locals, conditions, and unread tracked paths in a block selector", () => {
  const branches = findings(
    panel(`() => {
    const width = ui$.width.get();
    if (width > 1200) {
      return { size: "large" };
    }
    return { size: width > 800 ? "medium" : "small" };
  }`),
  );
  assert.equal(branches[0]?.disposition, "candidate");
  const unread = findings(
    panel(`() => { const width = ui$.width.get(); return [ui$.label.get()]; }`),
  );
  assert.equal(unread[0]?.disposition, "candidate");
});

test("asks about a hook whose selector compares inside a callback", () => {
  const finding = requireValue(
    findings(
      fixture(`export function useBreakpoint(viewport$: Observable<{ width: number }>, widths: number[]) {
  return useValue(() => {
    const width = viewport$.width.get();
    const active = widths.find((bp) => width >= bp);
    return { active: active ?? 0 };
  });
}`),
    )[0],
  );
  assert.match(
    finding.message,
    /`useBreakpoint` re-renders its caller on every `viewport\$\.width` change/u,
  );
});

test("asks whether a change to a derived array can leave the rendered items the same", () => {
  const filtered = requireValue(
    findings(panel(`() => todos$.get().filter((todo) => todo.done)`))[0],
  );
  assert.equal(filtered.disposition, "candidate");
  assert.match(
    filtered.message,
    /`filter` returns a new array on every run, so `Panel` re-renders on every `todos\$` change/u,
  );
  assert.match(filtered.message, /<For each=\{todos\$\}>/u);
  assert.equal(findings(panel(`() => Object.keys(byId$.get())`))[0]?.disposition, "candidate");
  assert.deepEqual(findings(panel(`() => todos$.get().find((todo) => todo.done)`)), []);
});

test("reports nothing for a primitive or an existing observable child value", () => {
  assert.deepEqual(findings(panel(`() => ui$.width.get() > 800`)), []);
  assert.deepEqual(findings(panel(`() => ui$.settings.get()`)), []);
  assert.deepEqual(findings(panel(`() => todos$.get()`)), []);
});

test("reports nothing for a fresh object of raw reads, where every change changes a field", () => {
  assert.deepEqual(
    findings(panel(`() => ({ label: ui$.label.get(), width: ui$.width.get() })`)),
    [],
  );
});

test("reports nothing when only one branch returns a fresh value", () => {
  assert.deepEqual(findings(panel(`() => (ui$.width.get() > 800 ? { wide: true } : null)`)), []);
  assert.deepEqual(
    findings(panel(`() => { if (ui$.width.get() > 800) { return { wide: true }; } }`)),
    [],
  );
});

test("reports nothing for stable or memoized values selected by a comparison", () => {
  assert.deepEqual(findings(panel(`() => LAYOUTS[ui$.width.get() > 800 ? "wide" : "narrow"]`)), []);
  assert.deepEqual(
    findings(
      fixture(`export function Panel() {
  const fallback = useMemo(() => ({ wide: false }), []);
  const layout = useValue(() => (ui$.width.get() > 800 ? fallback : fallback));
  return <output>{String(layout)}</output>;
}`),
    ),
    [],
  );
});

test("reports nothing for $-named values that are not proven observables", () => {
  assert.deepEqual(
    findings(
      fixture(`const fake$ = { width: { get: () => 5 }, items: { get: () => [1, 2] } };
export function Panel() {
  const layout = useValue(() => ({ wide: fake$.width.get() > 3 }));
  const items = useValue(() => fake$.items.get().filter((item) => item > 1));
  return <output>{String(layout)}{items.length}</output>;
}`),
    ),
    [],
  );
});

test("reports nothing for a two-valued observable, where every change flips the comparison", () => {
  assert.deepEqual(findings(panel(`() => ({ closed: !flag$.get() })`)), []);
});

test("reports nothing when another subscription re-renders the owner on the same change", () => {
  assert.deepEqual(
    findings(
      panel(`() => ({ wide: ui$.width.get() > 800 })`, "const width = useValue(ui$.width);"),
    ),
    [],
  );
});

test("reports nothing when a selector passes options or reads an untracked value", () => {
  assert.deepEqual(
    findings(panel(`() => ({ wide: ui$.width.get() > 800 }), { suspense: true }`)),
    [],
  );
  assert.deepEqual(findings(panel(`() => ({ wide: ui$.width.peek() > 800 })`)), []);
});

test("reports the deprecated aliases, which share useValue's comparison", () => {
  const source = panel(`() => ({ wide: ui$.width.get() > 800 })`)
    .replace("{ useValue }", "{ useSelector }")
    .replace("useValue(() =>", "useSelector(() =>");
  assert.equal(findings(source)[0]?.disposition, "candidate");
});
