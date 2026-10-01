import type { HookFinding } from "../../../src/core/types.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import test from "node:test";
import { withProject } from "../with-project.js";

const OWNER_PADDING = "\n".repeat(150);

/** A conditional subtree owns `expanded`, so the verdict extracts a leaf that subscribes to it. */
function conditionalSubtree(legendImport: string): string {
  return `
    import { useState } from "react";
    ${legendImport}
    export function Screen({ show }: { show: boolean }) {
      const [expanded, setExpanded] = useState(false);
      ${OWNER_PADDING}
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        {show ? <section><p>{expanded ? "Long" : "Short"}</p><button onClick={() => setExpanded((v) => !v)}>Toggle</button></section> : null}
      </main>;
    }
  `;
}

const TITLE_EFFECT = `
  import { useEffect } from "react";
  import { use$ } from "@legendapp/state/react";
  export function Title({ title$ }: { title$: unknown }) {
    const title = use$(title$);
    useEffect(() => { document.title = title; }, [title]);
    return null;
  }
`;

const PANEL_CONTEXT = `
  import { createContext, useContext } from "react";
  export const PanelContext = createContext({ open: false, setOpen: (next: boolean) => {} });
  export function usePanelContext() {
    return useContext(PanelContext);
  }
`;

const PANEL_PROVIDER = `
  import { useMemo, useState } from "react";
  import { use$ } from "@legendapp/state/react";
  import { PanelContext } from "./context";
  export function PanelProvider({ children }) {
    const [open, setOpen] = useState(false);
    const value = useMemo(() => ({ open, setOpen }), [open]);
    return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>;
  }
`;

const PANEL_BODY = `
  import { usePanelContext } from "./context";
  export function PanelBody() {
    const { open } = usePanelContext();
    return <section>{open ? "Open" : "Closed"}</section>;
  }
`;

async function findingsUnder(
  files: Readonly<Record<string, string>>,
): Promise<readonly HookFinding[]> {
  let findings: readonly HookFinding[] = [];
  await withProject(files, async (root) => {
    ({ findings } = await analyzePath(root));
  });
  return findings;
}

function messageFor(findings: readonly HookFinding[], file: string, action: string): string {
  const finding = findings.find(
    (candidate) => candidate.location.file === file && candidate.action === action,
  );
  assert.ok(finding, `${action} in ${file}`);
  return finding.message;
}

test("a leaf instruction names the subscription hook the file imports, else useValue", async () => {
  const findings = await findingsUnder({
    "imports-use-dollar.tsx": conditionalSubtree(`import { use$ } from "@legendapp/state/react";`),
    "imports-selector.tsx": conditionalSubtree(
      `import { useSelector as select } from "@legendapp/state/react";`,
    ),
    "imports-nothing.tsx": conditionalSubtree(""),
  });
  for (const [file, hook] of Object.entries({
    "imports-use-dollar.tsx": "use$",
    "imports-selector.tsx": "select",
    "imports-nothing.tsx": "useValue",
  })) {
    const message = messageFor(findings, file, "use-observable");
    assert.ok(message.includes(`subscribe there with \`${hook}\`;`), file);
    assert.equal(hook === "useValue" || !message.includes("useValue"), true, file);
  }
});

test("an observable reaction describes its dependencies by the hook the file calls", async () => {
  const findings = await findingsUnder({ "Title.tsx": TITLE_EFFECT });
  const message = messageFor(findings, "Title.tsx", "use-observe-effect");
  assert.match(message, /dependencies are `use\$` snapshots/u);
  assert.doesNotMatch(message, /useValue/u);
});

test("a context instruction for consumer files names useValue", async () => {
  const findings = await findingsUnder({
    "context.tsx": PANEL_CONTEXT,
    "PanelBody.tsx": PANEL_BODY,
    "PanelProvider.tsx": PANEL_PROVIDER,
  });
  const message = messageFor(findings, "PanelProvider.tsx", "use-observable");
  assert.ok(message.includes("replace each destructured field with `useValue`"));
});
