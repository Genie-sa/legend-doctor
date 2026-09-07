import { COMPACT_MATERIALITY, DEFAULT_MATERIALITY } from "../../src/analysis/constants.js";
import { analyzeSourceWith } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { parseArguments } from "../../src/cli/options.js";
import { requireValue } from "./harness.js";
import test from "node:test";

const COMPACT_OWNER = `
    import { useState } from "react";
    export function Screen({ save }) {
      const [saving, setSaving] = useState(false);
      const handleSave = () => {
        setSaving(!saving);
        save();
      };
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
        <section><SaveButton pending={saving} onPress={handleSave} /><p>{saving ? "Saving" : "Idle"}</p></section>
      </main>;
    }
`;

test("the default tier keeps an eight-element owner under review", () => {
  const [finding] = analyzeSourceWith(COMPACT_OWNER, "fixture.tsx", {
    materiality: DEFAULT_MATERIALITY,
  });
  assert.equal(requireValue(finding).action, "review-state");
  assert.equal(requireValue(finding).materiality, undefined);
});

test("the compact tier proves the same cut and tags the finding", () => {
  const [finding] = analyzeSourceWith(COMPACT_OWNER, "fixture.tsx", {
    materiality: COMPACT_MATERIALITY,
  });
  assert.equal(requireValue(finding).action, "move-state-down");
  assert.equal(requireValue(finding).materiality, "compact");
});

test("the compact tier leaves broad-owner findings untagged", () => {
  const [finding] = analyzeSourceWith(
    COMPACT_OWNER.replace("<Footer />", "<Footer /><Aside /><Help /><Status /><Actions />"),
    "fixture.tsx",
    { materiality: COMPACT_MATERIALITY },
  );
  assert.equal(requireValue(finding).action, "move-state-down");
  assert.equal(requireValue(finding).materiality, undefined);
});

test("--materiality accepts the two tiers and rejects others", () => {
  assert.equal(parseArguments(["src"]).materiality, null);
  assert.equal(parseArguments(["src", "--materiality", "compact"]).materiality, "compact");
  assert.equal(parseArguments(["src", "--materiality=broad"]).materiality, "broad");
  assert.throws(
    () => parseArguments(["src", "--materiality", "tiny"]),
    /must be one of: broad, compact/u,
  );
});

for (const source of [
  "function Panel() { const [value] = useState(0); return <span>{value}</span>; }",
  "function Panel() { const [value, setValue] = useState(0); return <button onClick={() => setValue(1)}>Go</button>; }",
]) {
  test(`compact does not claim an unchanged outcome: ${source}`, () => {
    const input = `import { useState } from "react"; ${source}`;
    const [broad] = analyzeSourceWith(input, "fixture.tsx", { materiality: DEFAULT_MATERIALITY });
    const [compact] = analyzeSourceWith(input, "fixture.tsx", { materiality: COMPACT_MATERIALITY });
    assert.equal(compact?.action, broad?.action);
    assert.equal(compact?.materiality, undefined);
  });
}
