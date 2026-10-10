import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { HookFinding } from "../../src/core/types.js";
import { analyzePath } from "../../src/project/analyze-path/analyze-path.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const CHROME =
  "<Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />";

const WRAP_SITE = /in `Computed`, reading the observable inside it/u;

const DIALOG =
  '<Dialog open={open} onOpenChange={(next) => setOpen(next)}><DialogTitle>{open ? "Editing" : "Closed"}</DialogTitle></Dialog>';

const MENU =
  '<div className="menu-anchor"><Button aria-expanded={open} onClick={() => setOpen(!open)}>Menu</Button>{open && <Menu onClose={() => setOpen(false)} />}</div>';

interface PanelFixture {
  readonly body: string;
  readonly imports?: string;
  readonly setup?: string;
}

function panel({ body, imports = "", setup = "" }: PanelFixture): string {
  return `
    import { useEffect, useRef, useState } from "react";
    import { Button, Dialog, DialogTitle, Menu, Tabs } from "@acme/ui";
    ${imports}
    export function Panel({ items }: { items: string[] }) {
      const [open, setOpen] = useState(false);
      ${setup}
      return (
        <section>
          ${CHROME}
          <button onClick={() => setOpen(true)}>Open</button>
          ${body}
        </section>
      );
    }
  `;
}

function dialogWith(title: string): string {
  return DIALOG.replace('{open ? "Editing" : "Closed"}', title);
}

function finding(source: string, name = "open"): HookFinding | undefined {
  return analyzeSource(source, "fixture.tsx").find(
    (candidate) => candidate.hook === "useState" && candidate.name === name,
  );
}

function assertNotWrapped(cases: Record<string, PanelFixture>): void {
  for (const [name, fixture] of Object.entries(cases)) {
    const result = finding(panel(fixture));
    assert.equal(result?.action, "review-state", name);
    assert.doesNotMatch(result?.message ?? "", WRAP_SITE, name);
  }
}

const CHILD_PARENTS = `
  import { Children, cloneElement, isValidElement } from "react";
  import type { ReactNode } from "react";
  export function Stack({ children }: { children: ReactNode }) {
    return <div className="stack">{children}</div>;
  }
  export function Mapped({ children }: { children: ReactNode }) {
    return <div>{Children.map(children, (child) => <span>{child}</span>)}</div>;
  }
  export function Cloned({ children }: { children: ReactNode }) {
    return <div>{Children.map(children, (child) => (isValidElement(child) ? cloneElement(child) : child))}</div>;
  }
  export function Typed({ children }: { children: ReactNode }) {
    return <div>{Children.toArray(children).filter((child) => isValidElement(child) && child.type !== "p")}</div>;
  }
`;

async function projectFinding(parent: string): Promise<HookFinding | undefined> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-wrap-site-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
    await writeFile(path.join(root, "src", "parents.tsx"), CHILD_PARENTS);
    await writeFile(
      path.join(root, "src", "panel.tsx"),
      panel({
        body: `<${parent}>${DIALOG}</${parent}>`,
        imports: `import { ${parent} } from "./parents";`,
      }),
    );
    const report = await analyzePath(root);
    return report.findings.find(
      (candidate) => candidate.hook === "useState" && candidate.name === "open",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("wraps an end-of-return controlled dialog in Computed", () => {
  const result = finding(panel({ body: DIALOG }));
  assert.equal(result?.action, "use-observable");
  assert.match(result?.message ?? "", /wrap the <Dialog> element at line 12 in `Computed`/u);
  assert.match(
    result?.message ?? "",
    /with 15 JSX elements, no longer renders when `open` changes/u,
  );
});

test("wraps a menu anchor whose trigger and gated menu both read the toggle", () => {
  const result = finding(panel({ body: MENU }));
  assert.equal(result?.action, "use-observable");
  assert.match(result?.message ?? "", /wrap the <div> element at line 12 in `Computed`/u);
  assert.match(result?.message ?? "", /Snapshot command reads with `\.peek\(\)`/u);
});

test("wraps under a parent that passes its children through, not one that inspects them", async () => {
  const passed = await projectFinding("Stack");
  assert.equal(passed?.action, "use-observable");
  assert.match(passed?.message ?? "", WRAP_SITE);
  for (const parent of ["Mapped", "Cloned", "Typed"]) {
    const inspected = await projectFinding(parent);
    assert.equal(inspected?.action, "review-state", parent);
    assert.doesNotMatch(inspected?.message ?? "", WRAP_SITE, parent);
  }
});

test("does not wrap a slot whose position comes from a list or an array", () => {
  assertNotWrapped({
    arrayChildren: {
      body: `<div>{[${DIALOG.replace("<Dialog ", '<Dialog key="a" ')}, <p key="b">B</p>]}</div>`,
    },
    mappedRows: { body: `<ul>{items.map((item) => <li key={item}>${DIALOG}</li>)}</ul>` },
  });
});

test("does not wrap when the toggle reaches an effect, a hook, or another slot", () => {
  assertNotWrapped({
    effectRead: {
      body: DIALOG,
      setup: "useEffect(() => { document.title = String(open); }, [open]);",
    },
    hookArgument: {
      body: DIALOG,
      imports: 'import { useLabel } from "./label";',
      setup: "const label = useLabel(open);",
    },
    secondSlot: { body: `${DIALOG}<footer>{open ? "on" : "off"}</footer>` },
  });
});

test("does not wrap when another state cannot convert and is written in another stretch", () => {
  const source = panel({
    body: `${DIALOG.replace(
      "(next) => setOpen(next)",
      '(next) => { void save().then((saved) => { setPath(saved); setOpen(next); void save().then(() => setPath("")); }); }',
    )}<p>{label}</p>`,
    imports: 'import { save } from "./save";',
    setup: 'const [path, setPath] = useState("");\nconst label = path.split("/").pop();',
  });
  const result = finding(source);
  assert.equal(result?.action, "review-state");
  assert.equal(result?.abstentionReason, "atomic-transition-unproven");

  assertNotWrapped({
    unboundCompanion: {
      body: DIALOG.replace(
        "(next) => setOpen(next)",
        "(next) => { setOpen(next); setTick((tick) => tick + 1); }",
      ),
      setup: "const [, setTick] = useState(0);",
    },
  });
});

test("wraps a slot that also renders another state, which the block reads fresh", () => {
  const result = finding(
    panel({
      body: `${dialogWith("{open ? count : 0}")}<button onClick={() => setCount(count + 1)}>More</button>`,
      setup: "const [count, setCount] = useState(0);",
    }),
  );
  assert.equal(result?.action, "use-observable");
  assert.match(result?.message ?? "", WRAP_SITE);
  const propDerived = panel({
    body: dialogWith("{open ? first : null}"),
    setup: "const first = items[0];",
  });
  assert.equal(finding(propDerived)?.action, "use-observable");
});

test("wraps unless an enclosing branch or another return can keep the slot's fiber", () => {
  assertNotWrapped({
    sameTagAlternate: {
      body: `{items.length > 0 ? ${DIALOG} : <Dialog open={false} onOpenChange={() => {}} />}`,
    },
    fallbackOperand: { body: `{items.length === 0 || ${DIALOG}}` },
    nullishOperand: { body: `{items[0] ?? ${DIALOG}}` },
    sameSlotReturn: {
      body: DIALOG,
      setup: `if (items.length === 0) {
        return <section>${CHROME}<button>Open</button><Dialog open={false} onOpenChange={() => {}} /></section>;
      }`,
    },
    sameSlotArm: {
      body: `{items.length > 0 ? <div>${DIALOG}</div> : <div><Dialog open={false} onOpenChange={() => {}} /></div>}`,
    },
    attributeSlot: { body: `<Tabs trigger={${DIALOG}} />` },
  });
  for (const setup of [
    "",
    "if (items.length === 0) return null;",
    "if (items.length === 0) return <section>Empty</section>;",
  ]) {
    const otherRoot = finding(
      panel({ body: `{items.length > 0 ? ${DIALOG} : <p>Empty</p>}`, setup }),
    );
    assert.match(otherRoot?.message ?? "", WRAP_SITE, setup);
  }
  const otherSlotArm = finding(
    panel({ body: `{items.length > 0 ? <div>${DIALOG}</div> : <div><p>Empty</p></div>}` }),
  );
  assert.match(otherSlotArm?.message ?? "", WRAP_SITE);
});

test("does not wrap a slot that renders an owner snapshot the block would leave stale", () => {
  assertNotWrapped({
    refSnapshot: {
      body: dialogWith("{open ? width : 0}"),
      setup:
        "const panel = useRef<HTMLDivElement>(null);\nconst width = panel.current?.offsetWidth ?? 0;",
    },
    callSnapshot: { body: dialogWith("{open ? stamp : 0}"), setup: "const stamp = Date.now();" },
    mutableBinding: { body: dialogWith("{open ? label : null}"), setup: 'let label = "Menu";' },
  });
});

test("yields to moving the state down when the owner only transports it to one call site", () => {
  const result = finding(`
    import { useState } from "react";
    import { Dialog } from "@acme/ui";
    export function Panel() {
      const [open, setOpen] = useState(false);
      return (
        <section>
          ${CHROME}
          <Dialog open={open} onOpenChange={(next) => setOpen(next)}><p>Details</p></Dialog>
        </section>
      );
    }
  `);
  assert.equal(result?.action, "move-state-down");
});

function alerts(fail: string): string {
  return `
    import { useState } from "react";
    import { flushSync } from "react-dom";
    declare function report(message: string): Promise<void>;
    export function Panel() {
      const [error, setError] = useState<string | null>(null);
      const [hint, setHint] = useState<string | null>(null);
      ${fail}
      return <main>${CHROME}<Nav />
        <button onClick={() => fail("boom", true)} />
        {error ? <p role="alert">{error.toUpperCase()}</p> : null}
        {hint ? <p>{hint.toUpperCase()}</p> : null}
      </main>;
    }
  `;
}

function alertStates(fail: string): readonly HookFinding[] {
  return analyzeSource(alerts(fail), "fixture.tsx").filter(
    (candidate) => candidate.hook === "useState",
  );
}

test("converts co-written wrap sites only together, keeping each write in its phase", () => {
  const cowritten = /^Replace the co-written React states \(`error`, `hint`\)/u;
  for (const fail of [
    `const fail = (message: string, _retry: boolean) => { setError(message); setHint(message + "!"); };`,
    `const fail = async (message: string, retry: boolean) => { setError(message); if (retry) await report(message); setHint(message + "!"); };`,
  ]) {
    for (const member of alertStates(fail)) {
      assert.equal(member.action, "use-observable", fail);
      assert.match(member.message, cowritten);
    }
  }
  const split = alertStates(
    `const fail = (message: string, _retry: boolean) => { setHint(message + "!"); flushSync(() => setError(null)); setError(message); };`,
  );
  for (const member of split) {
    assert.equal(member.action, "review-state");
    assert.equal(member.abstentionReason, "atomic-transition-unproven");
  }
});

test("does not wrap state whose type admits an object Legend would diff structurally", () => {
  const payloadDialog = (declaration: string, value: string): string =>
    panel({
      body: '<div className="editor">{open ? <Menu item={open} onClose={() => setOpen(null)} /> : null}<Tabs value={open} /></div>',
    })
      .replace("useState(false)", declaration)
      .replace("setOpen(true)", `setOpen(${value})`);
  const primitive = finding(payloadDialog("useState<string | null>(null)", '"draft"'));
  assert.match(primitive?.message ?? "", WRAP_SITE);
  for (const [declaration, value] of [
    ["useState<{ id: string } | null>(null)", '{ id: "draft" }'],
    ["useState<Date | null>(null)", "new Date()"],
    ["useState<string[] | null>(null)", "items"],
  ] as const) {
    const result = finding(payloadDialog(declaration, value));
    assert.equal(result?.action, "review-state", declaration);
    assert.doesNotMatch(result?.message ?? "", WRAP_SITE, declaration);
  }
});
