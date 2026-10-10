import type { HookFinding } from "../../../src/core/types.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import test from "node:test";
import { withProject } from "../with-project.js";

const STATUS_LEAF =
  "export function StatusLeaf({ value }: { value: unknown }) { return <span>{String(value)}</span>; }";
const SLOT_TRIGGER = `
  import { Slot } from "@radix-ui/react-slot";
  export function Trigger({ children }: { children: React.ReactNode }) { return <Slot data-trigger>{children}</Slot>; }
`;
const LEAF_SITE = "<StatusLeaf value={value} />";
const CHROME = "<i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i />";
const PRIMITIVE_STATE = `[value, setValue] = useState("")`;

interface ScreenFixture {
  readonly chrome?: string;
  readonly declaration: string;
  readonly file?: string;
  readonly imports?: string;
  readonly setup?: string;
  readonly site?: string;
  readonly write?: string;
}

/** The call site sits in a hoisted element, as in a list header, so no returned-call-site cut applies. */
function screen({
  chrome = CHROME,
  declaration,
  imports = `import { StatusLeaf } from "./StatusLeaf";`,
  setup = "",
  site = LEAF_SITE,
  write = "setValue(next)",
}: ScreenFixture): string {
  return `
    import { useEffect, useState } from "react";
    ${imports}
    export function Screen({ next }) {
      const ${declaration};
      ${setup}
      const header = (
        <header>
          <button onClick={() => ${write}}>Apply</button>
          ${site}
        </header>
      );
      return (
        <main>
          ${chrome}
          {header}
        </main>
      );
    }
  `;
}

async function valueVerdict(
  fixture: ScreenFixture,
  extraFiles: Readonly<Record<string, string>> = {},
): Promise<HookFinding> {
  let finding: HookFinding | undefined = undefined;
  await withProject(
    {
      "StatusLeaf.tsx": STATUS_LEAF,
      [fixture.file ?? "Screen.tsx"]: screen(fixture),
      ...extraFiles,
    },
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
  "a string literal initializer": PRIMITIVE_STATE,
  "a literal union type argument": `[value, setValue] = useState<"idle" | "busy">("idle")`,
  "a nullable number type argument": "[value, setValue] = useState<number | null>(null)",
  "an optional string type argument": "[value, setValue] = useState<string>()",
};

for (const [name, declaration] of Object.entries(PROVABLY_PRIMITIVE_STATES)) {
  test(`wraps a verified leaf for a non-literal write to state with ${name}`, async () => {
    const finding = await valueVerdict({ declaration });
    assert.equal(finding.action, "use-observable", name);
    assert.match(finding.message, /child contract is verified/u);
  });
}

test("wraps a verified leaf for a non-literal write from a listener its effect registers", async () => {
  const finding = await valueVerdict({
    declaration: "[value, setValue] = useState(0)",
    setup: `useEffect(() => {
      const sync = () => setValue(window.innerWidth);
      sync();
      window.addEventListener("resize", sync);
      return () => window.removeEventListener("resize", sync);
    }, []);`,
  });
  assert.equal(finding.action, "use-observable");
});

test("wraps a pass-through call site for a non-literal write to primitive state", async () => {
  const finding = await valueVerdict({
    declaration: PRIMITIVE_STATE,
    imports: `import { Sheet } from "@acme/sheet";`,
    site: `<div className="slot"><Sheet title={value} /></div>`,
  });
  assert.equal(finding.action, "use-observable");
  assert.match(finding.message, /owner-side contract is verified/u);
});

const UNPROVEN_STATES = {
  "an object type argument": {
    declaration: "[value, setValue] = useState<{ id: string } | null>(null)",
  },
  "a type argument with a function member": {
    declaration: `[value, setValue] = useState<string | (() => void)>("")`,
  },
  "a type argument naming an unresolved type": {
    declaration: `[value, setValue] = useState<Mode>("idle")`,
  },
  "an unannotated lazy initializer": {
    declaration: "[value, setValue] = useState(() => readValue())",
  },
  "an unannotated null initializer": {
    declaration: "[value, setValue] = useState(null)",
  },
  "a literal initializer in a JavaScript file": {
    declaration: "[value, setValue] = useState(0)",
    file: "Screen.jsx",
  },
  "an updater write": {
    declaration: PRIMITIVE_STATE,
    write: "setValue(() => next)",
  },
  "a write with a spread argument": {
    declaration: PRIMITIVE_STATE,
    write: "setValue(...next)",
  },
  "a write in an effect body": {
    declaration: PRIMITIVE_STATE,
    setup: "useEffect(() => setValue(next), [next]);",
  },
  "a companion write the owner renders": {
    declaration: PRIMITIVE_STATE,
    setup: "const [page, setPage] = useState(1);",
    site: `${LEAF_SITE}<p>{page}</p>`,
    write: "{ setValue(next); setPage(2); }",
  },
  "an owner below the materiality threshold": {
    chrome: "<i />",
    declaration: PRIMITIVE_STATE,
  },
};

for (const [name, fixture] of Object.entries(UNPROVEN_STATES)) {
  test(`does not wrap a leaf for a non-literal write given ${name}`, async () => {
    const finding = await valueVerdict(fixture);
    assert.notEqual(finding.action, "use-observable", name);
  });
}

test("does not wrap a verified leaf for a non-literal write when a Slot parent reads it", async () => {
  const finding = await valueVerdict(
    {
      declaration: PRIMITIVE_STATE,
      imports: `import { StatusLeaf } from "./StatusLeaf";\nimport { Trigger } from "./Trigger";`,
      site: `<Trigger>${LEAF_SITE}</Trigger>`,
    },
    { "Trigger.tsx": SLOT_TRIGGER },
  );
  assert.notEqual(finding.action, "use-observable");
});
