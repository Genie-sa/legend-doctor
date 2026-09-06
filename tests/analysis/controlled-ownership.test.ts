import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("isolates an exact controlled array membership toggle", () => {
  const findings = analyzeSource(
    `
    import { useState } from "react";
    import { useForm } from "react-hook-form";
    function CheckboxGroup(_props: unknown) { return null; }
    export function Settings({ initial }: { initial: string[] }) {
      const [selected, setSelected] = useState(initial);
      const { handleSubmit } = useForm();
      const toggle = (value: string) => {
        setSelected(previous => {
          if (previous.includes(value)) {
            return previous.filter(item => item !== value);
          } else {
            return [...previous, value];
          }
        });
      };
      const submit = () => save(selected);
      return <form onSubmit={handleSubmit(submit)}>
        <Header /><Details /><Help /><Preview /><History /><Status /><Aside /><Footer /><Actions /><Summary /><Toolbar />
        <CheckboxGroup selected={selected} onSelectionChange={toggle} />
        <button type="submit">Save</button>
      </form>;
    }
    export function OpaqueSettings({ initial }: { initial: string[] }) {
      const [selected, setSelected] = useState(initial);
      const toggle = (value: string) => setSelected(previous => reconcile(previous, value));
      const submit = () => save(selected);
      return <main>
        <Header /><Details /><Help /><Preview /><History /><Status /><Aside /><Footer /><Actions /><Summary /><Toolbar />
        <CheckboxGroup selected={selected} onSelectionChange={toggle} />
        <button onClick={submit}>Save</button>
      </main>;
    }
  `,
    "fixture.tsx",
  ).filter((finding) => finding.name === "selected");
  assert.equal(requireValue(findings[0]).action, "use-observable");
  assert.notEqual(requireValue(findings[1]).action, "use-observable");
});

test("keeps controlled state already owned by one cohesive leaf", () => {
  const findings = analyzeSource(
    `
    import { useState } from "react";
    function Input(_props: unknown) { return null; }
    function Preview() { return null; }
    export function Field() {
      const [value, setValue] = useState("");
      return <Input value={value} onChange={next => { persist(next); setValue(next); }} />;
    }
    export function Form() {
      const [value, setValue] = useState("");
      return <main>
        <Input value={value} onChange={setValue} />
        <Preview /><Preview /><Preview /><Preview /><Preview /><Preview />
        <Preview /><Preview /><Preview /><Preview /><Preview /><Preview />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(findings[0]).action, "keep-state");
  assert.equal(requireValue(findings[1]).action, "move-state-down");
});

test("keeps call-site-owned state above a conditionally mounted controlled leaf", () => {
  for (const alternateReturn of [false, true]) {
    const [finding] = analyzeSource(
      `
      import { useState } from "react";
      function Menu(_props: unknown) { return null; }
      function Alternative() { return null; }
      export function Toolbar({ compact, enabled }: { compact: boolean; enabled: boolean }) {
        const [open, setOpen] = useState(false);
        ${alternateReturn ? "if (compact) return <Alternative />;" : ""}
        return <main>
          <Header /><Summary /><Search /><Filters /><Actions /><Help />
          {enabled && <Menu open={open} onOpenChange={setOpen} />}
          <Status /><Footer /><Aside /><Preview /><Details /><Metrics />
        </main>;
      }
    `,
      "fixture.tsx",
    );
    assert.equal(requireValue(finding).action, "use-observable");
    assert.match(requireValue(finding).message ?? "", /keep ownership at this owner/iu);
  }
});

test("keeps controlled menu ownership above descendant close commands", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    import { Menu } from "third-party-ui";
    export function Widget({ enabled, onEdit }: { enabled: boolean; onEdit: () => void }) {
      const [open, setOpen] = useState(false);
      return <main>
        <Header /><Summary /><Search /><Filters /><Actions /><Help />
        {enabled && <Menu open={open} onOpenChange={setOpen}>
          <button onClick={() => { setOpen(false); onEdit(); }}>Edit</button>
        </Menu>}
        <Status /><Footer /><Aside /><Preview /><Details /><Metrics />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /keep ownership at this owner/iu);
});

test("does not isolate call-site-owned state when it controls the child mount", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    function Menu(_props: unknown) { return null; }
    export function Toolbar() {
      const [open, setOpen] = useState(false);
      return <main>
        <Header /><Summary /><Search /><Filters /><Actions /><Help />
        {open && <Menu open={open} onOpenChange={setOpen} />}
        <Status /><Footer /><Aside /><Preview /><Details /><Metrics />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(requireValue(finding).action, "use-observable");
});

test("does not isolate call-site-owned state in repeated controlled leaves", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    function Menu(_props: unknown) { return null; }
    export function Toolbar({ rows }: { rows: Array<{ id: string }> }) {
      const [open, setOpen] = useState(false);
      return <main>
        <Header /><Summary /><Search /><Filters /><Actions /><Help />
        {rows.map(row => <Menu key={row.id} open={open} onOpenChange={setOpen} />)}
        <Status /><Footer /><Aside /><Preview /><Details /><Metrics />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.doesNotMatch(requireValue(finding).message ?? "", /branch-local `Menu` call site/u);
});

test("keeps controlled ownership above state-independent early returns", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    function Header() { return null; }
    function NotFound() { return null; }
    export function Form({ missing }: { missing: boolean }) {
      const [value, setValue] = useState("");
      const submit = () => save(value);
      if (missing) return <NotFound />;
      return <main>
        <Header />
        <Field value={value} onChangeText={setValue} onBlur={submit} />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /controlled state/u);
});

test("isolates a controlled leaf in one of several prop-selected returns", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    function Header() { return null; }
    function Alternative() { return null; }
    export function Form({ mode }: { mode: "edit" | "other" }) {
      const [value, setValue] = useState("");
      const submit = () => save(value);
      if (mode !== "edit") return <Alternative />;
      return <main><Header /><Field value={value} onChange={setValue} onBlur={submit} /></main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
});

test("does not use a stored controlled JSX value as a branch callsite", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    function Header() { return null; }
    export function Form({ disabled }: { disabled: boolean }) {
      const [value, setValue] = useState("");
      const field = <Field value={value} onChangeText={setValue} />;
      if (disabled) return <Header />;
      return <main><Header />{field}</main>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(requireValue(finding).action, "use-observable");
});

test("does not call a state-controlled early return a controlled leaf", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    function Empty(_props: unknown) { return null; }
    function Header() { return null; }
    export function Form() {
      const [value, setValue] = useState("");
      if (!value) return <Empty onStart={() => setValue("start")} />;
      return <main><Header /><Field value={value} onChangeText={setValue} /></main>;
    }
  `,
    "fixture.tsx",
  );
  assert.doesNotMatch(requireValue(finding).message ?? "", /Replace controlled state/u);
});

test("does not split one controlled value across alternate return branches", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    function CompactField(_props: unknown) { return null; }
    function FullField(_props: unknown) { return null; }
    function Header() { return null; }
    export function Form({ compact }: { compact: boolean }) {
      const [value, setValue] = useState("");
      if (compact) return <CompactField value={value} onChangeText={setValue} />;
      return <main><Header /><FullField value={value} onChangeText={setValue} /></main>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(requireValue(finding).action, "use-observable");
});
