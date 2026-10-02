import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { SubscriptionInventory } from "../../../src/core/subscriptions.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const toast = `import { createContext, useContext } from "react";
const ToastContext = createContext((message: string): void => undefined);
export function useToast() { return useContext(ToastContext); }
export function useLoggedToast() { const show = useContext(ToastContext); console.log(show); return show; }`;
const thing = `export function useThing() { return { id: 1 }; }`;
const LEAVES = "<A/><B/><C/><D/><E/><F/><G/><H/><I/><J/><K/>";

interface Owner {
  readonly setup: string;
  readonly content?: string;
  readonly parameters?: string;
  readonly leaves?: string;
}

async function analyzeOwner(
  context: test.TestContext,
  { setup, content = "", parameters = "", leaves = LEAVES }: Owner,
): Promise<{ entry: SubscriptionInventory; moved: boolean }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-owner-work-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const screen = `import { observable } from "@legendapp/state";
import { useObservable, useValue } from "@legendapp/state/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLoggedToast, useToast } from "./toast";
import { useThing } from "./thing";
const state$ = observable({ open: false });
const user$ = observable({ id: "", profile: { name: "" } });
export function Screen(${parameters}) {
  const open = useValue(state$.open);
  ${setup}
  return <main>${leaves}${content}<output>{open}</output></main>;
}`;
  await writeFile(path.join(root, "Screen.tsx"), screen);
  await writeFile(path.join(root, "toast.ts"), toast);
  await writeFile(path.join(root, "thing.ts"), thing);
  const report = await analyzePath(root);
  const line = screen.split("\n").findIndex((text) => text.includes("const open =")) + 1;
  const entry = report.subscriptionAnalysis?.inventory.find((item) => item.binding === "open");
  assert.ok(entry);
  return {
    entry,
    moved: report.practices.some(
      (finding) => finding.action === "move-use-value-down" && finding.location.line === line,
    ),
  };
}

const identityStable: readonly (readonly [string, Owner])[] = [
  [
    "a callback keyed on a useState value and setter",
    {
      setup: `const [draft, setDraft] = useState(""); const save = useCallback(() => setDraft(draft), [draft, setDraft]);`,
      content: "<button onClick={save}/>",
    },
  ],
  [
    "a callback keyed on an imported context-reader hook",
    {
      setup: `const show = useToast(); const notify = useCallback(() => show("saved"), [show]);`,
      content: "<button onClick={notify}/>",
    },
  ],
  [
    "a callback keyed on another stable callback",
    {
      setup: `const show = useToast(); const notify = useCallback(() => show("a"), [show]);
      const both = useCallback(() => notify(), [notify]);`,
      content: "<button onClick={both}/>",
    },
  ],
  [
    "a memo keyed on ref and observable handles",
    {
      setup: `const node = useRef(null); const local$ = useObservable(0);
      const handles = useMemo(() => [node, local$], [node, local$]);`,
      content: "<Pane data={handles}/>",
    },
  ],
  [
    "a useRef object attached as a ref",
    { setup: "const node = useRef(null);", content: "<div ref={node}/>" },
  ],
  [
    "a callback ref with stable dependencies",
    {
      setup: "const attach = useCallback((element: unknown) => void element, []);",
      content: "<div ref={attach}/>",
    },
  ],
  [
    "an effect keyed on a field of another subscription",
    { setup: "const userId = useValue(user$)?.id; useEffect(() => void userId, [userId]);" },
  ],
  [
    "a memo keyed on a nested field of another subscription",
    {
      setup: `const name = useValue(user$.profile).name;
      const greeting = useMemo(() => [name], [name]);`,
      content: "<Pane data={greeting}/>",
    },
  ],
  [
    "an effect keyed on state and a ref",
    {
      setup: `const [count] = useState(0); const node = useRef(0);
      useEffect(() => { node.current = count; }, [count, node]);`,
    },
  ],
];

for (const [name, owner] of identityStable) {
  test(`owner work that a subscription-only render keeps does not block: ${name}`, async (context) => {
    const { entry, moved } = await analyzeOwner(context, owner);
    assert.ok(!entry.reasons.includes("owner-commit-or-snapshot-work"), entry.reasons.join(", "));
    assert.equal(moved, true);
  });
}

const identityUnproven: readonly (readonly [string, Owner])[] = [
  [
    "a callback keyed on an arbitrary custom hook",
    {
      setup: "const value = useThing(); const read = useCallback(() => value, [value]);",
      content: "<button onClick={read}/>",
    },
  ],
  [
    "a callback keyed on a context hook that does more than read",
    {
      setup: `const show = useLoggedToast(); const notify = useCallback(() => show("a"), [show]);`,
      content: "<button onClick={notify}/>",
    },
  ],
  [
    "a callback keyed on a shadowed context-reader name",
    {
      parameters: "{ useToast }: { useToast: () => (message: string) => void }",
      setup: `const show = useToast(); const notify = useCallback(() => show("a"), [show]);`,
      content: "<button onClick={notify}/>",
    },
  ],
  ["an inline callback ref", { setup: "", content: "<div ref={(element) => void element}/>" }],
  [
    "a merged ref built during render",
    {
      setup:
        "const a = useRef(null); const b = useRef(null); const merge = (...refs: unknown[]) => refs[0];",
      content: "<div ref={merge(a, b)}/>",
    },
  ],
  [
    "a reassignable ref binding",
    { setup: "let node = useRef(null);", content: "<div ref={node}/>" },
  ],
  [
    "a state member with an allocating default",
    {
      setup: `const [items = [], setItems] = useState<string[]>();
      const add = useCallback(() => setItems([...items]), [items]);`,
      content: "<button onClick={add}/>",
    },
  ],
  [
    "an effect keyed on a method result of another subscription",
    {
      setup: `const name = useValue(user$.profile).name.trim();
      useEffect(() => void name, [name]);`,
    },
  ],
  [
    "an effect keyed on a computed key of another subscription",
    { setup: `const id = useValue(user$)["id"]; useEffect(() => void id, [id]);` },
  ],
  [
    "an effect keyed on a field of a non-observable hook result",
    { setup: "const id = useValue(useThing())?.id; useEffect(() => void id, [id]);" },
  ],
  [
    "an effect keyed on a field of a selector",
    { setup: "const id = useValue(() => user$.get())?.id; useEffect(() => void id, [id]);" },
  ],
  [
    "an effect keyed on a fresh object",
    { setup: "const options = { open: true }; useEffect(() => void options, [options]);" },
  ],
  [
    "an effect keyed on an unmemoized callback",
    { setup: "const notify = () => undefined; useEffect(() => notify(), [notify]);" },
  ],
  [
    "a render snapshot of a stable ref",
    { setup: "const node = useRef(0); const seen = node.current;", content: "<Pane data={seen}/>" },
  ],
  [
    "cyclic cache dependencies",
    {
      setup: `const a = useCallback(() => b, [b]); const b = useCallback(() => a, [a]);`,
      content: "<button onClick={a}/>",
    },
  ],
];

for (const [name, owner] of identityUnproven) {
  test(`owner work whose identity can change still blocks: ${name}`, async (context) => {
    const { entry, moved } = await analyzeOwner(context, owner);
    assert.ok(entry.reasons.includes("owner-commit-or-snapshot-work"), entry.reasons.join(", "));
    assert.equal(moved, false);
  });
}

for (const content of ["<Pane source={node}/>", "<Pane ref={node}/>"]) {
  test(`a ref handle a child component receives stays a possible render snapshot: ${content}`, async (context) => {
    const { moved } = await analyzeOwner(context, { setup: "const node = useRef(0);", content });
    assert.equal(moved, false);
  });
}

test("a stable dependency still leaves an effect that reads the moved value in the owner", async (context) => {
  const { entry, moved } = await analyzeOwner(context, {
    setup: "const userId = useValue(user$)?.id; useEffect(() => void open, [userId, open]);",
  });
  assert.ok(entry.reasons.includes("effect-consumer"), entry.reasons.join(", "));
  assert.equal(moved, false);
});

test("a stable dependency does not excuse a render-time ref snapshot", async (context) => {
  const { entry, moved } = await analyzeOwner(context, {
    setup: `const userId = useValue(user$)?.id; const node = useRef(0);
    useEffect(() => void userId, [userId]); const seen = node.current;`,
    content: "<Pane data={seen}/>",
  });
  assert.ok(entry.reasons.includes("owner-commit-or-snapshot-work"), entry.reasons.join(", "));
  assert.equal(moved, false);
});

test("a stable ref leaves the next blocker visible in the inventory", async (context) => {
  const { entry, moved } = await analyzeOwner(context, {
    setup: "const node = useRef(null);",
    content: "<div ref={node}/>",
    leaves: "",
  });
  assert.deepEqual(entry.reasons, ["stable-material-render-cut-not-proven"]);
  assert.equal(moved, false);
});
