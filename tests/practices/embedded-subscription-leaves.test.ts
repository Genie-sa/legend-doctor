import type { LegendPracticeFinding } from "../../src/core/types.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

function findings(content: string): LegendPracticeFinding[] {
  return analyzeLegendPractices({
    fileName: "fixture.tsx",
    sourceText: `
      import { useObservable, useValue } from "@legendapp/state/react";
      export function Settings({ label }) {
        const error$ = useObservable("");
        const error = useValue(error$);
        return <main>
          <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
          <Aside /><Help /><Status /><Actions /><Search />
          <Row control={${content}} />
        </main>;
      }
    `,
  }).filter((finding) => finding.action === "move-use-value-down");
}

test("extracts an error display embedded in a JSX prop without moving the neighboring command", () => {
  const result = findings(`<section>
    <input aria-label={label} className={error ? "invalid" : ""} onInput={() => save()} />
    {error ? <span>{error}</span> : null}
  </section>`);
  assert.equal(result.length, 1);
  const finding = requireValue(result[0]);
  assert.match(finding.message, /<section>/u);
  assert.match(finding.message, /3 JSX elements instead of the 16-element owner/u);
});

test("does not mistake a deferred or imperative use inside a JSX prop for a render-only read", () => {
  for (const content of [
    `<section><input title={error} onInput={() => error} /></section>`,
    `<section><span>{format(error)}</span></section>`,
    `<section><Render>{() => <span>{error}</span>}</Render></section>`,
    `<section><input key={error} /><span>{error}</span></section>`,
    `<section>{[1, 2].map(id => <span key={id}>{error}</span>)}</section>`,
  ]) {
    assert.equal(findings(content).length, 0, content);
  }
});
