import type { HookFinding } from "../../../src/core/types.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import test from "node:test";
import { withProject } from "../with-project.js";

const CHROME = "<i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i />";

async function openVerdict(parent: string, imports: string): Promise<HookFinding> {
  let finding: HookFinding | undefined = undefined;
  const screen = `
    import { useState } from "react";
    import { Button } from "@acme/button";
    ${imports}
    export function Screen() {
      const [open, setOpen] = useState(false);
      return (
        <main>
          ${CHROME}
          <button onClick={() => setOpen(true)}>Open</button>
          <${parent}><Button aria-expanded={open} onClick={() => setOpen(false)} /></${parent.split(" ")[0]}>
        </main>
      );
    }
  `;
  await withProject({ "screen.tsx": screen }, async (root) => {
    const report = await analyzePath(root);
    finding = report.findings.find(
      (candidate) => candidate.hook === "useState" && candidate.name === "open",
    );
  });
  assert.ok(finding, "missing state open");
  return finding;
}

test("keeps a returned call site under review when its parent slots it through asChild", async () => {
  const finding = await openVerdict(
    "PopoverTrigger asChild",
    `import { PopoverTrigger } from "@radix-ui/react-popover";`,
  );
  assert.notEqual(finding.action, "use-observable");
});

test("still wraps a returned call site whose parent is a host element", async () => {
  const finding = await openVerdict(`div className="slot"`, "");
  assert.equal(finding.action, "use-observable");
  assert.match(finding.message, /extract one stable call-site leaf wrapper around `Button`/u);
});
