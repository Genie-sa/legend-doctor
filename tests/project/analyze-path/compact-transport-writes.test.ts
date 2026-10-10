import type { HookFinding } from "../../../src/core/types.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import test from "node:test";
import { withProject } from "../with-project.js";

const CHROME = "<i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i />";
const DETAILS =
  "export function Details({ value }: { value: unknown }) { return <span>{String(value)}</span>; }";
const COMMAND_SITE = `
  <button onClick={() => setValue(next)}>Apply</button>
  <div className="slot"><Details value={value} /></div>
`;
const CONTROLLED_SITE = "{enabled && <Details value={value} onChange={setValue} />}";
const CALL_SITE_LEAF = /extract one stable call-site leaf wrapper around `Details`/u;
const CALL_SITE_OWNED = /wrap the branch-local `Details` call site/u;

interface ScreenFixture {
  readonly declaration: string;
  readonly file?: string;
  readonly helpers?: string;
  readonly site?: string;
}

/** The call site is returned directly, so a returned-call-site cut is the verdict that applies. */
function screen({ declaration, helpers = "", site = COMMAND_SITE }: ScreenFixture): string {
  return `
    import { useState } from "react";
    import { Details } from "./Details";
    ${helpers}
    export function Screen({ enabled, next }) {
      const [value, setValue] = ${declaration};
      return (
        <main>
          ${CHROME}
          ${site}
        </main>
      );
    }
  `;
}

async function valueVerdict(fixture: ScreenFixture): Promise<HookFinding> {
  let finding: HookFinding | undefined = undefined;
  await withProject(
    { "Details.tsx": DETAILS, [fixture.file ?? "Screen.tsx"]: screen(fixture) },
    async (root) => {
      const report = await analyzePath(root);
      finding = report.findings.find(
        (candidate) => candidate.hook === "useState" && candidate.name === "value",
      );
    },
  );
  assert.ok(finding, "missing state value");
  return finding;
}

const PROVABLY_PRIMITIVE_STATES = {
  "a nullable number type argument": { declaration: "useState<number | null>(null)" },
  "a string literal initializer": { declaration: `useState("")` },
  "a null initializer and only boolean literal writes": {
    declaration: "useState(null)",
    file: "Screen.jsx",
    site: COMMAND_SITE.replace("setValue(next)", "setValue(true)"),
  },
} satisfies Readonly<Record<string, ScreenFixture>>;

for (const [name, fixture] of Object.entries(PROVABLY_PRIMITIVE_STATES)) {
  test(`wraps the returned call site for writes to state with ${name}`, async () => {
    const finding = await valueVerdict(fixture);
    assert.equal(finding.action, "use-observable", name);
    assert.match(finding.message, CALL_SITE_LEAF);
  });
}

test("keeps a returned call site's write that a helper runs inside a transition in React", async () => {
  const helpers = `
    import { startTransition } from "react";
    function inTransition(update: () => void) { startTransition(update); }
    function run(update: () => void) { update(); }
  `;
  const handedTo = (helper: string): ScreenFixture => ({
    declaration: `useState("")`,
    helpers,
    site: COMMAND_SITE.replace("setValue(next)", `${helper}(() => setValue(next))`),
  });
  const urgent = await valueVerdict(handedTo("run"));
  assert.equal(urgent.action, "use-observable");
  assert.match(urgent.message, CALL_SITE_LEAF);
  const transitioned = await valueVerdict(handedTo("inTransition"));
  assert.equal(transitioned.action, "review-state");
  assert.equal(transitioned.abstentionReason, "react-commit-sensitive");
});

test("keeps call-site-owned primitive state above a controlled leaf", async () => {
  const finding = await valueVerdict({ declaration: "useState(false)", site: CONTROLLED_SITE });
  assert.equal(finding.action, "use-observable");
  assert.match(finding.message, CALL_SITE_OWNED);
});

const OBJECT_ADMITTING_STATES = {
  "an object type argument": { declaration: "useState<{ id: string } | null>(null)" },
  "an array type argument": { declaration: "useState<string[] | null>(null)" },
  "a type argument naming an unresolved type": { declaration: "useState<Selection | null>(null)" },
  "an unannotated null initializer in a JavaScript file": {
    declaration: "useState(null)",
    file: "Screen.jsx",
  },
} satisfies Readonly<Record<string, ScreenFixture>>;

for (const [name, fixture] of Object.entries(OBJECT_ADMITTING_STATES)) {
  test(`does not wrap the returned call site for value writes to ${name}`, async () => {
    const finding = await valueVerdict(fixture);
    assert.notEqual(finding.action, "use-observable", name);
  });

  test(`does not isolate a controlled leaf for state with ${name}`, async () => {
    const finding = await valueVerdict({ ...fixture, site: CONTROLLED_SITE });
    assert.notEqual(finding.action, "use-observable", name);
  });
}
