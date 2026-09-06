import { actions, requireValue } from "./harness.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

test("keeps state rendered by its owner", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Counter() {
        const [count, setCount] = useState(0);
        return <button onClick={() => setCount(count + 1)}>{count}</button>;
      }
    `),
    ["keep-state"],
  );
});

test("isolates direct controlled child state when a sibling proves an owner render cut", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    function Preview() { return null; }
    export function Form() {
      const [value, setValue] = useState("");
      const submit = () => save(value);
      return <main><Field value={value} onChangeText={setValue} /><Preview /><button onClick={submit} /></main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(
    requireValue(finding).message ?? "",
    /non-tracking reads in submit or commit commands/u,
  );
});

test("recognizes standard boolean controlled-child callbacks", () => {
  for (const callback of ["onCheckedChange", "onToggle"]) {
    const [finding] = analyzeSource(
      `
      import { useState } from "react";
      function Switch(_props: unknown) { return null; }
      function Preview() { return null; }
      export function Form() {
        const [enabled, setEnabled] = useState(false);
        const submit = () => save(enabled);
        return <main>
          <Switch checked={enabled} ${callback}={setEnabled} />
          <Preview />
          <button onClick={submit}>Save</button>
        </main>;
      }
    `,
      "fixture.tsx",
    );
    assert.equal(requireValue(finding).action, "use-observable", callback);
  }
});

test("recognizes descriptive value-transition callbacks on controlled leaves", () => {
  for (const callback of ["onInputChange", "onSelectCover", "onDashboardNameChange"]) {
    const [finding] = analyzeSource(
      `
      import { useState } from "react";
      function Field(_props: unknown) { return null; }
      function Preview() { return null; }
      export function Form() {
        const [value, setValue] = useState("");
        const submit = () => save(value);
        return <main>
          <Field value={value} ${callback}={setValue} />
          <Preview />
          <button onClick={submit}>Save</button>
        </main>;
      }
    `,
      "fixture.tsx",
    );
    assert.equal(requireValue(finding).action, "use-observable", callback);
  }
});

test("moves call-site-owned custom controlled state into that leaf", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    function Filter(_props: unknown) { return null; }
    function Preview() { return null; }
    export function Header() {
      const [open, setOpen] = useState(false);
      return <main>
        <Filter open={open} onOpenChange={() => setOpen(!open)} />
        <Preview />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "move-state-down");
});

test("does not treat an arbitrary setter prop as call-site-owned state", () => {
  for (const callback of ["register", "setCache"]) {
    for (const conditional of [false, true]) {
      const [finding] = analyzeSource(
        `
        import { useState } from "react";
        function Registry(_props: unknown) { return null; }
        function Alternative() { return null; }
        export function Screen({ compact }: { compact: boolean }) {
          const [value, setValue] = useState(false);
          ${conditional ? "if (compact) return <Alternative />;" : ""}
          return <main>
            <Header /><Summary /><Search /><Filters /><Actions /><Help />
            <Registry value={value} ${callback}={setValue} />
            <Status /><Footer /><Aside /><Preview /><Details /><Metrics />
          </main>;
        }
      `,
        "fixture.tsx",
      );
      assert.notEqual(
        requireValue(finding).action,
        conditional ? "use-observable" : "move-state-down",
        `${callback}/${conditional}`,
      );
    }
  }
});

test("recognizes explicit setter props as value-transition APIs", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    function Editor(_props: unknown) { return null; }
    function Alternative() { return null; }
    export function Form({ compact }: { compact: boolean }) {
      const [firstRender, setFirstRender] = useState(true);
      if (compact) return <Alternative />;
      return <main>
        <Header /><Summary /><Search /><Filters /><Actions /><Help />
        <Editor firstRender={firstRender} setFirstRender={setFirstRender} />
        <Status /><Footer /><Aside /><Preview /><Details /><Metrics />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
});

test("does not split custom controlled fields that share one validation projection", () => {
  const findings = analyzeSource(
    `
    import { useState } from "react";
    function Field(_props: unknown) { return null; }
    function Submit(_props: unknown) { return null; }
    function Preview() { return null; }
    export function Form() {
      const [title, setTitle] = useState("");
      const [message, setMessage] = useState("");
      const valid = title.trim().length > 0 && message.trim().length > 0;
      const submit = () => save(title, message);
      return <main>
        <Field value={title} onChangeTitle={setTitle} />
        <Field value={message} onChangeMessage={setMessage} />
        <Submit disabled={!valid} onClick={submit} />
        <Preview />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(findings.filter((finding) => finding.action === "use-observable").length, 0);
});

test("does not treat arbitrary callback props as controlled value transitions", () => {
  for (const callback of ["onClick", "onSubmit", "register", "renderValue"]) {
    const [finding] = analyzeSource(
      `
      import { useState } from "react";
      function Field(_props: unknown) { return null; }
      function Preview() { return null; }
      export function Form() {
        const [value, setValue] = useState("");
        const submit = () => save(value);
        return <main><Field value={value} ${callback}={setValue} /><Preview /><button onClick={submit} /></main>;
      }
    `,
      "fixture.tsx",
    );
    assert.notEqual(requireValue(finding).action, "use-observable", callback);
  }
});
