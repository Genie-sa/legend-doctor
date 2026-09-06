import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("accepts a literal reset effect when a controlled input proves independent editing", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function Form({ open }: { open: boolean }) {
      const [value, setValue] = useState("");
      useEffect(() => { if (open) setValue(""); }, [open]);
      return <main><Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation /><input value={value} onChange={setValue} /></main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.name === "value")).action,
    "use-observable",
  );
});

test("does not treat an opaque setter prop as a draft edit path", () => {
  for (const setterProp of ["register", "onClick"]) {
    const findings = analyzeSource(
      `
      import { useEffect, useState } from "react";
      export function Form({ source }: { source: string }) {
        const [value, setValue] = useState(source);
        useEffect(() => { setValue(source); }, [source]);
        return <main><Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation /><Field value={value} ${setterProp}={setValue} /></main>;
      }
    `,
      "fixture.tsx",
    );
    assert.notEqual(
      requireValue(findings.find((finding) => finding.name === "value")).action,
      "use-observable",
    );
  }
});

test("keeps owner rerenders when a memoized draft projection feeds another lifecycle hook", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useMemo, useState } from "react";
    export function Editor({ saved }: { saved: string }) {
      const [value, setValue] = useState(saved);
      useEffect(() => { setValue(saved); }, [saved]);
      const payload = useMemo(() => ({ value }), [value]);
      useEffect(() => { persist(payload); }, [payload]);
      return <main><Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation /><input value={value} onChange={setValue} /></main>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(
    requireValue(findings.find((finding) => finding.name === "value")).action,
    "use-observable",
  );
});

test("rejects draft reads and dead member edits that do not originate in UI events", () => {
  const findings = analyzeSource(
    `
    import { useCallback, useEffect, useState } from "react";
    export function Editor({ saved }: { saved: string }) {
      const [first, setFirst] = useState(saved);
      const [second, setSecond] = useState(saved);
      useEffect(() => { setFirst(saved); setSecond(saved); }, [saved]);
      const synchronize = useCallback(() => send(first), [first]);
      useEffect(synchronize, [synchronize]);
      const never = () => setSecond("edit");
      return <main><Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation /><input value={first} onChange={setFirst} /><p>{second}</p></main>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(
    requireValue(findings.find((finding) => finding.name === "first")).action,
    "use-observable",
  );
  assert.notEqual(
    requireValue(findings.find((finding) => finding.name === "second")).action,
    "use-observable",
  );
});

test("rejects partial, asynchronous, cleanup, and derived effect sinks", () => {
  const snippets = [
    `useEffect(() => { setValue(source); setOther(false); }, [source]);`,
    `useEffect(() => { const timer = setTimeout(() => setValue(source), 1); return () => clearTimeout(timer); }, [source]);`,
    `useEffect(() => { setValue(previous => source); }, [source]);`,
    `useEffect(() => { setValue(source); }, [source]);`,
  ];
  for (const [index, effect] of snippets.entries()) {
    const editable = index === 3 ? "" : `<button onClick={() => setValue("edit")} />`;
    const findings = analyzeSource(
      `
      import { useEffect, useState } from "react";
      export function Form({ source }: { source: string }) {
        const [value, setValue] = useState(source);
        const [other, setOther] = useState(false);
        ${effect}
        return <main><Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation /><p>{value}</p>${editable}</main>;
      }
    `,
      "fixture.tsx",
    );
    const value = requireValue(findings.find((finding) => finding.name === "value"));
    assert.doesNotMatch(value.message, /synchronization effect/u);
    if (index === 0 || index === 3) {
      assert.notEqual(value.action, "use-observable");
    }
  }
});

test("does not mistake a JSX callback invocation for an owner render read", () => {
  const [finding] = analyzeSource(
    `
    import { useCallback, useState } from "react";
    export function Form() {
      const [busy, setBusy] = useState(false);
      const canSubmit = useCallback(() => !busy, [busy]);
      return <Panel renderFooter={() => <Button disabled={!canSubmit()} onClick={() => setBusy(true)} />} />;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(requireValue(finding).action, "use-ref");
});
