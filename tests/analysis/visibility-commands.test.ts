import { actions, requireValue } from "./harness.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

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
    ["use-observable"],
  );
});

test("migrates a coupled parent opener and its payload as one group", () => {
  const findings = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.name === "open")).action,
    "use-observable",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.name === "target")).action,
    "use-observable",
  );
});

test("isolates visibility when companion writes occur only while closing", () => {
  const findings = analyzeSource(
    `
    import { useState } from "react";
    function Dialog(_props: unknown) { return null; }
    export function Screen() {
      const [draft, setDraft] = useState("");
      const [open, setOpen] = useState(false);
      const reset = () => { setDraft(""); setOpen(false); };
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
        <Dialog draft={draft} open={open} setOpen={setOpen} onReset={reset} />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.name === "open")).action,
    "use-observable",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.name === "draft")).action,
    "review-state",
  );

  const nonVisibility = analyzeSource(
    `
    import { useState } from "react";
    function Control(_props: unknown) { return null; }
    export function Screen() {
      const [draft, setDraft] = useState("");
      const [active, setActive] = useState(false);
      const reset = () => { setDraft(""); setActive(false); };
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
        <button onClick={() => setActive(true)}>Activate</button>
        <Control draft={draft} active={active} onReset={reset} />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(nonVisibility.find((finding) => finding.name === "active")).action,
    "review-state",
  );
  assert.equal(
    requireValue(nonVisibility.find((finding) => finding.name === "draft")).action,
    "review-state",
  );
});

test("proves a controlled boolean forwards only guarded close companions", () => {
  const safe = analyzeSource(
    `
    import { useState } from "react";
    function Dialog(_props: unknown) { return null; }
    export function Screen() {
      const [draft, setDraft] = useState("");
      const [open, setOpen] = useState(false);
      const changeOpen = (nextOpen: boolean) => {
        if (!nextOpen) setDraft("");
        setOpen(nextOpen);
      };
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
        <button onClick={() => setOpen(true)}>Open</button>
        <Dialog draft={draft} open={open} onOpenChange={changeOpen} />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(safe.find((finding) => finding.name === "open")).action,
    "use-observable",
  );
  assert.equal(
    requireValue(safe.find((finding) => finding.name === "draft")).action,
    "review-state",
  );

  for (const unsafeChange of [
    `if (nextOpen) setDraft("next"); setOpen(nextOpen);`,
    `nextOpen = false; if (!nextOpen) setDraft(""); setOpen(nextOpen);`,
  ]) {
    const unsafe = analyzeSource(
      `
      import { useState } from "react";
      function Dialog(_props: unknown) { return null; }
      export function Screen() {
        const [draft, setDraft] = useState("");
        const [open, setOpen] = useState(false);
        const changeOpen = (nextOpen: boolean) => { ${unsafeChange} };
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <button onClick={() => setOpen(true)}>Open</button>
          <Dialog draft={draft} open={open} onOpenChange={changeOpen} />
        </main>;
      }
    `,
      "fixture.tsx",
    );
    assert.equal(
      requireValue(unsafe.find((finding) => finding.name === "open")).action,
      "review-state",
      unsafeChange,
    );
    assert.equal(
      requireValue(unsafe.find((finding) => finding.name === "draft")).action,
      "review-state",
      unsafeChange,
    );
  }
});

test("does not put a subscriber inside its own false visibility gate", () => {
  const findings = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  );
  const open = findings.find((finding) => finding.name === "open");
  assert.equal(requireValue(open).action, "review-state");
});

test("does not treat arbitrary direct setter props as independent child commands", () => {
  const findings = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.name === "open")).action,
    "review-state",
  );
});

test("migrates a helper-hidden companion update with the state it accompanies", () => {
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
    ["use-observable", "use-observable"],
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
    ["use-observable", "use-observable"],
  );
});

test("migrates an opened leaf and its coupled workflow transition as one group", () => {
  const findings = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  );
  const open = findings.find((finding) => finding.name === "open");
  const selection = findings.find((finding) => finding.name === "selection");
  assert.equal(requireValue(open).action, "use-observable");
  assert.equal(requireValue(selection).action, "use-observable");
});
