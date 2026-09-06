import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("uses a strict local JSX cut for a compact synchronized draft", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function Editor({ open, saved }: { open: boolean; saved: string }) {
      const [value, setValue] = useState(saved);
      const [error, setError] = useState<string | null>(null);
      useEffect(() => { if (open) { setValue(saved); setError(null); } }, [open, saved]);
      return <Dialog>
        <Header /><Description />
        <section>
          <textarea value={value} onChange={event => { setValue(event.target.value); setError(null); }} />
          {error && <p>{error}</p>}
        </section>
        <Footer /><Cancel /><Save onError={() => setError("invalid")} />
      </Dialog>;
    }
  `,
    "fixture.tsx",
  );
  const states = findings.filter((finding) => finding.hook === "useState");
  assert.deepEqual(
    states.map((finding) => finding.action),
    ["use-observable", "use-observable"],
  );
  assert.deepEqual(requireValue(requireValue(states[0]).group).members, ["value", "error"]);
});

test("does not use owner line count as proof of a synchronized draft cut", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function Tiny({ saved }: { saved: string }) {
      const [value, setValue] = useState(saved);
      useEffect(() => { setValue(saved); }, [saved]);
      ${"\n".repeat(120)}
      return <label><input value={value} onChange={setValue} /></label>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(
    requireValue(findings.find((finding) => finding.name === "value")).action,
    "use-observable",
  );
});

test("requires a synchronized draft's one call site to contain every render read", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function Compact({ saved }: { saved: string | null }) {
      const [value, setValue] = useState(saved);
      useEffect(() => { setValue(saved); }, [saved]);
      return <main><Header />{value && <Editor value={value} onChange={setValue} />}</main>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(
    requireValue(findings.find((finding) => finding.name === "value")).action,
    "use-observable",
  );
});

test("does not change a synchronized draft's stale deferred snapshot", () => {
  const findings = analyzeSource(
    `
    import { useCallback, useEffect, useState } from "react";
    export function Editor({ saved }: { saved: string }) {
      const [value, setValue] = useState(saved);
      useEffect(() => { setValue(saved); }, [saved]);
      const save = useCallback(() => persist(value), []);
      return <main><Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation />
        <input value={value} onChange={setValue} /><button onClick={save}>Save</button>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(
    requireValue(findings.find((finding) => finding.name === "value")).action,
    "use-observable",
  );
});

test("rejects reset mirrors, hook-fed owner work, and edit commands with external work", () => {
  const cases = [
    {
      edit: `const edit = () => setValue(source);`,
      setup: `useEffect(() => { setValue(source); }, [source]);`,
    },
    {
      edit: `const edit = () => setValue("edit");`,
      setup: `const filtered = useDebouncedValue(value.trim()); useEffect(() => { setValue(source); }, [source]);`,
    },
    {
      edit: `const edit = () => { setValue("edit"); updateExternal(); };`,
      setup: `useEffect(() => { setValue(source); }, [source]);`,
    },
  ];
  for (const { edit, setup } of cases) {
    const [finding] = analyzeSource(
      `
      import { useEffect, useState } from "react";
      export function Form({ source }: { source: string }) {
        const [value, setValue] = useState<string | null>(source);
        ${setup}
        ${edit}
        return <main><Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation /><p>{value}</p><button onClick={edit} /></main>;
      }
    `,
      "fixture.tsx",
    );
    assert.doesNotMatch(requireValue(finding).message, /synchronization effect/u);
  }
});

test("keeps a synchronized draft when a one-hop projection feeds a hook", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function Search({ open }: { open: boolean }) {
      const [query, setQuery] = useState("");
      const trimmedQuery = query.trim();
      const debouncedQuery = useDebouncedValue(trimmedQuery);
      useSearchResults(debouncedQuery);
      useEffect(() => { if (!open) setQuery(""); }, [open]);
      return <main><Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation /><input value={query} onChange={setQuery} /></main>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(
    requireValue(findings.find((finding) => finding.name === "query")).action,
    "use-observable",
  );
});

test("does not use broad JSX count as proof of a synchronized draft render cut", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function Card({ disabled }: { disabled: boolean }) {
      const [open, setOpen] = useState(false);
      useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
      return <Collapsible.Root open={open} onOpenChange={nextOpen => { if (!disabled) setOpen(nextOpen); }}>
        <Header /><Trigger /><Description /><Summary /><Controls /><Fields /><Preview /><Help /><Status /><Actions /><Footer />
        <Collapsible.Content className={open ? "expanded" : "collapsed"}><Content /></Collapsible.Content>
      </Collapsible.Root>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(
    requireValue(findings.find((finding) => finding.name === "open")).action,
    "use-observable",
  );
});

test("keeps a keyed one-hop render alias inside a synchronized draft", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function Picker({ rows, source }: { rows: Array<{ id: string }>; source: string | null }) {
      const [active, setActive] = useState<string | null>(source);
      useEffect(() => { setActive(source); }, [source]);
      return <main><Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation />
        {rows.map(row => {
          const selected = active === row.id;
          return <button key={row.id} aria-pressed={selected} onClick={() => setActive(row.id)} />;
        })}
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.name === "active")).action,
    "use-observable",
  );
});

test("preserves one command snapshot for a synchronized draft read by deferred work", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function DeletePanel({ initial, rows }: { initial: boolean; rows: string[] }) {
      const [decrement, setDecrement] = useState(initial);
      useEffect(() => { setDecrement(initial); }, [initial]);
      const remove = async () => {
        await Promise.all(rows.map(id => destroy(id, { decrement })));
      };
      return <main><Header /><Summary /><Help /><Preview /><Footer /><Aside /><Status /><Actions /><Toolbar /><Navigation />
        <Checkbox checked={decrement} onCheckedChange={setDecrement} /><button onClick={remove} />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  const state = findings.find((finding) => finding.name === "decrement");
  assert.equal(requireValue(state).action, "use-observable");
  assert.match(requireValue(state).message ?? "", /snapshot once at command entry/u);
});
