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

test("a lone write stretch never converts state its owner sets while rendering", () => {
  const source = board(
    `if (ready && lane === null) {
      setLane("todo");
    }`,
    `${LANE_LEAF}<button onClick={() => setLane("todo")}>Todo</button>`,
  );
  assert.equal(verdict(source, "lane"), "keep-state");
});
