import type { HookFinding } from "../../src/core/types.js";
import { analyzeSourceWith } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

const CHROME =
  "<Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />";

function verdict(source: string, name: string): string {
  const finding: HookFinding | undefined = analyzeSourceWith(source, "fixture.tsx", {}).find(
    (candidate) => candidate.hook === "useState" && candidate.name === name,
  );
  return finding?.abstentionReason
    ? `${finding.action}/${finding.abstentionReason}`
    : (finding?.action ?? "missing");
}

function board(body: string, rendered: string): string {
  return `
    import { useState } from "react";
    import { Banner } from "./banner";
    import { DragDropProvider } from "drag-kit";
    function Picker(props: {
      value: string | null;
      onChange: (next: string) => void;
      onClear?: (next: string) => void;
    }) {
      return <select value={props.value ?? ""} onChange={(event) => props.onChange(event.target.value)} />;
    }
    export function Board({ id, ready }: { id: string; ready: boolean }) {
      const [lane, setLane] = useState<string | null>(null);
      const [note, setNote] = useState("");
      ${body}
      return (
        <DragDropProvider
          onDragStart={() => {
            setLane(id);
            setNote("picked " + id);
          }}
        >
          ${CHROME}
          <Banner text={note} tone={note ? "info" : "none"} />
          ${rendered}
        </DragDropProvider>
      );
    }
  `;
}

const LANE_LEAF = `<span>{lane}</span>`;

const SAVE = `<button onClick={() => console.log(lane)}>Save</button>`;

const LONE_CLICK = board("", `${LANE_LEAF}<button onClick={() => setLane("todo")}>Todo</button>`);

test("a host event that writes the state alone in a broad mounted tree converts it", () => {
  assert.equal(verdict(LONE_CLICK, "lane"), "use-observable");
});

test("a bare setter handed to a child is a lone write stretch", () => {
  const source = board("", `<Picker value={lane} onChange={setLane} />${SAVE}`);
  assert.equal(verdict(source, "lane"), "use-observable");
});

test("a child that also receives a companion setter may write both in one event", () => {
  const source = board("", `<Picker value={lane} onChange={setLane} onClear={setNote} />${SAVE}`);
  assert.equal(verdict(source, "lane"), "review-state/atomic-transition-unproven");
});

test("an event whose branch skips every companion writes the state alone on that path", () => {
  const source = board(
    "",
    `${LANE_LEAF}<button onClick={() => { setLane(id); if (!ready) { setNote("draft"); setNote("draft " + id); } }}>Pick</button>`,
  );
  assert.equal(verdict(source, "lane"), "use-observable");
});

test("an event that writes a companion on every path has no lone write", () => {
  const source = board(
    "",
    `${LANE_LEAF}<button onClick={() => { setLane(id); if (!ready) { setNote("draft"); } else { setNote("ready"); } }}>Pick</button>`,
  );
  assert.equal(verdict(source, "lane"), "review-state/atomic-transition-unproven");
});

test("a companion written through a local helper is not proven skipped", () => {
  const source = board(
    'const reset = () => setNote("");',
    `${LANE_LEAF}<button onClick={() => { setLane(id); if (!ready) reset(); }}>Pick</button>`,
  );
  assert.equal(verdict(source, "lane"), "review-state/atomic-transition-unproven");
});

test("a lone write after the handler suspends runs in another stretch", () => {
  const source = board(
    "",
    `${LANE_LEAF}<button onClick={async () => { await Promise.resolve(); setLane("todo"); setNote("moved"); }}>Move</button><button onClick={async () => { await Promise.resolve(); setLane("done"); }}>Done</button>`,
  );
  assert.equal(verdict(source, "lane"), "review-state/atomic-transition-unproven");
});

test("a lone reset to the initial literal usually renders nothing", () => {
  const source = board("", `${LANE_LEAF}<button onClick={() => setLane(null)}>Clear</button>`);
  assert.equal(verdict(source, "lane"), "review-state/atomic-transition-unproven");
});

test("a lone write behind a guard runs only on a failure path", () => {
  const source = board(
    `const pick = () => {
      if (!ready) {
        setLane("todo");
        return;
      }
      setLane("done");
      setNote("moved");
    };`,
    `${LANE_LEAF}<button onClick={pick}>Pick</button>`,
  );
  assert.equal(verdict(source, "lane"), "review-state/atomic-transition-unproven");
});

test("a lone write in a branch that unmounts the broad tree saves nothing", () => {
  const source = board(
    `if (!ready) {
      return <div><button onClick={() => setLane("todo")}>Todo</button></div>;
    }`,
    LANE_LEAF,
  );
  assert.equal(verdict(source, "lane"), "review-state/atomic-transition-unproven");
});

test("conditionally mounted siblings do not count toward the lone event's tree", () => {
  const source = board(
    "",
    `${LANE_LEAF}{ready ? null : <section><button onClick={() => setLane("todo")}>Todo</button></section>}`,
  ).replace(`${CHROME}`, `{ready ? <div>${CHROME}</div> : null}`);
  assert.equal(verdict(source, "lane"), "review-state/atomic-transition-unproven");
});

test("a dialog's visibility callback mostly closes it and is not a lone write stretch", () => {
  const source = `
    import { useState } from "react";
    import { Dialog } from "./dialog";
    export function Page() {
      const [open, setOpen] = useState(false);
      const [draft, setDraft] = useState("");
      return (
        <main>
          ${CHROME}
          <p>{draft}</p>
          <button onClick={() => { setDraft(""); setOpen(true); }}>New</button>
          <Dialog open={open} onOpenChange={setOpen}><input /></Dialog>
        </main>
      );
    }
  `;
  assert.equal(verdict(source, "open"), "review-state/atomic-transition-unproven");
});

function filterMenu(opener: string): string {
  return `
    import { useState } from "react";
    import { Popover } from "./popover";
    export function Filters() {
      const [open, setOpen] = useState(false);
      const [view, setView] = useState("main");
      return (
        <main>
          ${CHROME}
          {view === "main" ? <nav><Menu /><Tabs /><Search /></nav> : <aside><Back /><Detail /></aside>}
          <button onClick={() => setView("date")}>Date</button>
          ${opener}
          <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setView("main"); }}>
            <button>Filters</button>
          </Popover>
        </main>
      );
    }
  `;
}

test("a visibility callback that alone opens the element writes the state alone on opening", () => {
  assert.equal(verdict(filterMenu(""), "open"), "move-state-down");
});

test("a visibility callback mostly closes an element another command opens", () => {
  const opener = '<button onClick={() => { setView("date"); setOpen(true); }}>Pick date</button>';
  assert.equal(verdict(filterMenu(opener), "open"), "review-state/atomic-transition-unproven");
});

test("a dialog mounted only while open is opened by its command, not its visibility callback", () => {
  const source = `
    import { useState } from "react";
    import { LandList } from "./land-list";
    import { TransferDialog } from "./transfer-dialog";
    export function Details() {
      const [selected, setSelected] = useState<string | null>(null);
      const [open, setOpen] = useState(false);
      const transfer = (land: string) => { setSelected(land); setOpen(true); };
      return (
        <main>
          ${CHROME}
          <LandList onTransfer={transfer} />
          <h2>{selected ?? "none"}</h2>
          {open && (
            <TransferDialog open land={selected} onOpenChange={(next) => { setOpen(next); if (!next) setSelected(null); }} />
          )}
        </main>
      );
    }
  `;
  assert.equal(verdict(source, "open"), "review-state/atomic-transition-unproven");
});

test("a lone write stretch never converts state its owner sets while rendering", () => {
  const source = board(
    `if (ready && lane === null) {
      setLane("todo");
    }`,
    `${LANE_LEAF}<button onClick={() => setLane("todo")}>Todo</button>`,
  );
  assert.equal(verdict(source, "lane"), "keep-state");
});

function notes(edit: string, rendered = "<h1>{form.title}</h1><p>{form.title}</p>"): string {
  return `
    import { useState } from "react";
    declare function save(id: string, text: string): void;
    interface Item { id: string; text: string }
    export function Notes({ items }: { items: Item[] }) {
      const [editingId, setEditingId] = useState<string | null>(null);
      const [form, setForm] = useState({ title: "" });
      const [open, setOpen] = useState(false);
      const edit = (item: Item) => {
        ${edit}
      };
      return (
        <main>
          ${CHROME}
          ${rendered}
          {open ? <aside>Editing</aside> : null}
          <button onClick={() => edit(items[0]!)}>Edit</button>
          <button onClick={() => { if (editingId) save(editingId, form.title); }}>Save</button>
        </main>
      );
    }
  `;
}

const EDIT = "setEditingId(item.id); setForm({ title: item.text });";

test("a write that always lands with a fresh rendered React value saves no render", () => {
  assert.equal(verdict(notes(EDIT), "editingId"), "keep-state");
});

test("a companion the owner never renders leaves the write's render to the state", () => {
  assert.equal(verdict(notes(EDIT, "<p>Notes</p>"), "editingId"), "use-ref");
});

test("a companion the owner only passes to a child still renders the owner", () => {
  assert.equal(verdict(notes(EDIT, "<Editor value={form} />"), "editingId"), "keep-state");
  const edit = "setEditingId(item.id); setOpen(true);";
  const rendered = "<Drawer open={open} />";
  assert.equal(verdict(notes(edit, rendered), "editingId"), "review-state/no-proven-optimization");
});

test("a companion value that may already be held leaves a ref no proven render to save", () => {
  const edit = "setEditingId(item.id); setOpen(true);";
  assert.equal(verdict(notes(edit), "editingId"), "review-state/no-proven-optimization");
});

test("a guarded write followed by its companion in every path saves no proven render", () => {
  const edit = "if (item.text) { setEditingId(item.id); } setOpen(false);";
  assert.equal(verdict(notes(edit), "editingId"), "review-state/no-proven-optimization");
});

test("a companion after an await commits apart from the write", () => {
  const edit = "setEditingId(item.id); await Promise.resolve(); setOpen(true);";
  const source = notes(edit).replace("const edit = (item", "const edit = async (item");
  assert.equal(verdict(source, "editingId"), "use-ref");
});

test("a companion that a branch skips leaves the write its own render", () => {
  const edit = "setEditingId(item.id); if (item.text) setOpen(true);";
  assert.equal(verdict(notes(edit), "editingId"), "use-ref");
});

test("a companion behind a guard may skip the update", () => {
  const edit = "setEditingId(item.id); if (item.text) setForm({ title: item.text });";
  assert.equal(verdict(notes(edit), "editingId"), "use-ref");
});

test("one lone write site keeps the state's own render to save", () => {
  const source = notes(
    EDIT,
    `<h1>{form.title}</h1><p>{form.title}</p><input onChange={(event) => setEditingId(event.target.value)} />`,
  );
  assert.equal(verdict(source, "editingId"), "use-ref");
});
