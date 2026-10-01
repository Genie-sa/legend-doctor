import type { HookFinding } from "../../../src/core/types.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import test from "node:test";
import { withProject } from "../with-project.js";

const CHROME = "<i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i />";

const SLOT_IMPORT = `import { PopoverTrigger } from "@radix-ui/react-popover";`;

interface ParentFixture {
  readonly files?: Readonly<Record<string, string>>;
  readonly name: string;
  readonly screen: (parent: (child: string) => string) => string;
}

const slotted = (child: string): string => `<PopoverTrigger asChild>${child}</PopoverTrigger>`;

const hosted = (child: string): string => `<div>${child}</div>`;

async function stateFinding(
  { files = {}, name, screen }: ParentFixture,
  slot: boolean,
): Promise<HookFinding> {
  let finding: HookFinding | undefined = undefined;
  const source = `${slot ? SLOT_IMPORT : ""}\n${screen(slot ? slotted : hosted)}`;
  await withProject({ ...files, "screen.tsx": source }, async (root) => {
    const report = await analyzePath(root);
    finding = report.findings.find(
      (candidate) => candidate.hook === "useState" && candidate.name === name,
    );
  });
  assert.ok(finding, `missing state ${name}`);
  return finding;
}

const LITERAL_BOOLEAN: ParentFixture = {
  files: {
    "button.tsx": `
      export function Button(props: { expanded: boolean; onPress: () => void }) {
        return <button aria-expanded={props.expanded} onClick={props.onPress} />;
      }
    `,
  },
  name: "open",
  screen: (parent) => `
    import { useState } from "react";
    import { Button } from "./button";
    export function Screen({ ready }: { ready: boolean }) {
      const [open, setOpen] = useState(false);
      if (!ready) {
        return null;
      }
      return (
        <main>
          ${CHROME}
          <button onClick={() => setOpen(true)}>Open</button>
          ${parent(`<Button expanded={open} onPress={() => setOpen(false)} />`)}
        </main>
      );
    }
  `,
};

const ASYNC_STATUS: ParentFixture = {
  files: { "api.ts": "export async function download() {}" },
  name: "busy",
  screen: (parent) => `
    import { useState } from "react";
    import { Spinner } from "@acme/spinner";
    import { download } from "./api";
    export function Screen() {
      const [busy, setBusy] = useState(false);
      const run = async () => {
        setBusy(true);
        try {
          await download();
        } finally {
          setBusy(false);
        }
      };
      return (
        <main>
          ${CHROME}
          <button onClick={run}>Download</button>
          ${parent(`<Spinner loading={busy} />`)}
        </main>
      );
    }
  `,
};

const CONFINED_SUBTREE: ParentFixture = {
  name: "open",
  screen: (parent) => `
    import { useState } from "react";
    export function Screen() {
      const [open, setOpen] = useState(false);
      return (
        <main>
          ${CHROME}
          ${parent(`
            <section>
              <button onClick={() => setOpen(true)}>Open</button>
              {open ? <p>Menu open</p> : null}
              <button onClick={() => setOpen(false)}>Close</button>
            </section>
          `)}
        </main>
      );
    }
  `,
};

const REPEATED_TRANSPORT: ParentFixture = {
  name: "query",
  screen: (parent) => `
    import { useState } from "react";
    import { Row } from "@acme/row";
    import { SearchField } from "@acme/search";
    export function Screen({ items }: { items: string[] }) {
      const [query, setQuery] = useState("");
      return (
        <main>
          ${CHROME}
          <SearchField onChangeText={setQuery} />
          {items.map((item) => (
            <section key={item}>${parent(`<Row label={item} query={query} />`)}</section>
          ))}
        </main>
      );
    }
  `,
};

test("does not wrap a literal boolean leaf that an asChild parent slots", async () => {
  const slottedFinding = await stateFinding(LITERAL_BOOLEAN, true);
  assert.notEqual(slottedFinding.action, "use-observable");
  const hostedFinding = await stateFinding(LITERAL_BOOLEAN, false);
  assert.equal(hostedFinding.action, "use-observable");
});

test("does not wrap an async status leaf that an asChild parent slots", async () => {
  const slottedFinding = await stateFinding(ASYNC_STATUS, true);
  assert.notEqual(slottedFinding.action, "use-observable");
  const hostedFinding = await stateFinding(ASYNC_STATUS, false);
  assert.equal(hostedFinding.action, "use-observable");
  assert.match(hostedFinding.message, /async pending flag/u);
});

test("does not extract a confined subtree that an asChild parent slots", async () => {
  const slottedFinding = await stateFinding(CONFINED_SUBTREE, true);
  assert.doesNotMatch(slottedFinding.message, /Extract the <section> subtree/u);
  const hostedFinding = await stateFinding(CONFINED_SUBTREE, false);
  assert.equal(hostedFinding.action, "move-state-down");
  assert.match(hostedFinding.message, /Extract the <section> subtree/u);
});

test("does not wrap external repeated leaves that an asChild parent slots", async () => {
  const slottedFinding = await stateFinding(REPEATED_TRANSPORT, true);
  assert.notEqual(slottedFinding.action, "use-observable");
  const hostedFinding = await stateFinding(REPEATED_TRANSPORT, false);
  assert.equal(hostedFinding.action, "use-observable");
  assert.match(hostedFinding.message, /subscribe in the transported leaves/u);
});
