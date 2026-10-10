import type { HookFinding } from "../../../src/core/types.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import test from "node:test";
import { withProject } from "../with-project.js";

const CHROME = "<i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i />";

interface ScreenFixture {
  readonly before?: string;
  readonly imports?: string;
  readonly initial?: string;
  readonly sites: string;
}

/** Two `Sheet` call sites that share no smaller JSX slot than the owner's whole output. */
function screen({
  before = "",
  imports = `import { Sheet } from "@acme/sheet";`,
  initial = "false",
  sites,
}: ScreenFixture): string {
  return `
    import { useState } from "react";
    ${imports}
    export function Screen({ ready, id, items, custom }) {
      const [open, setOpen] = useState(${initial});
      ${before}
      return (
        <main>
          ${CHROME}
          <button onClick={() => setOpen(true)}>Open</button>
          ${sites}
        </main>
      );
    }
  `;
}

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

const LEAF_WRAP = /wrap each of the 2 stable `Sheet` call sites in a leaf subscriber/u;

test("wraps conditional and keyed call sites whose guards and keys do not read the state", async () => {
  const sites = {
    otherTypeArm: `{ready ? <Sheet open={open} /> : <p />}<div>{id && <Sheet open={open} />}</div>`,
    emptyArm: `{ready ? <Sheet open={open} /> : null}<div>{ready && id && <div><Sheet open={open} /></div>}</div>`,
    keyed: `<Sheet key={id} open={open} /><div>{ready && <Sheet open={open} />}</div>`,
  } satisfies Record<string, string>;
  for (const [name, fixture] of Object.entries(sites)) {
    const finding = await openVerdict({ "screen.tsx": screen({ sites: fixture }) });
    assert.equal(finding.action, "use-observable", name);
    assert.match(finding.message, LEAF_WRAP, name);
  }
});

test("keeps the mount-identity review when a wrapper could change which fiber mounts", async () => {
  const sites = {
    sameTypeArms: `{ready ? <Sheet open={open} /> : <Sheet open={false} />}<div>{id && <Sheet open={open} />}</div>`,
    sameTypeParents: `{ready ? <div><Sheet open={open} /></div> : <div><Sheet open={false} /></div>}<div>{id && <Sheet open={open} />}</div>`,
    unknownArm: `{ready ? <Sheet open={open} /> : custom}<div>{id && <Sheet open={open} />}</div>`,
    fallbackOperand: `{custom ?? <Sheet open={open} />}<div>{id && <Sheet open={open} />}</div>`,
    orOperand: `{custom || <Sheet open={open} />}<div>{id && <Sheet open={open} />}</div>`,
    guardReadsState: `{open && <Sheet open={open} />}<div>{id && <Sheet open={open} />}</div>`,
    keyReadsState: `<Sheet key={String(open)} open={open} /><div>{ready && <Sheet open={open} />}</div>`,
    indexKeyedRows: `{items.map((item, index) => <Sheet key={index} title={item} open={open} />)}`,
  } satisfies Record<string, string>;
  for (const [name, fixture] of Object.entries(sites)) {
    const finding = await openVerdict({ "screen.tsx": screen({ sites: fixture }) });
    assert.equal(finding.action, "review-state", name);
    assert.equal(finding.abstentionReason, "mount-identity-unproven", name);
  }
});

test("keeps the review when another return renders the same type in the call site's slot", async () => {
  const sites = `{ready ? <Sheet open={open} /> : <p />}<div>{id && <Sheet open={open} />}</div>`;
  const verdict = (otherReturn: string): Promise<HookFinding> =>
    openVerdict({
      "screen.tsx": screen({ before: `if (!items) { return ${otherReturn}; }`, sites }),
    });
  const sameSlot = await verdict(
    `<main>${CHROME}<button>Open</button><Sheet open={false} /></main>`,
  );
  assert.equal(sameSlot.abstentionReason, "mount-identity-unproven");
  const otherSlot = await verdict(`<main><Sheet open={false} /></main>`);
  assert.match(otherSlot.message, LEAF_WRAP);
  const empty = await verdict("null");
  assert.match(empty.message, LEAF_WRAP);
});

test("does not wrap a conditional call site that receives an object state", async () => {
  const finding = await openVerdict({
    "screen.tsx": screen({
      initial: "{ visible: false }",
      sites: `{ready ? <Sheet open={open} /> : <p />}<div>{id && <Sheet open={open} />}</div>`,
    }),
  });
  assert.doesNotMatch(finding.message, LEAF_WRAP);
});

test("never moves state into a wrapper that mounts with the condition", async () => {
  const finding = await openVerdict({
    "screen.tsx": `
      import { useState } from "react";
      import { Settings } from "@acme/settings";
      export function Screen({ ready }) {
        const [open, setOpen] = useState(false);
        return (
          <main>
            ${CHROME}
            <section>{ready && <div><Settings open={open} setOpen={setOpen} /></div>}</section>
          </main>
        );
      }
    `,
  });
  assert.notEqual(finding.action, "move-state-down");
});

test("subscribes a conditional leaf consumer next to the owner's own render reads", async () => {
  const badge = `export function Badge({ value }: { value: boolean }) { return <b>{value ? "On" : "Off"}</b>; }`;
  const verdict = (sites: string): Promise<HookFinding> =>
    openVerdict({
      "badge.tsx": badge,
      "screen.tsx": screen({ imports: `import { Badge } from "./badge";`, sites }),
    });
  const gated = await verdict(`<p>{open ? "Open" : "Closed"}</p>{ready && <Badge value={open} />}`);
  assert.equal(gated.action, "use-observable");
  assert.match(gated.message, /passes the same plain value \(<Badge> call site/u);
  const sameType = await verdict(
    `<p>{open ? "Open" : "Closed"}</p>{ready ? <Badge value={open} /> : <Badge value={false} />}`,
  );
  assert.doesNotMatch(sameType.message, /<Badge> call site/u);
});
