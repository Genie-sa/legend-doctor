import type { HookFinding } from "../../../src/core/types.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import test from "node:test";
import { withProject } from "../with-project.js";

const CHROME = "<i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i />";

const ENTRY_HOOK = `
  import { useCallback, useState } from "react";
  export function useEntry() {
    const [refreshing, setRefreshing] = useState(false);
    const refresh = useCallback(() => {
      setRefreshing(true);
      queueMicrotask(() => setRefreshing(false));
    }, []);
    return { refreshing, refresh };
  }
`;

function entryScreen(parentImport: string, parent: string): string {
  return `
    import { useEntry } from "./use-entry";
    ${parentImport}
    export function EntryScreen() {
      const { refreshing, refresh } = useEntry();
      return (
        <main>
          ${CHROME}
          <${parent}>
            <button onClick={refresh} disabled={refreshing}>Refresh</button>
          </${parent.split(" ")[0]}>
        </main>
      );
    }
  `;
}

async function refreshingVerdict(files: Readonly<Record<string, string>>): Promise<HookFinding> {
  let finding: HookFinding | undefined = undefined;
  await withProject({ "use-entry.ts": ENTRY_HOOK, ...files }, async (root) => {
    const report = await analyzePath(root);
    finding = report.findings.find(
      (candidate) => candidate.hook === "useState" && candidate.name === "refreshing",
    );
  });
  assert.ok(finding, "missing state refreshing");
  return finding;
}

test("abstains from publishing hook state rendered inside a child-inspecting parent", async () => {
  const inspecting = await refreshingVerdict({
    "entry-screen.tsx": entryScreen(`import { Toolbar } from "./toolbar";`, "Toolbar"),
    "toolbar.tsx": `
      import { Children, isValidElement, type ReactNode } from "react";
      export function Toolbar({ children }: { children: ReactNode }) {
        const buttons = Children.toArray(children).filter(
          (child) => isValidElement(child) && child.type === "button",
        );
        return <nav>{buttons}</nav>;
      }
    `,
  });
  assert.notEqual(inspecting.action, "use-observable");
  const thirdParty = await refreshingVerdict({
    "entry-screen.tsx": entryScreen(
      `import { Stack } from "expo-router";`,
      `Stack.Toolbar placement="right"`,
    ),
  });
  assert.notEqual(thirdParty.action, "use-observable");
});

test("publishes hook state rendered inside a host parent", async () => {
  const finding = await refreshingVerdict({
    "entry-screen.tsx": entryScreen("", `div className="toolbar"`),
  });
  assert.equal(finding.action, "use-observable");
  assert.match(finding.message, /publish the observable from `useEntry`/u);
});
