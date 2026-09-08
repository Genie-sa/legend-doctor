import { ConfirmationSet } from "../../src/analysis/assumptions/confirmations.js";
import type { HookFinding } from "../../src/core/types.js";
import { analyzeSourceWith } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

const CHROME =
  "<header /><nav /><aside /><section /><article /><footer /><hr /><p /><p /><p /><p /><p />";
const PENDING = `
  import { useState } from "react";
  export function Screen() {
    const [pending, setPending] = useState(false);
    const submit = async () => {
      setPending(true);
      try { await save(); } finally { setPending(false); }
    };
    return <main>${CHROME}<Unknown disabled={pending} onClick={submit} /></main>;
  }
`;

function pending(source = PENDING, confirmations: ConfirmationSet | null = null): HookFinding {
  return requireValue(
    analyzeSourceWith(source, "screen.tsx", { confirmations }).find(
      (finding) => finding.name === "pending",
    ),
  );
}

test("a proven pending interval asks about its event origin, not nonexistent captured reads", () => {
  const finding = pending();
  assert.equal(finding.abstentionReason, "async-command-origin-unresolved");
  const assumption = requireValue(finding.assumption);
  assert.deepEqual(assumption.facts, ["async-command-origin-unresolved"]);
  assert.equal(assumption.ifConfirmed, "use-observable");
  assert.match(assumption.question, /event/u);
  assert.doesNotMatch(assumption.question, /peek|render snapshot/u);
  assert.ok(assumption.research.some((step) => step.line === 9 || step.lines?.includes(9)));
  const converted = pending(
    PENDING,
    new ConfirmationSet([
      { id: assumption.id, answer: "yes", fingerprint: assumption.fingerprint },
    ]),
  );
  assert.equal(converted.action, "use-observable");
  assert.match(converted.message, /async completion boundary/u);
  assert.ok(converted.verification);
});

test("a known render-time invocation cannot be waived by an event-origin question", () => {
  const finding = pending(PENDING.replace("return <main>", "submit(); return <main>"));
  assert.equal(finding.action, "review-state");
  assert.equal(finding.assumption, undefined);
  assert.equal(finding.review?.kind, "investigate");
});

for (const adapter of [
  "() => { if (false) submit(); }",
  "() => { return; submit(); }",
  "() => { while (false) submit(); }",
  "function* () { return submit(); }",
]) {
  test(`does not waive command execution through ${adapter}`, () => {
    const finding = pending(PENDING.replace("onClick={submit}", `onClick={${adapter}}`));
    assert.equal(finding.action, "review-state");
    assert.equal(finding.assumption, undefined);
  });
}

test("a direct inline command adapter can still be researched", () => {
  const finding = pending(PENDING.replace("onClick={submit}", "onClick={() => submit()}"));
  assert.equal(requireValue(finding.assumption).ifConfirmed, "use-observable");
});
