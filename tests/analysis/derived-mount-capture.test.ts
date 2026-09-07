import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

for (const initializer of ['"loading"', "value"]) {
  for (const capture of [
    "const [draft] = useState(text);",
    "const draft = useRef(text).current;",
    "const draft = text; useEffect(() => capture(text), []);",
  ]) {
    test(`preserves child mount capture with initializer ${initializer}: ${capture}`, () => {
      const findings = analyzeSource(
        `
        import { useEffect, useRef, useState } from "react";
        function Field({ text }) { ${capture} return <span>{draft}</span>; }
        function Panel({ value, id }) {
          const [text, setText] = useState(${initializer});
          useEffect(() => { setText(value); }, [value]);
          return <Field key={id} text={text} />;
        }
      `,
        "fixture.tsx",
      );
      assert.ok(
        findings.every(
          (finding) =>
            finding.action !== "delete-derived-state" && finding.action !== "delete-effect",
        ),
      );
    });
  }
}

test("preserves the initial committed value even with a direct host consumer", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    function Panel({ value }) {
      const [text, setText] = useState("loading");
      useEffect(() => setText(value), [value]);
      return <span>{text}</span>;
    }
  `,
    "fixture.tsx",
  );
  assert.ok(
    findings.every(
      (finding) => finding.action !== "delete-derived-state" && finding.action !== "delete-effect",
    ),
  );
});

for (const output of [
  "<input key={id} defaultValue={text} />",
  "<input key={id} defaultChecked={text} />",
  "text ? <Field /> : null",
]) {
  test(`preserves mount-sensitive host inputs and conditional children: ${output}`, () => {
    const findings = analyzeSource(
      `
      import { useEffect, useState } from "react";
      function Field() { useEffect(() => mounted(), []); return null; }
      function Panel({ value, id }) {
        const [text, setText] = useState(value);
        useEffect(() => setText(value), [value]);
        return ${output};
      }
    `,
      "fixture.tsx",
    );
    assert.notEqual(
      findings.find((finding) => finding.name === "text")?.action,
      "delete-derived-state",
    );
  });
}

for (const children of ["{text}", "<span>{text}</span>"]) {
  test(`preserves state captured through a child element's children prop: ${children}`, () => {
    const findings = analyzeSource(
      `
      import { useEffect, useState } from "react";
      function Field({ children }) { const [draft] = useState(children); return <div>{draft}</div>; }
      function Panel({ value, id }) {
        const [text, setText] = useState(value);
        useEffect(() => setText(value), [value]);
        return <Field key={id}>${children}</Field>;
      }
    `,
      "fixture.tsx",
    );
    assert.notEqual(
      findings.find((finding) => finding.name === "text")?.action,
      "delete-derived-state",
    );
  });
}
