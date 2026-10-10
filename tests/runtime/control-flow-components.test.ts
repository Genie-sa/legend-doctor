import { For, Show, Switch, useValue } from "@legendapp/state/react";
import type { ReactElement, ReactNode, RefObject } from "react";
import { act, createRef, createElement as jsx, useState } from "react";
import { count, mountDom } from "../../src/runtime/dom.js";
import type { Observable } from "@legendapp/state";
import assert from "node:assert/strict";
import { observable } from "@legendapp/state";
import test from "node:test";

type Tab = "posts" | "media" | "likes";

interface Probe {
  readonly mounts: { next: number };
  readonly renders: Map<string, number>;
}

/** Mounts each compared version in its own subtest, so one DOM never outlives the other's teardown. */
async function inSubtest<Result>(
  context: test.TestContext,
  name: string,
  run: (subtest: test.TestContext) => Promise<Result>,
): Promise<Result> {
  const results: Result[] = [];
  await context.test(name, async (subtest) => {
    results.push(await run(subtest));
  });
  const [result] = results;
  assert.ok(result !== undefined);
  return result;
}

function newProbe(): Probe {
  return { mounts: { next: 0 }, renders: new Map() };
}

function Child({ label, probe }: { label: string; probe: Probe }): ReactElement {
  const [mount] = useState(() => {
    probe.mounts.next += 1;
    return probe.mounts.next;
  });
  return jsx("output", { "data-label": label }, `${label}:${mount}`);
}

function Other({ probe }: { probe: Probe }): ReactElement {
  count(probe.renders, "other");
  return jsx("aside", null, "other");
}

type Branches = (open: boolean, probe: Probe) => ReactNode;

const SAME_TYPE: Branches = (open, probe) => jsx(Child, { label: open ? "open" : "closed", probe });

const DISTINCT_TYPES: Branches = (open, probe) =>
  open ? jsx(Child, { label: "open", probe }) : jsx(Other, { probe });

function Gate({ branches, open$, probe }: GateProps): ReactNode {
  return branches(useValue(open$), probe);
}

interface GateProps {
  readonly branches: Branches;
  readonly open$: Observable<boolean>;
  readonly probe: Probe;
}

function GateOwner(props: GateProps): ReactElement {
  count(props.probe.renders, "owner");
  return jsx("main", null, jsx(Gate, props));
}

function ShowOwner({ branches, open$, probe }: GateProps): ReactElement {
  count(probe.renders, "owner");
  return jsx(
    "main",
    null,
    jsx(Show, {
      children: () => {
        count(probe.renders, "child function");
        return branches(true, probe);
      },
      else: () => branches(false, probe),
      if: open$,
    }),
  );
}

async function toggleTwice(
  context: test.TestContext,
  owner: typeof GateOwner,
  branches: Branches,
): Promise<{ readonly probe: Probe; readonly texts: readonly string[] }> {
  const ui = mountDom(context, false);
  const probe = newProbe();
  const open$ = observable(false);
  const texts: string[] = [];
  await ui.render(jsx(owner, { branches, open$, probe }));
  texts.push(ui.element("main").textContent ?? "");
  probe.renders.clear();
  await act(() => open$.set(true));
  texts.push(ui.element("main").textContent ?? "");
  await act(() => open$.set(false));
  texts.push(ui.element("main").textContent ?? "");
  return { probe, texts };
}

for (const branches of [SAME_TYPE, DISTINCT_TYPES]) {
  const name = branches === SAME_TYPE ? "same-type" : "distinct";
  test(`Show keeps the gate leaf's ${name} branch mounts across toggles`, async (context) => {
    const gate = await inSubtest(context, "gate leaf", (subtest) =>
      toggleTwice(subtest, GateOwner, branches),
    );
    const show = await inSubtest(context, "Show", (subtest) =>
      toggleTwice(subtest, ShowOwner, branches),
    );
    assert.deepEqual(show.texts, gate.texts);
    assert.equal(show.probe.renders.get("owner"), undefined, "the owner never re-renders");
  });
}

test("Show calls its child function only while the condition holds", async (context) => {
  const ui = mountDom(context, false);
  const probe = newProbe();
  const open$ = observable(false);
  await ui.render(jsx(ShowOwner, { branches: DISTINCT_TYPES, open$, probe }));
  assert.equal(probe.renders.get("child function"), undefined);
  await act(() => open$.set(true));
  assert.equal(probe.renders.get("child function"), 1);
});

interface CapturingProps {
  readonly open$: Observable<boolean>;
  readonly setter: RefObject<((label: string) => void) | null>;
}

function CapturingShowOwner({ open$, setter }: CapturingProps): ReactElement {
  const [label, update] = useState("first");
  setter.current = update;
  return jsx("main", null, jsx(Show, { children: () => label, if: open$ }));
}

test("Show re-renders with its owner, so a captured owner value stays current", async (context) => {
  const ui = mountDom(context, false);
  const setter = createRef<(label: string) => void>();
  await ui.render(jsx(CapturingShowOwner, { open$: observable(true), setter }));
  await act(() => setter.current?.("second"));
  assert.equal(ui.element("main").textContent, "second");
});

function TernaryChain({ probe, tab }: { probe: Probe; tab: Tab }): ReactNode {
  if (tab === "posts") {
    return jsx(Child, { label: "posts", probe });
  }
  return tab === "media" ? jsx(Child, { label: "media", probe }) : jsx(Other, { probe });
}

interface TabSwitchProps {
  readonly children: Partial<Record<Tab | "default", () => ReactNode>>;
  readonly value: Observable<Tab>;
}

const TabSwitch: (props: TabSwitchProps) => ReactElement | null = Switch;

function SwitchGate({ probe, tab$ }: { probe: Probe; tab$: Observable<Tab> }): ReactElement {
  return jsx(
    "main",
    null,
    jsx(TabSwitch, {
      children: {
        default: () => jsx(Other, { probe }),
        media: () => jsx(Child, { label: "media", probe }),
        posts: () => jsx(Child, { label: "posts", probe }),
      },
      value: tab$,
    }),
  );
}

function ChainGate({ probe, tab$ }: { probe: Probe; tab$: Observable<Tab> }): ReactElement {
  return jsx("main", null, jsx(TernaryChain, { probe, tab: useValue(tab$) }));
}

async function walkTabs(
  context: test.TestContext,
  owner: typeof SwitchGate,
): Promise<readonly string[]> {
  const ui = mountDom(context, false);
  const probe = newProbe();
  const tab$ = observable<Tab>("posts");
  const texts = [];
  await ui.render(jsx(owner, { probe, tab$ }));
  for (const tab of ["media", "likes", "posts"] as const) {
    texts.push(ui.element("main").textContent ?? "");
    await act(() => tab$.set(tab));
  }
  texts.push(ui.element("main").textContent ?? "");
  return texts;
}

test("Switch with a default arm renders and mounts like the ternary chain", async (context) => {
  const switched = await inSubtest(context, "Switch", (subtest) => walkTabs(subtest, SwitchGate));
  const chained = await inSubtest(context, "ternary chain", (subtest) =>
    walkTabs(subtest, ChainGate),
  );
  assert.deepEqual(switched, chained);
});

interface Item {
  readonly id: string;
  readonly title: string;
}

interface ListProps {
  readonly items$: Observable<Item[]>;
  readonly probe: Probe;
}

function Row({ item, probe }: { item: Item; probe: Probe }): ReactElement {
  count(probe.renders, `row ${item.id}`);
  return jsx(Child, { label: item.title, probe });
}

function MappedList({ items$, probe }: ListProps): ReactElement {
  count(probe.renders, "owner");
  const items = useValue(items$);
  return jsx(
    "ul",
    null,
    items.map((item) => jsx(Row, { item, key: item.id, probe })),
  );
}

function ForList({ items$, probe }: ListProps): ReactElement {
  count(probe.renders, "owner");
  return jsx(
    "ul",
    null,
    jsx(For<Item, object>, {
      children: (item$: Observable<Item>) => jsx(Row, { item: item$.get(), probe }),
      each: items$,
    }),
  );
}

async function editList(
  context: test.TestContext,
  owner: typeof ForList,
): Promise<{ readonly probe: Probe; readonly texts: readonly string[] }> {
  const ui = mountDom(context, false);
  const probe = newProbe();
  const items$ = observable<Item[]>([
    { id: "a", title: "A" },
    { id: "b", title: "B" },
  ]);
  const texts = [];
  await ui.render(jsx(owner, { items$, probe }));
  probe.renders.clear();
  await act(() => items$[1]!.title.set("B2"));
  texts.push(ui.element("ul").textContent ?? "");
  await act(() => items$.set([items$[1]!.peek(), items$[0]!.peek()]));
  texts.push(ui.element("ul").textContent ?? "");
  await act(() => items$.push({ id: "c", title: "C" }));
  texts.push(ui.element("ul").textContent ?? "");
  return { probe, texts };
}

test("For keyed by id renders and mounts rows like the keyed map", async (context) => {
  const mapped = await inSubtest(context, "keyed map", (subtest) => editList(subtest, MappedList));
  const forList = await inSubtest(context, "For", (subtest) => editList(subtest, ForList));
  assert.deepEqual(forList.texts, mapped.texts);
  assert.ok((mapped.probe.renders.get("owner") ?? 0) > 0);
  assert.equal(forList.probe.renders.get("owner"), undefined, "the owner never re-renders");
});

test("For rerenders only the row whose item changed", async (context) => {
  const ui = mountDom(context, false);
  const probe = newProbe();
  const items$ = observable<Item[]>([
    { id: "a", title: "A" },
    { id: "b", title: "B" },
  ]);
  await ui.render(jsx(ForList, { items$, probe }));
  probe.renders.clear();
  await act(() => items$[1]!.title.set("B2"));
  assert.equal(probe.renders.get("row a"), undefined);
  assert.equal(probe.renders.get("row b"), 1);
});

function CapturingForList({ items$, setter }: CapturingListProps): ReactElement {
  const [suffix, update] = useState("first");
  setter.current = update;
  return jsx(
    "ul",
    null,
    jsx(For<Item, object>, {
      children: (item$: Observable<Item>) => jsx("li", null, `${item$.title.get()}:${suffix}`),
      each: items$,
    }),
  );
}

interface CapturingListProps {
  readonly items$: Observable<Item[]>;
  readonly setter: RefObject<((suffix: string) => void) | null>;
}

test("For rows keep an owner value captured on their first render", async (context) => {
  const ui = mountDom(context, false);
  const setter = createRef<(suffix: string) => void>();
  const items$ = observable<Item[]>([{ id: "a", title: "A" }]);
  await ui.render(jsx(CapturingForList, { items$, setter }));
  await act(() => setter.current?.("second"));
  assert.equal(ui.element("ul").textContent, "A:first");
});
