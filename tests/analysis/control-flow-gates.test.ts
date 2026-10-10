import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

const SIBLINGS =
  "<Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />";

interface GateFixture {
  readonly commands: string;
  readonly declaration: string;
  readonly slot: string;
  readonly state: string;
}

function gateMessage({ commands, declaration, slot, state }: GateFixture): string {
  const finding = analyzeSource(
    `
    import { useState } from "react";
    export function Screen({ busy }: { busy: boolean }) {
      ${declaration}
      ${commands}
      return <main>
        ${SIBLINGS}
        <section>
          <Canvas onBegin={hide} onOpen={show} />
          ${slot}
        </section>
      </main>;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.name === state);
  assert.equal(requireValue(finding).action, "use-observable");
  return requireValue(finding).message ?? "";
}

const BOOLEAN_COMMANDS = "const hide = () => setOpen(false); const show = () => setOpen(true);";
const OPEN = "const [open, setOpen] = useState(false);";

test("renders a proven boolean gate with Show and a lazy child", () => {
  assert.match(
    gateMessage({
      state: "open",
      declaration: OPEN,
      slot: "{open && <Panel />}",
      commands: BOOLEAN_COMMANDS,
    }),
    /`<Show if=\{open\$\}>\{\(\) => <Panel \/>\}<\/Show>`/u,
  );
});

test("keeps the owner's other boolean gate inputs inside a Show selector", () => {
  assert.match(
    gateMessage({
      state: "open",
      declaration: OPEN,
      slot: "{open && !busy && <Panel />}",
      commands: BOOLEAN_COMMANDS,
    }),
    /`<Show if=\{\(\) => open\$\.get\(\) && !busy\}>\{\(\) => <Panel \/>\}<\/Show>`/u,
  );
});

test("renders a host-parent ternary with Show and a lazy else", () => {
  const message = gateMessage({
    state: "open",
    declaration: OPEN,
    slot: "{open ? <Panel /> : <Placeholder />}",
    commands: BOOLEAN_COMMANDS,
  });
  assert.match(
    message,
    /`<Show if=\{open\$\} else=\{\(\) => <Placeholder \/>\}>\{\(\) => <Panel \/>\}<\/Show>`/u,
  );
});

test("keeps the gate component when a non-host parent inspects the ternary's children", () => {
  const finding = analyzeSource(
    `
    import { useState } from "react";
    export function Screen() {
      const [copied, setCopied] = useState(false);
      const copy = () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2_000);
      };
      return <main>
        ${SIBLINGS}
        <button onClick={copy}>
          <AnimatePresence mode="wait">
            {copied ? <motion.span key="check" /> : <motion.span key="copy" />}
          </AnimatePresence>
        </button>
      </main>;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.name === "copied");
  const message = requireValue(finding).message ?? "";
  assert.doesNotMatch(message, /<Show/u);
  assert.match(message, /always-mounted leaf subscriber/u);
});

test("keeps the gate component when a non-host parent inspects a logical gate's child", () => {
  const finding = analyzeSource(
    `
    import { useState } from "react";
    export function Screen() {
      const [open, setOpen] = useState(false);
      return <main>
        ${SIBLINGS}
        <button onClick={() => setOpen(true)}>Open</button>
        <AnimatePresence>
          {open && <motion.div key="modal" onClick={() => setOpen(false)} />}
        </AnimatePresence>
      </main>;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.name === "open");
  assert.doesNotMatch(requireValue(finding).message ?? "", /<Show/u);
});

test("keeps the gate component when a falsy non-boolean value would render", () => {
  const message = gateMessage({
    state: "count",
    declaration: "const [count, setCount] = useState(0);",
    slot: "{count && <Badge />}",
    commands: "const hide = () => setCount(0); const show = () => setCount(3);",
  });
  assert.doesNotMatch(message, /<Show/u);
});

test("keeps the gate component when the setter escapes a literal boolean proof", () => {
  const message = gateMessage({
    state: "open",
    declaration: OPEN,
    slot: "{open && <Panel />}",
    commands:
      "const hide = () => setOpen(false); const show = () => setOpen(Math.random() as never);",
  });
  assert.doesNotMatch(message, /<Show/u);
});

test("keeps the gate component when the slot reads another observable", () => {
  const message = gateMessage({
    state: "open",
    declaration: OPEN,
    slot: "{open && <Panel title={title$.get()} />}",
    commands: BOOLEAN_COMMANDS,
  });
  assert.doesNotMatch(message, /<Show/u);
});

const TAB = 'const [tab, setTab] = useState<"posts" | "media" | "likes">("posts");';
const TAB_COMMANDS = 'const hide = () => setTab("media"); const show = () => setTab("likes");';

test("renders a proven literal ternary chain with Switch and a default arm", () => {
  assert.match(
    gateMessage({
      state: "tab",
      declaration: TAB,
      slot: '{tab === "posts" ? <Posts /> : tab === "media" ? <Media /> : <Likes />}',
      commands: TAB_COMMANDS,
    }),
    /`<Switch value=\{tab\$\}>\{\{ posts: \(\) => <Posts \/>, media: \(\) => <Media \/>, default: \(\) => <Likes \/> \}\}<\/Switch>`/u,
  );
});

test("keeps the gate component when an unproven value could hit an Object.prototype key", () => {
  for (const commands of [
    'const hide = () => setTab("media"); const show = () => setTab("constructor" as never);',
    'const hide = () => setTab("media"); const show = () => setTab(String(Date.now()) as never);',
  ]) {
    const message = gateMessage({
      state: "tab",
      declaration: TAB,
      slot: '{tab === "posts" ? <Posts /> : tab === "media" ? <Media /> : <Likes />}',
      commands,
    });
    assert.doesNotMatch(message, /<Switch/u);
  }
});
