import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

const OWNER_PREFIX =
  "<Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />";

test("moves co-written states down together when one handler and one subtree confine them", () => {
  const findings = analyzeSource(
    `
    import { useState } from "react";
    export function Screen({ save }) {
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState(null);
      const handleSave = () => {
        setSaving(true);
        setError(null);
        save();
      };
      return <main>
        ${OWNER_PREFIX}
        <section><SaveButton pending={saving} onPress={handleSave} /><p>{error ?? (saving ? "Saving" : "Idle")}</p></section>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  const saving = requireValue(findings.find((finding) => finding.name === "saving"));
  const error = requireValue(findings.find((finding) => finding.name === "error"));
  assert.equal(saving.action, "move-state-down");
  assert.equal(error.action, "move-state-down");
  assert.equal(saving.group?.id, error.group?.id);
  assert.match(saving.message ?? "", /confined state cluster \(`saving`, `error`\)/u);
});

test("keeps co-written states up when a companion renders outside the shared subtree", () => {
  const findings = analyzeSource(
    `
    import { useState } from "react";
    export function Screen({ save }) {
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState(null);
      const handleSave = () => {
        setSaving(true);
        setError(null);
        save();
      };
      return <main>
        <Banner message={error} />
        ${OWNER_PREFIX}
        <section><SaveButton pending={saving} onPress={handleSave} /><p>{saving ? "Saving" : "Idle"}</p></section>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  const saving = requireValue(findings.find((finding) => finding.name === "saving"));
  assert.notEqual(saving.action, "move-state-down");
  assert.equal(saving.group, undefined);
});
