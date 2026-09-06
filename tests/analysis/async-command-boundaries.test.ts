import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("isolates async status after non-mutating validation guards", () => {
  const [finding] = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /async completion boundary/u);
});

test("isolates async status after bounded synchronous command preparation", () => {
  const [finding] = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /async completion boundary/u);
});

test("allows an event-rooted reset-only helper beside one async activation", () => {
  const [finding] = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
});

test("recognizes an async command selected by a JSX event conditional", () => {
  const [finding] = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /async completion boundary/u);
});

test("does not treat a callback used as an event condition as the selected handler", () => {
  const [finding] = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  );
  assert.doesNotMatch(requireValue(finding).message ?? "", /async pending flag/u);
});

test("does not hide a synchronous companion write inside a Promise-chain argument", () => {
  const [finding] = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  );
  assert.doesNotMatch(requireValue(finding).message ?? "", /async pending flag/u);
});

test("does not isolate a Promise-chain status before later synchronous owner work", () => {
  const finding = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.name === "saving");
  assert.doesNotMatch(requireValue(finding).message ?? "", /async pending flag/u);
});

test("does not isolate prepared async status when owner state can update before suspension", () => {
  const findings = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  );
  for (const finding of findings.filter((candidate) => candidate.name === "saving")) {
    assert.doesNotMatch(finding.message, /async pending flag/u);
  }
});

test("does not cross an early exit or scheduled reset to prove async status", () => {
  const findings = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  );
  for (const finding of findings.filter((candidate) => candidate.name === "saving")) {
    assert.doesNotMatch(finding.message, /async pending flag/u);
  }
});
