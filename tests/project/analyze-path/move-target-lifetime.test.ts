import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import test from "node:test";
import { withProject } from "../with-project.js";

const CHROME = "<i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i />";

const PANELS = `
  export function Panel({ children }: { children: React.ReactNode }) {
    return <div className="panel">{children}</div>;
  }
  export function SpreadPanel(props: React.ComponentProps<"div">) {
    return <div className="panel" {...props} />;
  }
  export function GatedPanel({ open, children }: { open: boolean; children: React.ReactNode }) {
    return <div className="panel">{open && children}</div>;
  }
  export function EarlyPanel({ open, children }: { open: boolean; children: React.ReactNode }) {
    if (!open) return null;
    return <div className="panel">{children}</div>;
  }
`;

async function menuStateAction(wrap: (subtree: string) => string): Promise<string | undefined> {
  let action: string | undefined = undefined;
  const screen = `
    import { useState } from "react";
    import { Tabs, TabsContent } from "@radix-ui/react-tabs";
    import { Modal, View } from "react-native";
    import { EarlyPanel, GatedPanel, Panel, SpreadPanel } from "./panel";
    export function Screen() {
      const [open, setOpen] = useState(false);
      return (
        <main>
          ${CHROME}
          ${wrap(`
            <section>
              <button onClick={() => setOpen(true)}>Open</button>
              {open ? <p>Menu open</p> : null}
              <button onClick={() => setOpen(false)}>Close</button>
            </section>
          `)}
        </main>
      );
    }
  `;
  await withProject({ "panel.tsx": PANELS, "screen.tsx": screen }, async (root) => {
    const report = await analyzePath(root);
    action = report.findings.find((finding) => finding.name === "open")?.action;
  });
  return action;
}

test("keeps ownership when a move target sits under a parent that can unmount it", async () => {
  for (const wrap of [
    (subtree: string): string =>
      `<Tabs><TabsContent value="menu"><div>${subtree}</div></TabsContent></Tabs>`,
    (subtree: string): string =>
      `<TabsContent value="menu"><Panel>${subtree}</Panel></TabsContent>`,
    (subtree: string): string => `<GatedPanel open><div>${subtree}</div></GatedPanel>`,
    (subtree: string): string => `<EarlyPanel open><div>${subtree}</div></EarlyPanel>`,
    (subtree: string): string => `<Modal visible><View>${subtree}</View></Modal>`,
  ]) {
    assert.equal(await menuStateAction(wrap), "use-observable", wrap(""));
  }
});

test("moves state down under parents that render their children unconditionally", async () => {
  for (const wrap of [
    (subtree: string): string => `<Panel><div>${subtree}</div></Panel>`,
    (subtree: string): string => `<SpreadPanel><div>${subtree}</div></SpreadPanel>`,
    (subtree: string): string => `<View>${subtree}</View>`,
  ]) {
    assert.equal(await menuStateAction(wrap), "move-state-down", wrap(""));
  }
});
