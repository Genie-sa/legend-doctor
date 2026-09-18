import type { ComponentProps, ReactElement } from "react";
import { act, createElement as jsx, useEffect, useState } from "react";
import { count, mountDom } from "../../src/runtime/dom.js";
import { useObservable, useValue } from "@legendapp/state/react";
import { Command } from "cmdk";
import type { Observable } from "@legendapp/state";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import test from "node:test";

interface Props {
  capture: string;
  work: () => Promise<void>;
  events: string[];
  renders: Map<string, number>;
}

function Item(props: ComponentProps<typeof Command.Item>): ReactElement {
  return jsx(Command.Item, props);
}

function Picker({
  select,
  events,
}: {
  select: (value: string) => void;
  events: string[];
}): ReactElement {
  const [selected, setSelected] = useState("");
  const [open, setOpen] = useState(true);
  useEffect(() => {
    events.push("mount picker");
    return (): void => {
      events.push("unmount picker");
    };
  }, [events]);
  const commandProps = { value: "tag", "data-open": open, "data-selection": selected };
  return jsx(
    Command,
    commandProps,
    jsx(
      Command.List,
      null,
      jsx(
        Item,
        {
          value: "tag",
          onSelect: (value) => {
            setSelected(value === selected ? "" : value);
            setOpen(false);
            select(value);
          },
        },
        "Merge",
      ),
    ),
  );
}

async function run(
  props: Props,
  write: (pending: boolean) => void,
  selected: string,
): Promise<void> {
  props.events.push(`start:${selected}:${props.capture}`);
  write(true);
  try {
    await props.work();
    props.events.push(`success:${props.capture}`);
  } catch {
    props.events.push(`failure:${props.capture}`);
  } finally {
    props.events.push("finish");
    write(false);
  }
}

function Surface({
  pending,
  select,
  events,
}: {
  pending: boolean;
  select: (value: string) => void;
  events: string[];
}): ReactElement {
  return jsx(
    "section",
    null,
    pending ? jsx("span", null, "Saving") : jsx(Picker, { select, events }),
  );
}

function ReactOwner(props: Props): ReactElement {
  count(props.renders, "owner");
  const [pending, setPending] = useState(false);
  return jsx(
    "main",
    null,
    jsx("input", { defaultValue: "independent" }),
    jsx(Surface, {
      pending,
      select: (value) => {
        run(props, setPending, value);
      },
      events: props.events,
    }),
  );
}

function Leaf({
  pending$,
  select,
  events,
  renders,
}: {
  pending$: Observable<boolean>;
  select: (value: string) => void;
  events: string[];
  renders: Map<string, number>;
}): ReactElement {
  const pending = useValue(() => {
    count(renders, "selector");
    return pending$.get();
  });
  return jsx(Surface, { pending, select, events });
}

function LegendOwner(props: Props): ReactElement {
  count(props.renders, "owner");
  const pending$ = useObservable(false);
  return jsx(
    "main",
    null,
    jsx("input", { defaultValue: "independent" }),
    jsx(Leaf, {
      pending$,
      select: (value) => {
        run(props, (next) => pending$.set(next), value);
      },
      events: props.events,
      renders: props.renders,
    }),
  );
}

function installCommandDom(context: TestContext): void {
  // The jsdom harness has no layout. These shims leave real cmdk selection, effects, and DOM events intact.
  const globals = {
    Event: globalThis.window.Event,
    HTMLElement: globalThis.window.HTMLElement,
    cancelAnimationFrame: context.mock.fn(),
    ResizeObserver: class {
      public readonly observe = context.mock.fn();
      public readonly unobserve = context.mock.fn();
      public readonly disconnect = context.mock.fn();
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    context.after(() => {
      if (previous) {
        Object.defineProperty(globalThis, key, previous);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    });
  }
  Object.defineProperty(globalThis.window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: context.mock.fn(),
  });
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: Error) => void;
}

function deferred(): Deferred {
  const completion = {
    resolve: (): void => {
      throw new Error("not initialized");
    },
    reject: (_reason: Error): void => {
      throw new Error("not initialized");
    },
  };
  // eslint-disable-next-line promise/avoid-new -- Explicit settlement separates the start and completion epochs.
  const promise = new Promise<void>((resolve, reject) => {
    completion.resolve = resolve;
    completion.reject = reject;
  });
  return { promise, ...completion };
}

for (const strict of [false, true]) {
  for (const event of ["click", "keyboard"] as const) {
    for (const outcome of ["resolve", "reject"] as const) {
      test(`cmdk 1.1.1 pending gate preserves epochs and captures (${strict}, ${event}, ${outcome})`, async (context) => {
        const ui = mountDom(context, strict);
        installCommandDom(context);
        const traces: string[][] = [];
        for (const Owner of [ReactOwner, LegendOwner]) {
          const work = deferred();
          const events: string[] = [];
          const renders = new Map<string, number>();
          const props: Props = { capture: "old", work: () => work.promise, events, renders };
          await ui.render(jsx(Owner, props));
          assert.equal(
            events.some((entry) => entry.startsWith("start:")),
            false,
          );
          await ui.render(jsx(Owner, { ...props, capture: "selected" }));
          const section = ui.element("section");
          const input = ui.element("input");
          const baseline = renders.get("owner")!;
          const selectorBaseline = renders.get("selector") ?? 0;
          await selectItem(ui, event);
          assert.equal(ui.element("section"), section);
          assert.equal(ui.element("input"), input);
          assert.equal(section.textContent, "Saving");
          const startRenders = renders.get("owner")! - baseline;
          const startSelectors = (renders.get("selector") ?? 0) - selectorBaseline;
          const expectedOwnerRenders = Owner === ReactOwner ? Number(strict) + 1 : 0;
          assert.equal(startRenders, expectedOwnerRenders);
          assert.deepEqual(
            events.filter((entry) => entry.startsWith("start:")),
            ["start:tag:selected"],
          );
          await ui.render(jsx(Owner, { ...props, capture: "later" }));
          const completionBaseline = renders.get("owner")!;
          const completionSelectors = renders.get("selector") ?? 0;
          await act(async () => {
            if (outcome === "resolve") {
              work.resolve();
            } else {
              work.reject(new Error("failure"));
            }
            await work.promise.catch((error: Error) => assert.equal(error.message, "failure"));
          });
          assert.equal(ui.element("section"), section);
          assert.equal(ui.element("input"), input);
          assert.equal(section.textContent, "Merge");
          assert.equal(commandData(ui, "selection"), "");
          assert.ok(events.includes(`${outcome === "resolve" ? "success" : "failure"}:selected`));
          const finishRenders = renders.get("owner")! - completionBaseline;
          const finishSelectors = (renders.get("selector") ?? 0) - completionSelectors;
          assert.equal(finishRenders, expectedOwnerRenders);
          context.diagnostic(
            JSON.stringify({
              implementation: Owner.name,
              strict,
              event,
              outcome,
              ownerRenders: startRenders + finishRenders,
              selectorExecutions: startSelectors + finishSelectors,
            }),
          );
          traces.push([...events]);
          await ui.render(null);
        }
        assert.deepEqual(traces[0], traces[1]);
      });
    }
  }
}

async function selectItem(
  ui: ReturnType<typeof mountDom>,
  event: "click" | "keyboard",
): Promise<void> {
  if (event === "click") {
    await ui.click('[cmdk-item=""]');
    return;
  }
  await act(() =>
    ui
      .element('[cmdk-root=""]')
      .dispatchEvent(
        new globalThis.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
  );
}

for (const strict of [false, true]) {
  test(`cmdk pending gate preserves a synchronous work exception (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    installCommandDom(context);
    const traces: string[][] = [];
    for (const Owner of [ReactOwner, LegendOwner]) {
      const events: string[] = [];
      await ui.render(
        jsx(Owner, {
          capture: "selected",
          events,
          renders: new Map(),
          work: () => {
            throw new Error("before suspension");
          },
        }),
      );
      const item = ui.element('[cmdk-item=""]');
      await ui.click('[cmdk-item=""]');
      assert.equal(
        ui.element('[cmdk-item=""]'),
        item,
        "no async suspension must not remount the picker",
      );
      assert.equal(ui.element("section").textContent, "Merge");
      assert.equal(commandData(ui, "selection"), "tag");
      assert.equal(commandData(ui, "open"), "false");
      assert.deepEqual(
        events.filter((entry) => !entry.includes("picker")),
        ["start:tag:selected", "failure:selected", "finish"],
      );
      traces.push([...events]);
      await ui.render(null);
    }
    assert.deepEqual(traces[0], traces[1]);
  });
}

test("cmdk root value changes can execute before a user event", async (context) => {
  const ui = mountDom(context, false);
  installCommandDom(context);
  const values: string[] = [];
  const command = jsx(
    Command,
    { value: "", onValueChange: (value) => values.push(value) },
    jsx(Command.List, null, jsx(Command.Item, { value: "tag" }, "Merge")),
  );
  await ui.render(command);
  assert.deepEqual(values, ["tag"], "root value-change is not the item selection contract");
});

test("cmdk disabled item does not invoke selection on click or keyboard", async (context) => {
  const ui = mountDom(context, false);
  installCommandDom(context);
  const values: string[] = [];
  const command = jsx(
    Command,
    { value: "tag" },
    jsx(
      Command.List,
      null,
      jsx(
        Command.Item,
        { value: "tag", disabled: true, onSelect: (value) => values.push(value) },
        "Merge",
      ),
    ),
  );
  await ui.render(command);
  await selectItem(ui, "click");
  await selectItem(ui, "keyboard");
  assert.deepEqual(values, []);
});

function commandData(ui: ReturnType<typeof mountDom>, field: string): string | undefined {
  const root = ui.element('[cmdk-root=""]');
  assert.ok(root instanceof globalThis.window.HTMLElement);
  return root.dataset[field];
}
