import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("keeps async status ownership above a state-independent conditional leaf", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Form({ existing }: { existing: boolean }) {
      const [saving, setSaving] = useState(false);
      async function save() {
        setSaving(true);
        try { await persist(); } finally { setSaving(false); }
      }
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        {existing ? <button disabled={saving} onClick={save}>Save</button> : <CreateButton />}
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /async completion boundary/u);
});

test("does not isolate async status when another owner update starts the command", () => {
  const findings = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  );
  assert.notEqual(
    requireValue(findings.find((finding) => finding.name === "saving")).action,
    "use-observable",
  );
});

test("does not isolate async status owned by a reactive mutation", () => {
  const findings = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  );
  for (const finding of findings.filter((candidate) => candidate.name === "saving")) {
    assert.notEqual(finding.action, "use-observable");
  }
});

test("keeps a proven independent UI transition beside a reactive mutation path", () => {
  const [finding] = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
});

test("does not isolate async status from a scheduled callback or nonliteral write", () => {
  for (const command of [
    `setTimeout(async () => { setSaving(true); await persist(); setSaving(false); }, 0);`,
    `async function save() { setSaving(next); await persist(); setSaving(false); }`,
  ]) {
    const [finding] = analyzeSource(
      `
      import { useState } from "react";
      function LoadingButton(props: { loading: boolean }) { return <button>{String(props.loading)}</button>; }
      export function Form({ next = true }: { next?: boolean }) {
        const [saving, setSaving] = useState(false);
        ${command}
        return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
          <LoadingButton loading={saving} />
        </main>;
      }
    `,
      "fixture.tsx",
    );
    assert.doesNotMatch(requireValue(finding).message ?? "", /async pending flag/u);
  }
});

test("isolates broad async status fanout but keeps a cohesive form in React", () => {
  const findings = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  );
  const saving = findings.filter((candidate) => candidate.name === "saving");
  assert.notEqual(requireValue(saving[0]).action, "use-observable");
  assert.equal(requireValue(saving[1]).action, "use-observable");
  assert.match(requireValue(saving[1]).message ?? "", /two stable status call sites/u);
});

test("keeps exact async status in React when the owner is already the status leaf", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function SaveButton() {
      const [saving, setSaving] = useState(false);
      async function save() {
        setSaving(true);
        try { await persist(); } finally { setSaving(false); }
      }
      return <button disabled={saving} onClick={save}>Save</button>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "keep-state");
  assert.match(requireValue(finding).message ?? "", /cohesive owner boundary/u);
});

test("keeps delayed async status in its cohesive button owner", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function FilledButton({ onClick }: { onClick: () => Promise<void> }) {
      const [loading, setLoading] = useState(false);
      const click = async () => {
        const pending = onClick();
        const timer = window.setTimeout(() => setLoading(true), 50);
        try {
          await pending;
        } finally {
          clearTimeout(timer);
          setLoading(false);
        }
      };
      const status = loading ? "loading" : "idle";
      return <button onClick={click}><span /><span /><span /><span>{status}</span></button>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "keep-state");
  assert.match(requireValue(finding).message ?? "", /delays the pending transition/u);
});

test("keeps unsafe delayed pending shapes under review", () => {
  for (const [scheduled, cleanup] of [
    [`() => { audit(); setLoading(true); }`, `clearTimeout(timer); setLoading(false);`],
    [`() => setLoading(true)`, `setLoading(false);`],
  ]) {
    const [finding] = analyzeSource(
      `
      import { useState } from "react";
      export function FilledButton({ onClick }: { onClick: () => Promise<void> }) {
        const [loading, setLoading] = useState(false);
        const click = async () => {
          const pending = onClick();
          const timer = window.setTimeout(${scheduled}, 50);
          try { await pending; } finally { ${cleanup} }
        };
        const status = loading ? "loading" : "idle";
        return <button onClick={click}><span /><span /><span /><span>{status}</span></button>;
      }
    `,
      "fixture.tsx",
    );
    assert.equal(requireValue(finding).action, "review-state");
  }
});

test("isolates async status in a compact owner with an independent render cut", () => {
  const [finding] = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /independent owner content/u);
});
