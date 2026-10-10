import type { HookFinding } from "../../../src/core/types.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import test from "node:test";
import { withProject } from "../with-project.js";

const CHROME = "<i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i />";

function importPanel(buttonImport: string, attributes: string): string {
  return `
    import { useState } from "react";
    ${buttonImport}
    const extra = { type: "submit" as const };
    export function ImportPanel() {
      const [importing, setImporting] = useState(false);
      const onImport = async () => {
        if (importing) return;
        setImporting(true);
        try { await persist(); } finally { setImporting(false); }
      };
      return (
        <section>
          ${CHROME}
          <Button ${attributes} onClick={() => void onImport()} loading={importing}>Import</Button>
        </section>
      );
    }
  `;
}

function slotButton(fallback: string, body = ""): string {
  return `
    import { forwardRef, useEffect, type ButtonHTMLAttributes } from "react";
    import { Slot } from "@radix-ui/react-slot";
    import { ThirdPartyButton } from "third-party-ui";
    interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
      asChild?: boolean;
      loading?: boolean;
    }
    export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
      ({ asChild = false, loading, ...props }, ref) => {
        ${body}
        const Comp = asChild ? Slot : ${fallback};
        return <Comp ref={ref} {...props} disabled={loading} />;
      },
    );
  `;
}

const HOST_BUTTON = slotButton(`"button"`);
const BUTTON_IMPORT = `import { Button } from "./button";`;

async function importingVerdict(files: Readonly<Record<string, string>>): Promise<HookFinding> {
  let finding: HookFinding | undefined = undefined;
  await withProject(files, async (root) => {
    const report = await analyzePath(root);
    finding = report.findings.find(
      (candidate) => candidate.hook === "useState" && candidate.name === "importing",
    );
  });
  assert.ok(finding, "missing state importing");
  return finding;
}

test("proves a forwardRef wrapper's click callback lands on the host button this call site selects", async () => {
  const finding = await importingVerdict({
    "button.tsx": HOST_BUTTON,
    "import-panel.tsx": importPanel(BUTTON_IMPORT, ""),
  });
  assert.equal(finding.action, "use-observable");
});

test("abstains when the call site selects the wrapper's Slot branch", async () => {
  const finding = await importingVerdict({
    "button.tsx": HOST_BUTTON,
    "import-panel.tsx": importPanel(BUTTON_IMPORT, "asChild"),
  });
  assert.notEqual(finding.action, "use-observable");
});

test("abstains when a call-site spread may carry the wrapper's branch prop", async () => {
  const finding = await importingVerdict({
    "button.tsx": HOST_BUTTON,
    "import-panel.tsx": importPanel(BUTTON_IMPORT, "{...extra}"),
  });
  assert.notEqual(finding.action, "use-observable");
});

test("abstains when the selected branch is an unresolved third-party component", async () => {
  const finding = await importingVerdict({
    "button.tsx": slotButton("ThirdPartyButton"),
    "import-panel.tsx": importPanel(BUTTON_IMPORT, ""),
  });
  assert.notEqual(finding.action, "use-observable");
});

test("abstains when the wrapper also calls the forwarded callback from an effect", async () => {
  const finding = await importingVerdict({
    "button.tsx": slotButton(`"button"`, "useEffect(() => { props.onClick?.(); }, []);"),
    "import-panel.tsx": importPanel(BUTTON_IMPORT, ""),
  });
  assert.notEqual(finding.action, "use-observable");
});

test("keeps a wrapper behind a custom memo comparator out of the source proof", async () => {
  const memoized = HOST_BUTTON.replace(
    "forwardRef<HTMLButtonElement, ButtonProps>(",
    "memo(forwardRef<HTMLButtonElement, ButtonProps>(",
  )
    .replace("  );\n  ", "  ), (previous, next) => previous.loading === next.loading);\n  ")
    .replace("import { forwardRef,", "import { forwardRef, memo,");
  assert.match(memoized, /previous\.loading === next\.loading/u);
  const finding = await importingVerdict({
    "button.tsx": memoized,
    "import-panel.tsx": importPanel(BUTTON_IMPORT, ""),
  });
  const unresolved = await importingVerdict({
    "import-panel.tsx": importPanel(`import { Button } from "unresolved-ui";`, ""),
  });
  assert.equal(finding.action, unresolved.action);
  assert.equal(finding.message, unresolved.message);
});

test("treats a barrel re-export cycle as an unresolved import, never as a same-named wrapper", async () => {
  const eagerButton = slotButton(`"button"`, "props.onClick?.();");
  const cycle = await importingVerdict({
    "button.tsx": eagerButton,
    "import-panel.tsx": importPanel(`import { Button } from "./ui";`, ""),
    "ui/index.ts": `export { Button } from "./primitives";`,
    "ui/primitives.ts": `export { Button } from "./index";`,
  });
  const unresolved = await importingVerdict({
    "button.tsx": eagerButton,
    "import-panel.tsx": importPanel(`import { Button } from "unresolved-ui";`, ""),
  });
  const eager = await importingVerdict({
    "button.tsx": eagerButton,
    "import-panel.tsx": importPanel(BUTTON_IMPORT, ""),
  });
  assert.equal(cycle.action, unresolved.action);
  assert.equal(cycle.message, unresolved.message);
  assert.notEqual(eager.action, "use-observable");
});
