import { ConfirmationSet } from "../../src/analysis/assumptions/confirmations.js";
import type { HookFinding } from "../../src/core/types.js";
import { analyzeSourceWith } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { rankedQuestions } from "../../src/analysis/assumptions/ranked-questions.js";
import { requireValue } from "./harness.js";
import test from "node:test";

const CHROME =
  "<Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview /><Nav />";

const FILTERED_LIST = `
  import { useState } from "react";
  export function Panel({ rows }: { rows: string[] }) {
    const [filter, setFilter] = useState("");
    return <main>${CHROME}
      <input value={filter} onChange={(e) => setFilter(e.target.value)} />
      <ul>{rows.filter((r) => r.includes(filter)).map((r) => <li key={r}>{r}</li>)}</ul>
      <p>{filter ? "filtered" : "all"}</p>
    </main>;
  }
`;

const CO_WRITTEN_DRAWER = `
  import { useState } from "react";
  export function Panel() {
    const [open, setOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const fail = (message: string) => { setError(message); setOpen(true); };
    return <main>${CHROME}
      <button onClick={() => fail("boom")} />
      {error ? <p role="alert">{error.toUpperCase()}</p> : null}
      <Drawer open={open} onClose={() => setOpen(false)} />
    </main>;
  }
`;

function states(source: string, confirmations: ConfirmationSet | null = null): HookFinding[] {
  return analyzeSourceWith(source, "src/panel.tsx", { confirmations }).filter(
    (finding) => finding.hook === "useState",
  );
}

test("a render-cut review carries the question whose yes wraps each read site", () => {
  const [filter] = states(FILTERED_LIST);
  const found = requireValue(filter);
  assert.equal(found.action, "review-state");
  assert.equal(found.abstentionReason, "render-cut-unproven");
  const assumption = requireValue(found.assumption);
  assert.equal(assumption.id, "src/panel.tsx::Panel::filter::render-cut-unproven");
  assert.equal(assumption.ifConfirmed, "use-observable");
  assert.equal(assumption.status, "open");
  assert.match(assumption.question, /`filter` is read 3 times in the render of Panel/u);
  assert.match(assumption.question, /lines 6, 7, 8/u);
  assert.ok(assumption.renderCost >= 12);
  assert.equal(assumption.updateSites, 1);
  assert.match(assumption.fingerprint, /^[0-9a-f]{12}$/u);
  assert.deepEqual(
    assumption.research.map((step) => [step.file, step.line]),
    [
      ["src/panel.tsx", 4],
      ["src/panel.tsx", 6],
      ["src/panel.tsx", 7],
      ["src/panel.tsx", 8],
    ],
  );
  assert.match(requireValue(assumption.research[0]).check, /declared here/u);
  assert.match(requireValue(assumption.research[1]).check, /read in render here/u);
});

test("the fingerprint ignores whitespace and changes when the owner's code changes", () => {
  const [before] = states(FILTERED_LIST);
  const [reformatted] = states(FILTERED_LIST.replaceAll("\n      ", "\n  "));
  const [edited] = states(FILTERED_LIST.replace('"filtered"', '"narrowed"'));
  const { fingerprint } = requireValue(requireValue(before).assumption);
  assert.equal(requireValue(requireValue(reformatted).assumption).fingerprint, fingerprint);
  assert.notEqual(requireValue(requireValue(edited).assumption).fingerprint, fingerprint);
});

test("an answer recorded for a different fingerprint is stale and not applied", () => {
  const id = "src/panel.tsx::Panel::filter::render-cut-unproven";
  const [filter] = states(
    FILTERED_LIST,
    new ConfirmationSet([{ answer: "yes", fingerprint: "000000000000", id }]),
  );
  const kept = requireValue(filter);
  assert.equal(kept.action, "review-state");
  assert.equal(requireValue(kept.assumption).status, "stale");
  const { fingerprint: matching } = requireValue(kept.assumption);
  const [converted] = states(
    FILTERED_LIST,
    new ConfirmationSet([{ answer: "yes", fingerprint: matching, id }]),
  );
  assert.equal(requireValue(converted).action, "use-observable");
});

test("group questions point at every member's declaration and write sites", () => {
  const [open] = states(CO_WRITTEN_DRAWER);
  const { research } = requireValue(requireValue(open).assumption);
  assert.deepEqual(
    research.map((step) => step.line),
    [4, 6, 10, 5, 6],
  );
  assert.match(
    requireValue(research[0]).check,
    /`open` is declared here .*on its own it would become use-observable/u,
  );
  assert.match(
    requireValue(research[3]).check,
    /`error` is declared here .*stays under review for render-cut-unproven/u,
  );
  assert.match(
    requireValue(research[1]).check,
    /a render could never observe one member updated without the others/u,
  );
});

test("a co-written group asks one question, naming what a yes converts and what it leaves blocked", () => {
  const [open, error] = states(CO_WRITTEN_DRAWER);
  const groupId = "src/panel.tsx::Panel::{open,error}::atomic-transition-unproven";
  const asked = requireValue(requireValue(open).assumption);
  assert.equal(asked.id, groupId);
  assert.equal(asked.ifConfirmed, "use-observable");
  assert.match(asked.question, /`open` and `error` are written together in Panel's handlers/u);
  assert.match(asked.question, /A "yes" converts `open` into one observable object/u);
  assert.match(asked.question, /`error` is not converted by this answer \(render-cut-unproven\)/u);
  assert.deepEqual(asked.members, [
    { name: "open", outcome: "use-observable" },
    { name: "error", nextBlocker: "render-cut-unproven", outcome: "review-state" },
  ]);
  const partner = requireValue(requireValue(error).assumption);
  assert.equal(partner.id, groupId);
  assert.equal(partner.ifConfirmed, "review-state");
});

test("a confirmed group converts its provable members as a cluster and chains the rest to their next question", () => {
  const id = "src/panel.tsx::Panel::{open,error}::atomic-transition-unproven";
  const [open, error] = states(
    CO_WRITTEN_DRAWER,
    new ConfirmationSet([{ answer: "yes", id, note: "audited 2026-09-06" }]),
  );
  const converted = requireValue(open);
  assert.equal(converted.action, "use-observable");
  assert.equal(converted.disposition, "change");
  assert.equal(converted.confidence, "probable");
  assert.equal(converted.abstentionReason, undefined);
  assert.match(
    converted.message,
    /^Replace the co-written React states \(`open`\) with one component-lifetime observable object/u,
  );
  assert.equal(requireValue(converted.assumption).status, "confirmed");
  assert.deepEqual(converted.group, {
    id,
    kind: "state-cluster",
    members: ["open"],
    primary: true,
  });
  assert.match(
    requireValue(converted.evidence.at(-1)),
    /^assumption confirmed by src\/panel\.tsx::Panel::\{open,error\}::atomic-transition-unproven: /u,
  );
  const chained = requireValue(error);
  assert.equal(chained.action, "review-state");
  assert.equal(chained.abstentionReason, "render-cut-unproven");
  assert.equal(
    requireValue(chained.assumption).id,
    "src/panel.tsx::Panel::error::render-cut-unproven",
  );
  assert.equal(requireValue(chained.assumption).status, "open");
  assert.match(requireValue(chained.evidence.at(-1)), /^assumption confirmed by .*\{open,error\}/u);
});

test("a rejected assumption keeps the review verdict and stops asking", () => {
  const id = "src/panel.tsx::Panel::filter::render-cut-unproven";
  const [filter] = states(FILTERED_LIST, new ConfirmationSet([{ answer: "no", id }]));
  const kept = requireValue(filter);
  assert.equal(kept.action, "review-state");
  assert.equal(kept.disposition, "candidate");
  assert.equal(requireValue(kept.assumption).status, "rejected");
});

test("unrelated confirmations change nothing", () => {
  const [filter] = states(
    FILTERED_LIST,
    new ConfirmationSet([
      { answer: "yes", id: "src/other.tsx::Other::filter::render-cut-unproven" },
    ]),
  );
  assert.equal(requireValue(filter).action, "review-state");
  assert.equal(requireValue(requireValue(filter).assumption).status, "open");
});

test("small owners and unconfirmable blockers carry no question", () => {
  const [small] = states(`
    import { useState } from "react";
    export function Tiny() {
      const [n, setN] = useState(0);
      return <button onClick={() => setN(n + 1)}>{n}</button>;
    }
  `);
  assert.equal(requireValue(small).action, "keep-state");
  assert.equal(requireValue(small).assumption, undefined);
  const [callable] = states(`
    import { useState } from "react";
    export function Panel() {
      const [render, setRender] = useState<(() => JSX.Element) | null>(null);
      return <main>${CHROME}<Slot render={render} />{render ? render() : null}<button onClick={() => setRender(null)} /></main>;
    }
  `);
  assert.equal(requireValue(callable).action, "review-state");
  assert.equal(requireValue(callable).assumption, undefined);
});

test("a group question ranks once, carried by its first member", () => {
  const findings = states(CO_WRITTEN_DRAWER);
  const ranked = rankedQuestions(findings);
  assert.equal(ranked.length, 1);
  assert.equal(requireValue(ranked[0]).name, "open");
  assert.equal(requireValue(ranked[0]).rank, 1);
  assert.equal(requireValue(ranked[0]).priority, 16 * 2);
});

test("when one assumed fact leaves another blocker, both are asked in one two-fact question", () => {
  const [value] = states(`
    import { useState } from "react";
    export function Panel() {
      const [value, setValue] = useState("");
      const form = useFancyForm({ value, onChange: setValue });
      return <main>${CHROME}
        <Editor {...form} />
        <p>{value.length} characters</p>
        <span>{value ? "dirty" : "clean"}</span>
      </main>;
    }
  `);
  const found = requireValue(value);
  assert.equal(found.abstentionReason, "ownership-flow-unresolved");
  const assumption = requireValue(found.assumption);
  assert.deepEqual(assumption.facts, ["ownership-flow-unresolved", "render-cut-unproven"]);
  assert.equal(
    assumption.id,
    "src/panel.tsx::Panel::value::ownership-flow-unresolved+render-cut-unproven",
  );
  assert.equal(assumption.ifConfirmed, "use-observable");
  assert.match(assumption.question, /escapes to code this analysis cannot follow/u);
  assert.match(
    assumption.question,
    /Additionally, `value` is read 3 times in the render of Panel/u,
  );
  assert.ok(
    assumption.research.some((step) =>
      /handed to code the analysis cannot follow/u.test(step.check),
    ),
  );
  assert.ok(assumption.research.some((step) => /read in render here/u.test(step.check)));
});

const MOUNT_AND_TITLE = `
  import { useEffect, useState } from "react";
  export function Panel() {
    const [filter, setFilter] = useState("");
    useEffect(() => { analytics.track("panel-open"); warmCache(); }, []);
    useEffect(() => { document.title = filter ? "filtered" : "all"; }, [filter]);
    return <main>${CHROME}
      <input value={filter} onChange={(e) => setFilter(e.target.value)} />
      <p>{filter ? "filtered" : "all"}</p>
    </main>;
  }
`;

function effects(source: string, confirmations: ConfirmationSet | null = null): HookFinding[] {
  return analyzeSourceWith(source, "src/panel.tsx", { confirmations }).filter(
    (finding) => finding.hook === "useEffect",
  );
}

test("an empty-dependency setup effect asks whether useMount's once-only semantics are intended", () => {
  const [mount] = effects(MOUNT_AND_TITLE);
  const found = requireValue(mount);
  assert.equal(found.abstentionReason, "lifecycle-equivalence-unproven");
  const assumption = requireValue(found.assumption);
  assert.equal(assumption.id, "src/panel.tsx::Panel::useEffect@L5::lifecycle-equivalence-unproven");
  assert.equal(assumption.ifConfirmed, "use-mount");
  assert.deepEqual(assumption.facts, ["lifecycle-equivalence-unproven"]);
  assert.match(assumption.question, /replacing it with `useMount`/u);
  assert.equal(requireValue(assumption.research[0]).line, 5);
  assert.match(
    requireValue(assumption.research[1]).check,
    /idempotent or intentionally once-only/u,
  );
  const confirmed = requireValue(
    effects(
      MOUNT_AND_TITLE,
      new ConfirmationSet([
        { answer: "yes", fingerprint: assumption.fingerprint, id: assumption.id },
      ]),
    )[0],
  );
  assert.equal(confirmed.action, "use-mount");
  assert.equal(confirmed.disposition, "change");
  assert.match(requireValue(confirmed.evidence.at(-1)), /^assumption confirmed by .*useEffect@L5/u);
});

test("an effect waiting on a state's verdict names the state's open question", () => {
  const [, title] = effects(MOUNT_AND_TITLE);
  const found = requireValue(title);
  assert.equal(found.abstentionReason, "effect-causal-owner-unresolved");
  assert.deepEqual(found.waitsOn, ["src/panel.tsx::Panel::filter::render-cut-unproven"]);
  assert.equal(found.assumption, undefined);
});

test("a confirmed conversion carries the runtime verification recipe", () => {
  const id = "src/panel.tsx::Panel::filter::render-cut-unproven";
  const [filter] = states(FILTERED_LIST, new ConfirmationSet([{ answer: "yes", id }]));
  const verification = requireValue(requireValue(filter).verification);
  assert.equal(verification.harness, "legend-doctor/runtime");
  assert.match(verification.expect, /renders of the owner per update drop/u);
  assert.match(requireValue(verification.steps[0]), /mountDom, count/u);
  assert.match(
    requireValue(verification.steps[1]),
    /apply use-observable from the finding in src\/panel\.tsx/u,
  );
  assert.match(requireValue(verification.steps[4]), /change it to "no" and revert the edit/u);
  const [open] = states(FILTERED_LIST);
  assert.equal(requireValue(open).verification, undefined);
});

test("without a child-contract resolver, the leaf-wrap rewrite is the confirmable fact for a transported state", () => {
  const [open] = states(`
    import { useState } from "react";
    export function Panel() {
      const [open, setOpen] = useState(false);
      return <main>${CHROME}
        <button onClick={() => setOpen(true)}>Open</button>
        <Popover open={open} onOpenChange={setOpen} anchor="top" />
        {open ? <Backdrop /> : null}
      </main>;
    }
  `);
  const found = requireValue(open);
  assert.equal(found.abstentionReason, "child-contract-unresolved");
  const assumption = requireValue(found.assumption);
  assert.deepEqual(assumption.facts, ["child-contract-unresolved"]);
  assert.equal(assumption.ifConfirmed, "use-observable");
  assert.match(
    assumption.question,
    /^`open` still reaches 1 render read site and 2 transport call sites \(`Popover`\) in Panel/u,
  );
  assert.match(assumption.question, /each receiving component renders the value directly/u);
  assert.ok(assumption.research.some((step) => /passed to a child here/u.test(step.check)));
});
