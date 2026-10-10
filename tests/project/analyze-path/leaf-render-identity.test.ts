import type { HookFinding } from "../../../src/core/types.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import test from "node:test";
import { withProject } from "../with-project.js";

const CHROME =
  "<Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />";

const LEAF_BODIES = {
  identity: `<span data-current={value === current}>{String(value)}</span>`,
  memberIdentity: `<span data-current={value?.id === current?.id}>{String(value)}</span>`,
  hostKey: `<span key={value}>{String(value)}</span>`,
  literal: `<span data-empty={value === null}>{String(value)}</span>`,
  plain: `<span>{String(value)}</span>`,
} as const;

type LeafBody = keyof typeof LEAF_BODIES;

interface DashboardFixture {
  readonly declaration: string;
  readonly leaf: LeafBody;
  readonly write: string;
}

function leaf(body: LeafBody): string {
  return `
    export function Selected({ value, current }: { value: any; current: any }) {
      return ${LEAF_BODIES[body]};
    }
  `;
}

/** Every read sits in a JSX site of a broad owner, so the site-subscription verdict applies. */
function dashboard({ declaration, write }: Omit<DashboardFixture, "leaf">): string {
  return `
    import { useState } from "react";
    import { Selected } from "./Selected";
    type Item = { id: string };
    export function Dashboard({ items, current }: { items: Item[]; current: Item | null }) {
      const [selected, setSelected] = ${declaration};
      return (
        <section>
          ${CHROME}
          <p>{selected ? "Chosen" : "None"}</p>
          <Selected value={selected} current={current} />
          <button onClick={() => setSelected(${write})}>Pick</button>
        </section>
      );
    }
  `;
}

async function selectedVerdict(fixture: DashboardFixture): Promise<HookFinding> {
  let finding: HookFinding | undefined = undefined;
  await withProject(
    { "Dashboard.tsx": dashboard(fixture), "Selected.tsx": leaf(fixture.leaf) },
    async (root) => {
      const report = await analyzePath(root);
      finding = report.findings.find(
        (candidate) => candidate.hook === "useState" && candidate.name === "selected",
      );
    },
  );
  assert.ok(finding, "missing state selected");
  return finding;
}

const OBJECT_STATE = { declaration: "useState<Item | null>(null)", write: "items[0] ?? null" };
const PRIMITIVE_STATE = { declaration: `useState("")`, write: `"first"` };
const SITE_SUBSCRIPTION = /subscribe at its 2 render sites/u;

/** React coerces a key to a string, so a structurally equal object yields the same key. */
test("subscribes an object value at a leaf that renders it without comparing its identity", async () => {
  for (const body of ["plain", "literal", "hostKey"] satisfies LeafBody[]) {
    const finding = await selectedVerdict({ ...OBJECT_STATE, leaf: body });
    assert.equal(finding.action, "use-observable", body);
    assert.match(finding.message, SITE_SUBSCRIPTION, body);
  }
});

test("keeps an object value from a leaf that compares its identity with another value", async () => {
  for (const body of ["identity", "memberIdentity"] satisfies LeafBody[]) {
    const finding = await selectedVerdict({ ...OBJECT_STATE, leaf: body });
    assert.notEqual(finding.action, "use-observable", body);
  }
});

function picker(body: LeafBody): string {
  return `
    type Item = { id: string };
    export function Picker({ value, current, onPick }: { value: any; current: any; onPick: (next: Item | false) => void }) {
      return <div><button onClick={() => onPick({ id: "next" })}>Pick</button>${LEAF_BODIES[body]}</div>;
    }
  `;
}

/** The owner never reads the value and hands the setter to the leaf, so the broad transport verdict applies. */
function header(declaration: string): string {
  return `
    import { useState } from "react";
    import { Picker } from "./Picker";
    type Item = { id: string };
    export function Screen({ current }: { current: Item | null }) {
      const [selected, setSelected] = ${declaration};
      const header = (
        <header>
          <button onClick={() => setSelected(false)}>Clear</button>
          <div><Picker value={selected} current={current} onPick={setSelected} /></div>
        </header>
      );
      return <main>${CHROME}<i /><i />{header}</main>;
    }
  `;
}

async function transportVerdict(declaration: string, body: LeafBody): Promise<HookFinding> {
  let finding: HookFinding | undefined = undefined;
  await withProject(
    { "Picker.tsx": picker(body), "Screen.tsx": header(declaration) },
    async (root) => {
      const report = await analyzePath(root);
      finding = report.findings.find(
        (candidate) => candidate.hook === "useState" && candidate.name === "selected",
      );
    },
  );
  assert.ok(finding, "missing state selected");
  return finding;
}

test("keeps an object value a forwarded setter writes from a leaf that compares its identity", async () => {
  const objectState = "useState<Item | false>(false)";
  const plain = await transportVerdict(objectState, "plain");
  assert.equal(plain.action, "use-observable");
  assert.match(plain.message, /child contract is verified/u);
  const identity = await transportVerdict(objectState, "identity");
  assert.notEqual(identity.action, "use-observable");
  const primitive = await transportVerdict("useState(false)", "identity");
  assert.equal(primitive.action, "use-observable");
});

test("subscribes a primitive value at a leaf that compares it with another value", async () => {
  for (const body of ["identity", "memberIdentity", "plain"] satisfies LeafBody[]) {
    const finding = await selectedVerdict({ ...PRIMITIVE_STATE, leaf: body });
    assert.equal(finding.action, "use-observable", body);
    assert.match(finding.message, SITE_SUBSCRIPTION, body);
  }
});
