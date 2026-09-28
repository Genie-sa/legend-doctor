import type { HookFinding } from "../../../src/core/types.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import test from "node:test";
import { withProject } from "../with-project.js";

/** `useValue` first ships in 3.0.0-beta.35, so beta.30 exports only `useSelector` and `use$`. */
const WITHOUT_USE_VALUE = "3.0.0-beta.30";
const WITH_USE_VALUE = "3.0.0-beta.48";
const OWNER_PADDING = "\n".repeat(150);

function lockfile(version: string): string {
  return JSON.stringify({
    lockfileVersion: 3,
    packages: { "": {}, "node_modules/@legendapp/state": { version } },
  });
}

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
  version: string,
  files: Readonly<Record<string, string>>,
): Promise<readonly HookFinding[]> {
  let findings: readonly HookFinding[] = [];
  await withProject({ ...files, "package-lock.json": lockfile(version) }, async (root) => {
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

test("a leaf instruction names the subscription hook the file imports or the package exports", async () => {
  const files = {
    "imports-use-dollar.tsx": conditionalSubtree(`import { use$ } from "@legendapp/state/react";`),
    "imports-selector.tsx": conditionalSubtree(
      `import { useSelector as select } from "@legendapp/state/react";`,
    ),
    "imports-nothing.tsx": conditionalSubtree(""),
  };
  for (const [version, expected] of [
    [WITHOUT_USE_VALUE, { "imports-nothing.tsx": "useSelector" }],
    [WITH_USE_VALUE, { "imports-nothing.tsx": "useValue" }],
  ] as const) {
    const findings = await findingsUnder(version, files);
    for (const [file, hook] of Object.entries({
      "imports-use-dollar.tsx": "use$",
      "imports-selector.tsx": "select",
      ...expected,
    })) {
      const message = messageFor(findings, file, "use-observable");
      assert.ok(message.includes(`subscribe there with \`${hook}\`;`), `${version} ${file}`);
      assert.equal(
        hook === "useValue" || !message.includes("useValue"),
        true,
        `${version} ${file}`,
      );
    }
  }
});

test("an observable reaction describes its dependencies by the hook the file calls", async () => {
  const findings = await findingsUnder(WITHOUT_USE_VALUE, { "Title.tsx": TITLE_EFFECT });
  const message = messageFor(findings, "Title.tsx", "use-observe-effect");
  assert.match(message, /dependencies are `use\$` snapshots/u);
  assert.doesNotMatch(message, /useValue/u);
});

test("a context instruction for consumer files names the hook the package exports", async () => {
  for (const [version, hook] of [
    [WITHOUT_USE_VALUE, "useSelector"],
    [WITH_USE_VALUE, "useValue"],
  ] as const) {
    const findings = await findingsUnder(version, {
      "context.tsx": PANEL_CONTEXT,
      "PanelBody.tsx": PANEL_BODY,
      "PanelProvider.tsx": PANEL_PROVIDER,
    });
    const message = messageFor(findings, "PanelProvider.tsx", "use-observable");
    assert.ok(message.includes(`replace each destructured field with \`${hook}\``), version);
  }
});
