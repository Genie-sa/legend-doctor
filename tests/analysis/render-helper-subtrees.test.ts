import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

const OWNER_PREFIX =
  "<Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />";

function findingFor(source: string, name: string): ReturnType<typeof analyzeSource>[number] {
  return requireValue(
    analyzeSource(source, "fixture.tsx").find((finding) => finding.name === name),
  );
}

test("keeps state up when the extracted subtree calls a render helper holding most of the owner", () => {
  const finding = findingFor(
    `
    import { useState } from "react";
    export function Screen({ save }) {
      const [saving, setSaving] = useState(false);
      const renderBody = () => (
        <section>
          ${OWNER_PREFIX}
          <SaveButton pending={saving} onPress={() => { setSaving(true); save(); }} />
        </section>
      );
      return <main><Title /><Nav /><div>{renderBody()}<Spacer /></div></main>;
    }
  `,
    "saving",
  );
  assert.notEqual(finding.action, "move-state-down");
  assert.notEqual(finding.action, "use-observable");
});

test("counts render helpers reached through a moved owner-level declaration", () => {
  const finding = findingFor(
    `
    import { useState } from "react";
    export function Screen() {
      const [expanded, setExpanded] = useState(false);
      const renderRows = () => <ul>${OWNER_PREFIX}{expanded ? <More /> : null}</ul>;
      const rows = renderRows();
      return <main><Title /><Nav /><Tabs /><Search />
        <section>{rows}<button onClick={() => setExpanded(true)}>Toggle</button></section>
      </main>;
    }
  `,
    "expanded",
  );
  assert.notEqual(finding.action, "move-state-down");
});

test("abstains when a helper called from the subtree is reassigned", () => {
  const finding = findingFor(
    `
    import { useState } from "react";
    export function Screen({ wide }) {
      const [expanded, setExpanded] = useState(false);
      let renderExtra = () => null;
      if (wide) {
        renderExtra = () => <aside>${OWNER_PREFIX}</aside>;
      }
      return <main><Title /><Nav /><Tabs /><Search /><Crumbs /><Tools /><Meta /><Links /><Badge /><Clock />
        <section><p>{expanded ? "Long" : "Short"}</p>{renderExtra()}<button onClick={() => setExpanded(v => !v)}>Toggle</button></section>
      </main>;
    }
  `,
    "expanded",
  );
  assert.notEqual(finding.action, "move-state-down");
});

test("still moves state down with a small render helper that moves into the leaf", () => {
  const finding = findingFor(
    `
    import { useState } from "react";
    export function Screen({ save }) {
      const [saving, setSaving] = useState(false);
      const renderStatus = () => <p>{saving ? "Saving" : "Idle"}</p>;
      return <main>
        ${OWNER_PREFIX}
        <section>{renderStatus()}<SaveButton onPress={() => { setSaving(true); save(); }} /></section>
      </main>;
    }
  `,
    "saving",
  );
  assert.equal(finding.action, "move-state-down");
  assert.match(finding.message ?? "", /Move `renderStatus` into that leaf as well/u);
});

test("does not charge the subtree for a same-named binding scoped outside it", () => {
  const finding = findingFor(
    `
    import { useState } from "react";
    import { renderStatus } from "./status";
    export function Screen() {
      const [expanded, setExpanded] = useState(false);
      const header = (() => {
        const renderStatus = () => <div>${OWNER_PREFIX}</div>;
        return renderStatus();
      })();
      return <main>{header}<Title /><Nav />
        <section><p>{expanded ? "Long" : "Short"}</p>{renderStatus()}<button onClick={() => setExpanded(v => !v)}>Toggle</button></section>
      </main>;
    }
  `,
    "expanded",
  );
  assert.equal(finding.action, "move-state-down");
});

test("follows a handler whose own locals are reassigned without abstaining", () => {
  const finding = findingFor(
    `
    import { useState } from "react";
    export function Screen({ save }) {
      const [saving, setSaving] = useState(false);
      const handleSave = () => {
        let attempts = 0;
        attempts += 1;
        setSaving(true);
        save(attempts);
      };
      return <main>
        ${OWNER_PREFIX}
        <section><SaveButton pending={saving} onPress={handleSave} /><p>{saving ? "Saving" : "Idle"}</p></section>
      </main>;
    }
  `,
    "saving",
  );
  assert.equal(finding.action, "move-state-down");
});
