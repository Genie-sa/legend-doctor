import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("isolates an async pending flag at one stable leaf without changing its completion boundary", () => {
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

test("keeps async status label projections inside the same subscribed leaf", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Form() {
      const [saving, setSaving] = useState(false);
      async function save() {
        setSaving(true);
        try { await persist(); } finally { setSaving(false); }
      }
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <button disabled={saving} onClick={save}>
          {saving ? translate("Saving") : translate("Save")}
        </button>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /stable pending-control call site/u);
});

test("isolates a direct async status projection in one stable call site", () => {
  const finding = analyzeSource(
    `
    import { useState } from "react";
    export function Scanner({ queueFull }: { queueFull: boolean }) {
      const [files, setFiles] = useState(["receipt"]);
      const [encoding, setEncoding] = useState(false);
      async function scan() {
        if (files.length === 0) return;
        setEncoding(true);
        try { await encode(); setFiles([]); } finally { setEncoding(false); }
      }
      return <main><Header /><Toolbar /><Summary /><Files /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        {files.length > 0 && <button disabled={encoding || queueFull} onClick={scan}>Scan</button>}
      </main>;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.name === "encoding");
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /async pending flag/u);
  assert.match(requireValue(finding).message ?? "", /pending-control call site/u);
});

test("keeps a pure conditional status label inside the direct async leaf", () => {
  const findings = analyzeSource(
    `
    import { useState } from "react";
    export function Copier({ destination }: { destination: string | null }) {
      const [copying, setCopying] = useState(false);
      async function copy() {
        if (!destination) return;
        setCopying(true);
        try { await duplicate(destination); } finally { setCopying(false); }
      }
      return <main><Header /><Toolbar /><Summary /><Options /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <button disabled={!destination || copying} onClick={copy}>
          {copying ? \`\${translate("Copying")}...\` : translate("Copy")}
        </button>
      </main>;
    }
    export function MountGate() {
      const [copying, setCopying] = useState(false);
      async function copy() {
        setCopying(true);
        try { await duplicate(); } finally { setCopying(false); }
      }
      return <main><Header /><Toolbar /><Summary /><Options /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <button onClick={copy}>Copy</button>
        {copying && <Button disabled={copying}>Copying...</Button>}
      </main>;
    }
    export function ConditionalWork({ enabled }: { enabled: boolean }) {
      const [copying, setCopying] = useState(false);
      async function copy() {
        setCopying(true);
        try {
          if (enabled) await duplicate();
        } finally {
          setCopying(false);
        }
      }
      return <main><Header /><Toolbar /><Summary /><Options /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <Button disabled={!enabled || copying} onClick={copy}>
          {copying ? \`\${translate("Copying")}...\` : translate("Copy")}
        </Button>
      </main>;
    }
  `,
    "fixture.tsx",
  ).filter((candidate) => candidate.name === "copying");
  assert.equal(requireValue(findings[0]).action, "use-observable");
  assert.match(requireValue(findings[0]).message ?? "", /async pending flag/u);
  assert.notEqual(requireValue(findings[1]).action, "use-observable");
  assert.notEqual(requireValue(findings[2]).action, "use-observable");
});

test("requires one pure non-gating call site for a direct async status projection", () => {
  const sources = [
    `{encoding && <Button disabled={encoding} onClick={scan}>Scan</Button>}`,
    `<><Button disabled={encoding || queueFull} onClick={scan}>Scan</Button><Status>{String(encoding)}</Status></>`,
    `<Button disabled={audit(encoding)} onClick={scan}>Scan</Button>`,
    `{rows.map(row => <Button key={row.id} disabled={encoding || row.disabled} onClick={scan}>Scan</Button>)}`,
  ];
  for (const render of sources) {
    const [finding] = analyzeSource(
      `
      import { useState } from "react";
      export function Scanner({ queueFull, rows }: { queueFull: boolean; rows: Array<{ id: string; disabled: boolean }> }) {
        const [encoding, setEncoding] = useState(false);
        async function scan() {
          setEncoding(true);
          try { await encode(); } finally { setEncoding(false); }
        }
        return <main><Header /><Toolbar /><Summary /><Files /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
          ${render}
        </main>;
      }
    `,
      "fixture.tsx",
    );
    assert.doesNotMatch(requireValue(finding).message ?? "", /async pending flag/u);
  }
});

test("does not fold unsafe or external async status projections into a leaf", () => {
  const findings = analyzeSource(
    `
    import { useState } from "react";
    export function UnsafeCondition() {
      const [saving, setSaving] = useState(false);
      async function save() { setSaving(true); await persist(); setSaving(false); }
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <Button loading={saving} onClick={save}>{track(saving) ? "Saving" : "Save"}</Button>
      </main>;
    }
    export function SiblingRead() {
      const [saving, setSaving] = useState(false);
      async function save() { setSaving(true); await persist(); setSaving(false); }
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <Button loading={saving} onClick={save} /><output>{saving ? "Saving" : "Save"}</output>
      </main>;
    }
    export function SelfGate() {
      const [saving, setSaving] = useState(false);
      async function save() { setSaving(true); await persist(); setSaving(false); }
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <button onClick={save}>Save</button>{saving && <Button loading={saving} />}
      </main>;
    }
  `,
    "fixture.tsx",
  );
  for (const finding of findings.filter((candidate) => candidate.name === "saving")) {
    assert.notEqual(finding.action, "use-observable");
  }
});
