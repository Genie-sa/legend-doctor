import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("keeps state up when a command outside the subtree reads it", () => {
  const screen = (command: string, outside: string): string => `
    import { useState } from "react";
    export function Screen() {
      const [expanded, setExpanded] = useState(false);
      ${command}
      ${"\n".repeat(150)}
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <section><p>{expanded ? "Long" : "Short"}</p><button onClick={() => setExpanded(v => !v)}>Toggle</button></section>
        ${outside}
      </main>;
    }
  `;
  for (const [command, outside] of [
    ["const exportIt = () => download(expanded);", "<button onClick={exportIt}>Export</button>"],
    ["", "<button onClick={() => download(expanded)}>Export</button>"],
  ] as const) {
    const [finding] = analyzeSource(screen(command, outside), "fixture.tsx");
    assert.notEqual(requireValue(finding).action, "move-state-down", outside);
  }
});

test("moves state down with a command read inside the subtree", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Screen() {
      const [expanded, setExpanded] = useState(false);
      ${"\n".repeat(150)}
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <section>
          <p>{expanded ? "Long" : "Short"}</p>
          <button onClick={() => setExpanded(v => !v)}>Toggle</button>
          <button onClick={() => download(expanded)}>Export</button>
        </section>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "move-state-down");
});
