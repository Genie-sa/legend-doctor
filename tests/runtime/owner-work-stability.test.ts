import { count, mountDom } from "../../src/runtime/dom.js";
import {
  createContext,
  createElement as jsx,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Observable } from "@legendapp/state";
import type { ReactElement } from "react";
import assert from "node:assert/strict";
import { observable } from "@legendapp/state";
import test from "node:test";
import { useValue } from "@legendapp/state/react";

type Notify = (message: string) => void;
function rejectUnprovidedNotify(message: string): never {
  throw new Error(`No notifier provided for "${message}"`);
}
const NotifyContext = createContext<Notify>(rejectUnprovidedNotify);
function useNotify(): Notify {
  return useContext(NotifyContext);
}

interface Probe {
  renders: Map<string, number>;
  log: string[];
  attached: (Element | null)[];
  effects: number;
  panel: { current: HTMLElement | null } | null;
}
interface Props {
  enabled$: Observable<boolean>;
  probe: Probe;
}

interface OwnerWork {
  panel: { current: HTMLElement | null };
  attach: (element: Element | null) => void;
  save: () => void;
}

/** A ref, a context- and state-keyed callback, a stable callback ref, and an effect on both. */
function useOwnerWork(probe: Probe): OwnerWork {
  const notify = useNotify();
  const [draft, setDraft] = useState("draft");
  const panel = useRef<HTMLElement | null>(null);
  probe.panel = panel;
  const save = useCallback(() => {
    notify(`saved ${draft}`);
    setDraft("saved");
  }, [notify, draft]);
  const attach = useCallback(
    (element: Element | null) => {
      probe.attached.push(element);
    },
    [probe],
  );
  useEffect(() => {
    probe.effects += 1;
  }, [save, panel]);
  return { panel, attach, save };
}

function Before({ enabled$, probe }: Props): ReactElement {
  count(probe.renders, "owner");
  const enabled = useValue(enabled$);
  const { panel, attach, save } = useOwnerWork(probe);
  return jsx(
    "section",
    { ref: panel },
    jsx("span", { ref: attach }, "sibling"),
    jsx("button", { id: "save", onClick: save }, "Save"),
    jsx("input", { id: "enabled", type: "checkbox", checked: enabled, readOnly: true }),
  );
}

function EnabledBox({ enabled$ }: Pick<Props, "enabled$">): ReactElement {
  const enabled = useValue(enabled$);
  return jsx("input", { id: "enabled", type: "checkbox", checked: enabled, readOnly: true });
}

function After({ enabled$, probe }: Props): ReactElement {
  count(probe.renders, "owner");
  const { panel, attach, save } = useOwnerWork(probe);
  return jsx(
    "section",
    { ref: panel },
    jsx("span", { ref: attach }, "sibling"),
    jsx("button", { id: "save", onClick: save }, "Save"),
    jsx(EnabledBox, { enabled$ }),
  );
}

function createProbe(): Probe {
  return { renders: new Map(), log: [], attached: [], effects: 0, panel: null };
}

function InlineRefOwner({ enabled$, probe }: Props): ReactElement {
  const enabled = useValue(enabled$);
  return jsx(
    "section",
    null,
    jsx("span", {
      ref: (element: Element | null) => {
        probe.attached.push(element);
      },
    }),
    jsx("input", { id: "enabled", type: "checkbox", checked: enabled, readOnly: true }),
  );
}

test("an inline callback ref detaches and reattaches on every owner render, so it stays a blocker", async (context) => {
  const ui = mountDom(context, false);
  const enabled$ = observable(false);
  const probe = createProbe();
  await ui.render(jsx(InlineRefOwner, { enabled$, probe }));
  const span = ui.element("span");
  globalThis.window.addEventListener("toggle", () => enabled$.set(true), { once: true });
  await ui.signal("toggle");
  assert.deepEqual(probe.attached, [span, null, span]);
});

for (const strict of [false, true]) {
  test(`stable owner refs, callbacks, and effects survive a subscription cut (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    const traces: string[][] = [];
    for (const Component of [Before, After]) {
      const enabled$ = observable(false);
      const probe = createProbe();
      const notify: Notify = (message) => probe.log.push(message);
      await ui.render(
        jsx(NotifyContext.Provider, { value: notify }, jsx(Component, { enabled$, probe })),
      );
      const section = ui.element("section");
      const checkbox = ui.element("#enabled");
      assert.equal(probe.panel?.current, section);
      const mounted = { attached: probe.attached.length, effects: probe.effects };
      probe.renders.clear();
      for (const next of [true, false, true]) {
        globalThis.window.addEventListener("toggle", () => enabled$.set(next), { once: true });
        await ui.signal("toggle");
        assert.ok(checkbox instanceof globalThis.window.HTMLInputElement);
        assert.equal(checkbox.checked, next);
      }
      const rendersPerUpdate = strict ? 2 : 1;
      assert.equal(
        probe.renders.get("owner") ?? 0,
        Component === Before ? 3 * rendersPerUpdate : 0,
      );
      assert.equal(probe.attached.length, mounted.attached, "callback ref never reattached");
      assert.equal(probe.effects, mounted.effects, "effect never reran");
      assert.equal(probe.panel?.current, section);
      assert.equal(ui.element("section"), section);
      assert.equal(ui.element("#enabled"), checkbox);
      await ui.click("#save");
      await ui.click("#save");
      assert.equal(probe.panel?.current, section);
      traces.push([...probe.log, ui.html(), String(probe.effects - mounted.effects)]);
      await ui.render(null);
    }
    assert.deepEqual(traces[1], traces[0]);
    assert.deepEqual(traces[0]?.slice(0, 2), ["saved draft", "saved saved"]);
  });
}
