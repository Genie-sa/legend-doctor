import { agentFindings } from "../../src/report/format.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("groups a co-written dialog payload and visibility flag into one observable model", () => {
  const findings = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  );
  const grouped = findings.filter((finding) => finding.group);
  assert.deepEqual(
    grouped.map((finding) => finding.action),
    ["use-observable", "use-observable"],
  );
  assert.deepEqual(requireValue(requireValue(grouped[0]).group).members, ["target", "open"]);
  assert.equal(agentFindings(findings).filter((finding) => finding.group).length, 1);
});

test("groups a persistent dialog model behind one bounded payload gate", () => {
  const grouped = analyzeSource(
    `
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
        {target ? <ItemDialog target={target} open={open} onOpenChange={setOpen} onShow={show} /> : null}
      </main>;
    }
  `,
    "fixture.tsx",
  ).filter((finding) => finding.group);
  assert.deepEqual(
    grouped.map((finding) => finding.action),
    ["use-observable", "use-observable"],
  );
  assert.deepEqual(requireValue(requireValue(grouped[0]).group).members, ["target", "open"]);
  assert.match(requireValue(grouped[0]).message ?? "", /stable leaf wrapper/u);

  const fanout = analyzeSource(
    `
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
        {target ? <ItemDialog target={target} open={open} onOpenChange={setOpen} onShow={show} /> : null}
        {target ? <Preview item={target} /> : null}
      </main>;
    }
  `,
    "fixture.tsx",
  ).filter((finding) => finding.group);
  assert.equal(fanout.length, 0);
});

test("groups a persistent dialog payload, visibility, and monotonic mount latch", () => {
  const source = (resetLatch: string): string => `
    import { lazy, useState } from "react";
    interface Item { id: string }
    const ItemDialog = lazy(() => import("./ItemDialog"));
    export function Screen({ item }: { item: Item }) {
      const [target, setTarget] = useState<Item | null>(null);
      const [open, setOpen] = useState(false);
      const [ready, setReady] = useState(false);
      const show = () => { setTarget(item); setReady(true); setOpen(true); };
      const close = () => { setOpen(false); setTarget(null); ${resetLatch} };
      ${"\n".repeat(100)}
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
        <Aside /><Help /><Status /><Actions /><Preview />
        {ready ? <ItemDialog target={target} open={open} onClose={close} /> : null}
      </main>;
    }
  `;
  const grouped = analyzeSource(source(""), "fixture.tsx").filter((finding) => finding.group);
  assert.deepEqual(
    grouped.map((finding) => finding.action),
    ["use-observable", "use-observable", "use-observable"],
  );
  assert.deepEqual(requireValue(requireValue(grouped[0]).group).members, [
    "target",
    "open",
    "ready",
  ]);
  assert.match(requireValue(grouped[0]).message ?? "", /persistent dialog state/u);

  const resetting = analyzeSource(source("setReady(false);"), "fixture.tsx");
  assert.equal(resetting.filter((finding) => finding.group).length, 0);
});

test("groups one bounded logical-and dialog gate without merging payload fanout", () => {
  const source = (extra: string): string => `
    import { useState } from "react";
    interface Item { id: string }
    function ItemDialog(_props: unknown) { return null; }
    export function Screen({ item }: { item: Item }) {
      const [open, setOpen] = useState(false);
      const [target, setTarget] = useState<Item | null>(null);
      const show = () => { setTarget(item); setOpen(true); };
      ${"\n".repeat(100)}
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
        <Aside /><Help /><Status /><Actions /><Preview />
        {target && <ItemDialog target={target} open={open} onOpenChange={setOpen} onShow={show} />}
        ${extra}
      </main>;
    }
  `;
  const grouped = analyzeSource(source(""), "fixture.tsx").filter((finding) => finding.group);
  assert.deepEqual(
    grouped.map((finding) => finding.action),
    ["use-observable", "use-observable"],
  );
  assert.deepEqual(requireValue(requireValue(grouped[0]).group).members, ["open", "target"]);

  const fanout = analyzeSource(source("{target && <Preview item={target} />}"), "fixture.tsx");
  assert.equal(fanout.filter((finding) => finding.group).length, 0);
});

test("groups a bounded multi-element dialog gate without wrapping a broad branch", () => {
  const source = (children: string): string => `
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
        {target && <ItemDialog target={target} open={open} onOpenChange={setOpen} onShow={show}>
          ${children}
        </ItemDialog>}
      </main>;
    }
  `;
  const bounded = analyzeSource(
    source("<One /><Two /><Three /><Four /><Five /><Six /><Seven />"),
    "fixture.tsx",
  );
  assert.deepEqual(
    bounded.filter((finding) => finding.group).map((finding) => finding.action),
    ["use-observable", "use-observable"],
  );

  const broad = analyzeSource(
    source(
      "<One /><Two /><Three /><Four /><Five /><Six /><Seven /><Eight /><Nine /><Ten /><Eleven /><Twelve /><Thirteen />",
    ),
    "fixture.tsx",
  );
  assert.equal(broad.filter((finding) => finding.group).length, 0);
});

test("groups an undefined-initialized dialog payload without accepting opaque initializers", () => {
  const source = (initializer: string): string => `
    import { useState } from "react";
    interface Item { id: string }
    function ItemDrawer(_props: unknown) { return null; }
    export function Screen({ item }: { item: Item }) {
      const [target, setTarget] = useState<Item | undefined>(${initializer});
      const [open, setOpen] = useState(false);
      const show = () => { setTarget(item); setOpen(true); };
      ${"\n".repeat(100)}
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
        <Aside /><Help /><Status /><Actions /><Preview />
        <ItemDrawer target={target} open={open} onOpenChange={setOpen} onShow={show} />
      </main>;
    }
  `;
  const grouped = analyzeSource(source(""), "fixture.tsx").filter((finding) => finding.group);
  assert.deepEqual(
    grouped.map((finding) => finding.action),
    ["use-observable", "use-observable"],
  );
  assert.deepEqual(requireValue(requireValue(grouped[0]).group).members, ["target", "open"]);

  const opaque = analyzeSource(source("loadInitialTarget()"), "fixture.tsx");
  assert.equal(opaque.filter((finding) => finding.group).length, 0);
});
