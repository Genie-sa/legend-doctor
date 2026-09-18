import { analyzeSourceWith } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

const CHROME =
  "<header /><nav /><aside /><section /><article /><footer /><hr /><p /><p /><p /><p /><p />";

test("a default parameter and two command origins do not invent a pending-state snapshot read", () => {
  const source = `
    import { useState } from "react";
    function Screen({ selectedPath }: { selectedPath: string | null }) {
      const [pending, setPending] = useState(false);
      const run = async (path = selectedPath) => {
        if (!path) return;
        try { setPending(true); await save(path); }
        finally { setPending(false); }
      };
      return <main>${CHROME}
        <UnknownPicker onSubmit={run} />
        <button disabled={!selectedPath || pending} onClick={() => run()}>
          {pending ? "Working" : "Run"}
        </button>
      </main>;
    }
  `;
  const finding = requireValue(
    analyzeSourceWith(source, "screen.tsx", {}).find((entry) => entry.name === "pending"),
  );
  assert.equal(finding.action, "review-state");
  assert.equal(finding.disposition, "candidate");
  assert.equal(finding.abstentionReason, "async-command-origin-unresolved");
  const assumption = requireValue(finding.assumption);
  assert.match(assumption.question, /every listed callback prop/u);
  assert.doesNotMatch(assumption.question, /peek|render snapshot/u);
  assert.equal(assumption.research[0]?.total, 2);
  assert.equal(assumption.ifConfirmed, "use-observable");
});

test("an opaque hook callback reading pending requires snapshot review rather than an event-origin claim", () => {
  const source = `
    import { useState } from "react";
    function Screen() {
      const [pending, setPending] = useState(false);
      const run = useUnknown(() => { setPending(false); report(pending); });
      return <main>${CHROME}
        <UnknownPicker onSubmit={run} />
        <button disabled={pending} onClick={() => setPending(true)}>
          {pending ? "Working" : "Run"}
        </button>
      </main>;
    }
  `;
  const finding = requireValue(
    analyzeSourceWith(source, "screen.tsx", {}).find((entry) => entry.name === "pending"),
  );
  assert.equal(finding.action, "review-state");
  assert.equal(finding.disposition, "candidate");
  assert.equal(finding.abstentionReason, "callback-timing-unresolved");
  const assumption = requireValue(finding.assumption);
  assert.match(assumption.question, /read 1 time\(s\).*render snapshot/u);
  assert.doesNotMatch(assumption.question, /pending interval and leaf render boundary/u);
});
