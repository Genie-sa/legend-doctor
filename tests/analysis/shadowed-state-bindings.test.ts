import type { HookFinding } from "../../src/core/types.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

const CHROME =
  "<Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview /><Nav />";

interface Verdict {
  readonly action: HookFinding["action"];
  readonly facts: readonly string[] | null;
  readonly message: string;
  readonly reason: HookFinding["abstentionReason"] | null;
}

function verdict(source: string, name: string): Verdict {
  const findings = analyzeSource(source, "fixture.tsx");
  const finding = requireValue(findings.find((candidate) => candidate.name === name));
  return {
    action: finding.action,
    facts: finding.assumption?.facts ?? null,
    message: finding.message,
    reason: finding.abstentionReason ?? null,
  };
}

function dialogPanel(parameter: string): string {
  return `
    import { useState } from "react";
    declare function Dialog(props: { open: boolean; onOpenChange: (open: boolean) => void }): JSX.Element;
    export function Panel({ onReset }: { onReset: () => void }) {
      const [open, setOpen] = useState(false);
      return (
        <main>
          ${CHROME}
          <button onClick={() => setOpen(true)}>Open</button>
          <Dialog
            open={open}
            onOpenChange={(${parameter}) => {
              if (!${parameter}) onReset();
              setOpen(${parameter});
            }}
          />
        </main>
      );
    }
  `;
}

function listBoard(parameter: string): string {
  return `
    import { useState } from "react";
    declare function Row(props: { value: number }): JSX.Element;
    export function Board({ items }: { items: number[] }) {
      const [value, setValue] = useState(0);
      return (
        <main>
          ${CHROME}
          <button onClick={() => setValue(value + 1)}>bump</button>
          <ul>{items.map((${parameter}) => <Row key={${parameter}} value={${parameter}} />)}</ul>
        </main>
      );
    }
  `;
}

function registeredBoard(parameter: string): string {
  return `
    import { useState } from "react";
    declare function register(apply: (set: (next: boolean) => void) => void): void;
    export function Board() {
      const [open, setOpen] = useState(false);
      register((${parameter}) => ${parameter}(true));
      return (
        <main>
          ${CHROME}
          <p>{open ? "open" : "closed"}</p>
        </main>
      );
    }
  `;
}

function syncedSearch(effect: string, rowName: string): string {
  return `
    import { useEffect, useState } from "react";
    export function SearchPanel({ query, rows }: { query: string; rows: string[] }) {
      const [debounced, setDebounced] = useState("");
      ${effect}
      const labels = rows.map((row) => { const ${rowName} = row.trim(); return ${rowName}; });
      return (
        <main>
          ${CHROME}
          <p>{debounced}</p>
          <p>{labels.length}</p>
        </main>
      );
    }
  `;
}

const DETACHED_WRITE = "useEffect(() => { setDebounced(query); }, [query]);";
const READ_AND_WRITE =
  "useEffect(() => { if (debounced !== query) setDebounced(query); }, [query, debounced]);";

test("a row-local const named like the state leaves an effect-written state convertible", () => {
  const shadowed = verdict(syncedSearch(DETACHED_WRITE, "debounced"), "debounced");
  assert.equal(shadowed.action, "use-observable");
  assert.deepEqual(shadowed, verdict(syncedSearch(DETACHED_WRITE, "label"), "debounced"));
});

test("a row-local const named like the state keeps the effect-write question of its control", () => {
  const shadowed = verdict(syncedSearch(READ_AND_WRITE, "debounced"), "debounced");
  assert.deepEqual(shadowed.facts, ["effect-write-ownership-unresolved", "render-cut-unproven"]);
  assert.deepEqual(shadowed, verdict(syncedSearch(READ_AND_WRITE, "label"), "debounced"));
});

test("a callback parameter named like the state is its own binding, not a read of the state", () => {
  const shadowed = verdict(dialogPanel("open"), "open");
  assert.equal(shadowed.action, "use-observable");
  assert.deepEqual(shadowed, verdict(dialogPanel("next"), "open"));
});

test("a repeated-row parameter named like the state neither renders nor transports it", () => {
  const shadowed = verdict(listBoard("value"), "value");
  assert.equal(shadowed.reason, "render-cut-unproven");
  assert.deepEqual(shadowed, verdict(listBoard("item"), "value"));
});

test("a callback parameter named like the setter is not a write of the state", () => {
  const shadowed = verdict(registeredBoard("setOpen"), "open");
  assert.equal(shadowed.reason, "render-cut-unproven");
  assert.deepEqual(shadowed, verdict(registeredBoard("apply"), "open"));
});
