import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("migrates a complete effect-synchronized draft while preserving the effect", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function Profile({ initialName }: { initialName: string }) {
      const [name, setName] = useState(initialName);
      useEffect(() => { setName(initialName); }, [initialName]);
      return <main>
        <Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation /><Content />
        <input value={name} onChange={event => setName(event.target.value)} />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["use-observable", "review-effect"],
  );
  assert.match(
    requireValue(findings[0]).message ?? "",
    /preserve the React synchronization effect/u,
  );
});

test("preserves lazy draft initialization as a once-only snapshot", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function Permissions({ saved }: { saved: string[] }) {
      const [draft, setDraft] = useState(() => new Set(saved));
      useEffect(() => { setDraft(new Set(saved)); }, [saved]);
      return <main>
        <Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation /><Content />
        <PermissionsEditor value={draft} onChange={setDraft} />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  const state = findings.find((finding) => finding.hook === "useState");
  assert.equal(requireValue(state).action, "use-observable");
  assert.match(requireValue(state).message ?? "", /once-only owner snapshot/u);
  assert.match(requireValue(state).message ?? "", /not pass it to Legend as a computed/u);
});

test("keeps a synchronized local draft beside its value-forwarding upstream command", () => {
  const findings = analyzeSource(
    `
    import { useCallback, useEffect, useMemo, useState } from "react";
    export function Profile({ initialName, onChange }: { initialName: string; onChange: (value: string) => void }) {
      const [name, setName] = useState(initialName);
      useEffect(() => { setName(initialName); }, [initialName]);
      const debouncedChange = useMemo(() => debounce(onChange, 100), [onChange]);
      const edit = useCallback((next: string) => {
        const updated = name === next ? name : next.trimStart();
        setName(updated);
        debouncedChange(updated);
      }, [name, debouncedChange]);
      return <main>
        <Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation /><Content />
        <input value={name} onChange={event => edit(event.target.value)} />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.name === "name")).action,
    "use-observable",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.hook === "useEffect")).action,
    "review-effect",
  );
});

test("does not call unrelated or stateful work a synchronized draft forwarding command", () => {
  for (const edit of [
    `const edit = (next: string) => { const updated = next.trim(); setName(updated); notify(); };`,
    `const edit = (next: string) => { const updated = next.trim(); notify(updated); setName(updated); };`,
    `const edit = (next: string) => { const updated = next.trim(); setName(updated); notify(initialName); };`,
    `const markDirty = (next: string) => setDirty(next !== "");
     const edit = (next: string) => { const updated = next.trim(); setName(updated); markDirty(updated); };`,
  ]) {
    const findings = analyzeSource(
      `
      import { useEffect, useState } from "react";
      export function Profile({ initialName }: { initialName: string }) {
        const [name, setName] = useState(initialName);
        const [dirty, setDirty] = useState(false);
        useEffect(() => { setName(initialName); }, [initialName]);
        ${edit}
        return <main>
          <Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation /><Content />
          <input value={name} onChange={event => edit(event.target.value)} /><p>{dirty}</p>
        </main>;
      }
    `,
      "fixture.tsx",
    );
    assert.doesNotMatch(
      requireValue(findings.find((finding) => finding.name === "name")).message,
      /synchronization effect/u,
      edit,
    );
  }
});

test("groups every state written by one synchronization effect", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function Address({ city: initialCity, zip: initialZip }: { city: string; zip: string }) {
      const [city, setCity] = useState(initialCity);
      const [zip, setZip] = useState(initialZip);
      useEffect(() => {
        if (initialCity) {
          setCity(initialCity);
          setZip(initialZip);
        }
      }, [initialCity, initialZip]);
      return <main>
        <Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation />
        <input value={city} onChange={event => setCity(event.target.value)} />
        <input value={zip} onChange={event => setZip(event.target.value)} />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  const states = findings.filter((finding) => finding.hook === "useState");
  assert.deepEqual(
    states.map((finding) => finding.action),
    ["use-observable", "use-observable"],
  );
  assert.deepEqual(requireValue(requireValue(states[0]).group).members, ["city", "zip"]);
  assert.equal(requireValue(requireValue(states[0]).group).primary, true);
  assert.equal(requireValue(requireValue(states[1]).group).primary, false);
});

test("groups branch-complete drafts edited through a direct host callback", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function Editor({ open, saved }: { open: boolean; saved: { name: string; color: string } | null }) {
      const [name, setName] = useState("");
      const [color, setColor] = useState("red");
      useEffect(() => {
        if (!open) return;
        if (saved) {
          setName(saved.name);
          setColor(saved.color);
        } else {
          setName("");
          setColor("red");
        }
      }, [open, saved]);
      return <main>
        <Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation />
        <input value={name} onChange={setName} />
        <button style={{ color }} onClick={() => { notify(); setColor("blue"); }} />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  const states = findings.filter((finding) => finding.hook === "useState");
  assert.deepEqual(
    states.map((finding) => finding.action),
    ["use-observable", "use-observable"],
  );
  assert.deepEqual(requireValue(requireValue(states[0]).group).members, ["name", "color"]);
});

test("treats TypeScript-only JSX wrappers as direct draft transport", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    type Country = string & { readonly country: unique symbol };
    export function Address({ saved }: { saved: { country: string; city: string; state: string; zip: string } }) {
      const [country, setCountry] = useState(saved.country);
      const [city, setCity] = useState(saved.city);
      const [region, setRegion] = useState(saved.state);
      const [zip, setZip] = useState(saved.zip);
      useEffect(() => {
        setCountry(saved.country);
        setCity(saved.city);
        setRegion(saved.state);
        setZip(saved.zip);
      }, [saved]);
      const change = (next: string) => {
        setCountry(next);
        setCity("");
        setRegion("");
        setZip("");
      };
      return <main>
        <Header />
        <AddressForm
          country={country as unknown as Country}
          city={city}
          state={region}
          zip={zip}
          onAddressChanged={change}
        />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  const states = findings.filter((finding) => finding.hook === "useState");
  assert.deepEqual(
    states.map((finding) => finding.action),
    ["use-observable", "use-observable", "use-observable", "use-observable"],
  );
  assert.deepEqual(requireValue(requireValue(states[0]).group).members, [
    "country",
    "city",
    "region",
    "zip",
  ]);
});
