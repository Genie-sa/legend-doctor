import type { HookFinding } from "../../../src/core/types.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import test from "node:test";
import { withProject } from "../with-project.js";

const CHROME = "<i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i />";

interface ScreenFixture {
  readonly chrome?: string;
  readonly imports: string;
  readonly open?: string;
  readonly site: string;
}

/** The call site sits in a hoisted element, as in a list header, so no returned-call-site cut applies. */
function screen({ chrome = CHROME, imports, open = "setOpen(true)", site }: ScreenFixture): string {
  return `
    import { useState } from "react";
    ${imports}
    export function Screen() {
      const [open, setOpen] = useState(false);
      const header = (
        <header>
          <button onClick={() => ${open}}>Open</button>
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

const SHEET_SITE = `<Sheet open={open} onClose={() => setOpen(false)} />`;

async function openVerdict(files: Readonly<Record<string, string>>): Promise<HookFinding> {
  let finding: HookFinding | undefined = undefined;
  await withProject(files, async (root) => {
    const report = await analyzePath(root);
    finding = report.findings.find(
      (candidate) => candidate.hook === "useState" && candidate.name === "open",
    );
  });
  assert.ok(finding, "missing state open");
  return finding;
}

test("wraps an external component call site whose host parent passes the wrapper through", async () => {
  const finding = await openVerdict({
    "screen.tsx": screen({
      imports: `import { Sheet } from "@acme/sheet";`,
      site: `<div className="slot">${SHEET_SITE}</div>`,
    }),
  });
  assert.equal(finding.action, "use-observable");
  assert.match(finding.message, /wrap the stable `Sheet` call site in a leaf subscriber/u);
  assert.match(finding.message, /owner-side contract is verified/u);
});

test("follows local components that only spread their props down to a host element", async () => {
  const finding = await openVerdict({
    "box.tsx": `export function Box(props) { return <div {...props} />; }`,
    "field.tsx": `
      import { Box } from "./box";
      export function Field({ className, ...props }) {
        return <Box data-field className={className} {...props} />;
      }
    `,
    "screen.tsx": screen({
      imports: `import { Field } from "./field";\nimport { Sheet } from "@acme/sheet";`,
      site: `<Field>${SHEET_SITE}</Field>`,
    }),
  });
  assert.equal(finding.action, "use-observable");
});

test("abstains when a local parent forwards its children into an unresolved component", async () => {
  const finding = await openVerdict({
    "field.tsx": `
      import { Picker } from "@acme/picker";
      export function Field(props) { return <Picker {...props} />; }
    `,
    "screen.tsx": screen({
      imports: `import { Field } from "./field";\nimport { Sheet } from "@acme/sheet";`,
      site: `<Field>${SHEET_SITE}</Field>`,
    }),
  });
  assert.notEqual(finding.action, "use-observable");
});

test("abstains when the parent slots its child through asChild", async () => {
  const external = await openVerdict({
    "screen.tsx": screen({
      imports: `import { PopoverTrigger } from "@radix-ui/react-popover";\nimport { Button } from "@acme/button";`,
      site: `<PopoverTrigger asChild><Button aria-expanded={open} onClick={() => setOpen(false)} /></PopoverTrigger>`,
    }),
  });
  assert.notEqual(external.action, "use-observable");
  const local = await openVerdict({
    "popover.tsx": `
      import * as PopoverPrimitive from "@radix-ui/react-popover";
      export function PopoverTrigger(props) { return <PopoverPrimitive.Trigger {...props} />; }
    `,
    "screen.tsx": screen({
      imports: `import { PopoverTrigger } from "./popover";\nimport { Button } from "@acme/button";`,
      site: `<PopoverTrigger asChild><Button aria-expanded={open} onClick={() => setOpen(false)} /></PopoverTrigger>`,
    }),
  });
  assert.notEqual(local.action, "use-observable");
});

test("abstains when the call site is the element a scroll view clones as its refreshControl", async () => {
  const finding = await openVerdict({
    "package.json": JSON.stringify({ dependencies: { "react-native": "0.83.0" }, name: "app" }),
    "screen.tsx": screen({
      imports: `import { ScrollView } from "react-native";\nimport { RefreshControl } from "react-native-gesture-handler";`,
      site: `<ScrollView refreshControl={<RefreshControl refreshing={open} onRefresh={() => setOpen(false)} />} />`,
    }),
  });
  assert.notEqual(finding.action, "use-observable");
});

test("abstains when a transition writes the value a suspending child receives", async () => {
  const finding = await openVerdict({
    "details.tsx": `
      import { use } from "react";
      import { loadDetails } from "./load-details";
      export function Details({ open }) {
        return <p>{open ? use(loadDetails()) : null}</p>;
      }
    `,
    "screen.tsx": screen({
      imports: `import { startTransition } from "react";\nimport { Details } from "./details";`,
      open: "startTransition(() => setOpen(true))",
      site: `<div>${SHEET_SITE.replace("Sheet", "Details")}</div>`,
    }),
  });
  assert.notEqual(finding.action, "use-observable");
});

test("abstains when the owner is too small for the cut to matter", async () => {
  const finding = await openVerdict({
    "screen.tsx": screen({
      chrome: "<i />",
      imports: `import { Sheet } from "@acme/sheet";`,
      site: `<div>${SHEET_SITE}</div>`,
    }),
  });
  assert.notEqual(finding.action, "use-observable");
});
