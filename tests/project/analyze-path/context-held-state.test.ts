import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { HookFinding } from "../../../src/core/types.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const CONTEXT = `
  import { createContext, useContext } from "react";
  export const PanelContext = createContext({ open: false, setOpen: (next: boolean) => {}, tone: "plain" });
  export function usePanelContext() {
    return useContext(PanelContext);
  }
`;

function provider(extra = ""): string {
  return `
    import { useMemo, useState } from "react";
    import { PanelContext } from "./context";
    export function PanelProvider({ children, tone }) {
      const [open, setOpen] = useState(false);
      const value = useMemo(() => ({ open, setOpen, tone }), [open, tone]);
      ${extra}
      return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>;
    }
  `;
}

async function scan(files: Readonly<Record<string, string>>): Promise<HookFinding[]> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-context-held-"));
  try {
    await Promise.all(
      Object.entries(files).map(([name, source]) =>
        writeFile(path.join(root, name), source, "utf8"),
      ),
    );
    const report = await analyzePath(path.join(root, "PanelProvider.tsx"));
    return report.findings;
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

const READER = `
  import { usePanelContext } from "./context";
  export function PanelBody() {
    const { open, tone } = usePanelContext();
    return <section data-tone={tone}>{open ? "Open" : "Closed"}</section>;
  }
`;

const TOGGLE = `
  import { usePanelContext } from "./context";
  export function PanelToggle() {
    const panel = usePanelContext();
    return <button onClick={() => panel.setOpen(!panel.open)}>Toggle</button>;
  }
`;

const GUARDED_CONTEXT = `
  import { createContext, useContext } from "react";
  export const PanelContext = createContext<{ open: boolean; setOpen: (next: boolean) => void; tone: string } | null>(null);
  export function usePanelContext() {
    const context = useContext(PanelContext);
    if (context === null) {
      throw new Error("usePanelContext must be used within PanelProvider");
    }
    return context;
  }
`;

const ARROW_CONTEXT = `
  import { createContext, useContext } from "react";
  export const PanelContext = createContext({ open: false, setOpen: (next: boolean) => {}, tone: "plain" });
  export const usePanelContext = () => useContext(PanelContext);
`;

test("publishes a provider's context-held state as an observable in the value", async () => {
  for (const [name, context] of Object.entries({ ARROW_CONTEXT, CONTEXT, GUARDED_CONTEXT })) {
    const findings = await scan({
      "context.tsx": context,
      "PanelBody.tsx": READER,
      "PanelToggle.tsx": TOGGLE,
      "PanelProvider.tsx": provider(),
    });
    const open = findings.find((finding) => finding.name === "open");
    assert.equal(open?.action, "use-observable", name);
    assert.match(open?.message ?? "", /context-held React state \(`open`\)/u, name);
    assert.match(open?.message ?? "", /2 consumer files/u, name);
    assert.equal(open?.group?.kind, "state-cluster", name);
  }
});

test("keeps the state in React when the context object escapes or the provider reads it", async () => {
  const cases = {
    restBinding: {
      "PanelBody.tsx": `
        import { usePanelContext } from "./context";
        export function PanelBody() {
          const { tone, ...rest } = usePanelContext();
          return <section data-tone={tone}>{rest.open ? "Open" : "Closed"}</section>;
        }
      `,
    },
    wholeObject: {
      "PanelBody.tsx": `
        import { usePanelContext } from "./context";
        import { describe } from "./describe";
        export function PanelBody() {
          const panel = usePanelContext();
          return <section>{describe(panel)}</section>;
        }
      `,
    },
    directUseContext: {
      "PanelBody.tsx": `
        import { useContext } from "react";
        import { PanelContext } from "./context";
        export function PanelBody() {
          const { open } = useContext(PanelContext);
          return <section>{open ? "Open" : "Closed"}</section>;
        }
      `,
    },
    providerReads: {
      "PanelBody.tsx": READER,
      "PanelProvider.tsx": provider("if (open) { document.title = 'open'; }"),
    },
    secondProviderSite: {
      "PanelBody.tsx": READER,
      "PanelStory.tsx": `
        import { PanelContext } from "./context";
        import { PanelBody } from "./PanelBody";
        export function PanelStory() {
          return <PanelContext.Provider value={{ open: true, setOpen: () => {}, tone: "story" }}><PanelBody /></PanelContext.Provider>;
        }
      `,
    },
  } satisfies Record<string, Readonly<Record<string, string>>>;
  for (const [name, overrides] of Object.entries(cases)) {
    const findings = await scan({
      "context.tsx": CONTEXT,
      "describe.ts": "export function describe(value: unknown) { return String(value); }",
      "PanelToggle.tsx": TOGGLE,
      "PanelProvider.tsx": provider(),
      ...overrides,
    });
    const open = findings.find((finding) => finding.name === "open");
    assert.notEqual(open?.action, "use-observable", name);
  }
});
