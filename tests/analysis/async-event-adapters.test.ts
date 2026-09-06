import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("traces an async pending command through an event-rooted submit helper", () => {
  const [finding] = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
});

test("traces async pending state through a direct JSX event adapter", () => {
  const findings = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  ).filter((finding) => finding.name === "saving");
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["use-observable", "use-observable", "use-observable"],
  );
});

test("traces an async pending helper through a proven React Hook Form event adapter", () => {
  const [finding] = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /async completion boundary/u);
});

test("does not treat deferred or non-event callback adapters as event roots", () => {
  const findings = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  ).filter((finding) => finding.name === "saving");
  for (const finding of findings) {
    assert.doesNotMatch(finding.message, /async pending flag/u);
  }
});

test("isolates a Promise-chain status rendered through one reachable JSX callback leaf", () => {
  const [finding] = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /async completion boundary/u);
});

test("requires a Promise-chain leaf alias to be live, unique, and non-repeated", () => {
  for (const render of [
    `const picker = <LoadingButton loading={reading} />; return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />{picker}{picker}</main>;`,
    `const picker = <LoadingButton loading={reading} />; return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions /></main>;`,
    `return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />{rows.map(row => <LoadingButton key={row.id} loading={reading} />)}</main>;`,
  ]) {
    const [finding] = analyzeSource(
      `
      import { useState } from "react";
      export function Importer({ rows }: { rows: Array<{ id: string }> }) {
        const [reading, setReading] = useState(false);
        function read() {
          setReading(true);
          loadFile().finally(() => setReading(false));
        }
        ${render}
      }
    `,
      "fixture.tsx",
    );
    assert.doesNotMatch(requireValue(finding).message ?? "", /async pending flag/u);
  }
});

test("does not flatten timers or unrelated Promise continuations into one async command", () => {
  const findings = analyzeSource(
    `
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
  `,
    "fixture.tsx",
  );
  for (const finding of findings.filter((candidate) => candidate.name === "reading")) {
    assert.doesNotMatch(finding.message, /async pending flag/u);
  }
});
