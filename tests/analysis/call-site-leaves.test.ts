import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("isolates direct primitive state at one stable call-site leaf", () => {
  const findings = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  );
  assert.deepEqual(
    findings
      .filter((finding) => ["visible", "mode", "page"].includes(finding.name ?? ""))
      .map((finding) => finding.action),
    ["use-observable", "use-observable", "use-observable"],
  );
});

test("isolates one unresolved JSX leaf without requiring its prop contract", () => {
  const findings = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  );
  assert.deepEqual(
    findings
      .filter((finding) => ["busy", "target"].includes(finding.name ?? ""))
      .map((finding) => finding.action),
    ["use-observable", "use-observable"],
  );
});

test("does not mistake unresolved boundaries for proof of leaf ownership", () => {
  const findings = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  );
  for (const name of ["open", "visible"]) {
    const matching = findings.filter((finding) => finding.name === name);
    assert.ok(matching.length > 0);
    const atomic = matching.find(
      (finding) => finding.message.includes("dirty") && finding.message.includes("visible"),
    );
    if (name === "open" || !atomic) {
      assert.ok(matching.every((finding) => finding.action !== "use-observable"));
    } else {
      // The dirty+visible pair is one atomic workflow: the grouped observable-model
      // Instruction migrates both members together instead of splitting the transaction.
      assert.equal(requireValue(atomic).action, "use-observable");
      assert.match(requireValue(atomic).message ?? "", /one owner-lifetime observable model/u);
    }
  }
});

test("does not treat a lazy or indirect initializer as a direct primitive", () => {
  const findings = analyzeSource(
    `
    import { useState } from "react";
    const Leaf = (props: { value: unknown }) => <output>{String(props.value)}</output>;
    export function Screen({ initial }: { initial: string }) {
      const [lazy, setLazy] = useState(() => true);
      const [indirect, setIndirect] = useState(initial);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <button onClick={() => setLazy(false)}>Lazy</button><Leaf value={lazy} />
        <button onClick={() => setIndirect("done")}>Indirect</button><Leaf value={indirect} /></main>;
    }
  `,
    "fixture.tsx",
  );
  for (const name of ["lazy", "indirect"]) {
    assert.notEqual(
      requireValue(findings.find((finding) => finding.name === name)).action,
      "use-observable",
    );
  }
});

test("does not wrap projections that span sibling call sites", () => {
  const [finding] = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "review-state");
});

test("does not promote a projection whose every write shares a reactive mutation lifecycle", () => {
  const [finding] = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "review-state");
});

test("does not promote a projection when its setter callback escapes through a custom hook", () => {
  const [finding] = analyzeSource(
    `
    import { useCallback, useState } from "react";
    export function Screen() {
      const [open, setOpen] = useState(false);
      useCommands({ onOpen: useCallback(() => setOpen(true), []) });
      ${"\n".repeat(100)}
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <Dialog open={open && enabled} onClose={() => setOpen(false)} />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "review-state");
});

test("reports unresolved ownership when state escapes through an opaque call", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Screen() {
      const [open, setOpen] = useState(false);
      inspect(open);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <button onClick={() => setOpen(true)}>Open</button><Dialog open={open} />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "review-state");
  assert.equal(requireValue(finding).abstentionReason, "ownership-flow-unresolved");
});

test("does not treat a namespace hook callback as an event command", () => {
  const [finding] = analyzeSource(
    `
    import React, { useState } from "react";
    function Dialog(props: { open: boolean; onClose: () => void }) { return null; }
    export function Screen() {
      const [open, setOpen] = useState(false);
      React.useMemo(() => { (() => setOpen(true))(); return []; }, []);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <Dialog open={open} onClose={() => setOpen(false)} />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "review-state");
});

test("keeps React state when the component is already a tiny render leaf", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Toggle() {
      const [active, setActive] = useState(false);
      return <button onClick={() => setActive(v => !v)}>{active ? "On" : "Off"}</button>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "keep-state");
  assert.equal(requireValue(finding).disposition, "keep");
});
