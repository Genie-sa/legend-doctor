import type { ReactElement, ReactNode } from "react";
import { act, createContext, createElement as jsx, useContext, useMemo } from "react";
import type { Observable } from "@legendapp/state";
import assert from "node:assert/strict";
import { mountDom } from "../../src/runtime/dom.js";
import { observable } from "@legendapp/state";
import test from "node:test";
import { useValue } from "@legendapp/state/react";

interface Zones {
  readonly active$: Observable<number | null>;
}

interface Dragged {
  readonly id: string;
}

type ProviderValue = "mount-stable" | "rebuilt-on-change";

const ROWS = 200;

interface RowHarness {
  readonly active$: Observable<number | null>;
  readonly renders: () => number;
  readonly reset: () => void;
  readonly tree: ReactElement;
}

function contextRows(projected: boolean, providerValue: ProviderValue): RowHarness {
  const active$ = observable<number | null>(0);
  const ZonesContext = createContext<Zones | null>(null);
  let renders = 0;
  const useZones = (): Zones => {
    const zones = useContext(ZonesContext);
    if (!zones) {
      throw new Error("Row needs a zones provider");
    }
    return zones;
  };
  const StableProvider = ({ children }: { children: ReactNode }): ReactElement => {
    const value = useMemo(() => ({ active$ }), []);
    return jsx(ZonesContext.Provider, { value }, children);
  };
  const SubscribingProvider = ({ children }: { children: ReactNode }): ReactElement => {
    useValue(active$);
    return jsx(ZonesContext.Provider, { value: { active$ } }, children);
  };
  const Raw = ({ id }: { id: number }): ReactElement => {
    renders += 1;
    const { active$: zone$ } = useZones();
    const active = useValue(zone$);
    return jsx("div", { "aria-selected": active === id, "data-id": id });
  };
  const Selected = ({ id }: { id: number }): ReactElement => {
    renders += 1;
    const { active$: zone$ } = useZones();
    const isActive = useValue(() => zone$.get() === id);
    return jsx("div", { "aria-selected": isActive, "data-id": id });
  };
  const Row = projected ? Selected : Raw;
  const Provider = providerValue === "mount-stable" ? StableProvider : SubscribingProvider;
  const rows = Array.from({ length: ROWS }, (_value, id) => jsx(Row, { id, key: id }));
  return {
    active$,
    renders: () => renders,
    reset: () => {
      renders = 0;
    },
    tree: jsx(Provider, null, rows),
  };
}

for (const strict of [false, true]) {
  const passes = strict ? 2 : 1;

  test(`context-held rows render only where the comparison flips under a mount-stable provider (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    for (const projected of [false, true]) {
      const harness = contextRows(projected, "mount-stable");
      await ui.render(harness.tree);
      harness.reset();
      await act(() => harness.active$.set(1));
      assert.equal(harness.renders(), (projected ? 2 : ROWS) * passes);
      assert.equal(ui.element('[data-id="0"]').getAttribute("aria-selected"), "false");
      assert.equal(ui.element('[data-id="1"]').getAttribute("aria-selected"), "true");
      harness.reset();
      await act(() => harness.active$.set(null));
      assert.equal(harness.renders(), (projected ? 1 : ROWS) * passes);
      await ui.render(null);
    }
  });

  test(`a provider that rebuilds its value on the same change keeps every row rendering (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    for (const projected of [false, true]) {
      const harness = contextRows(projected, "rebuilt-on-change");
      await ui.render(harness.tree);
      harness.reset();
      await act(() => harness.active$.set(1));
      assert.equal(harness.renders(), ROWS * passes, "the context value re-renders every consumer");
      assert.equal(ui.element('[data-id="1"]').getAttribute("aria-selected"), "true");
      await ui.render(null);
    }
  });

  test(`a null projection skips object-to-object replacements (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    for (const projected of [false, true]) {
      const dragged$ = observable<Dragged | null>(null);
      let renders = 0;
      const Raw = ({ id }: { id: number }): ReactElement => {
        renders += 1;
        const dragged = useValue(dragged$);
        return jsx("div", { title: String(dragged !== null), "data-id": id });
      };
      const Selected = ({ id }: { id: number }): ReactElement => {
        renders += 1;
        const hasDragged = useValue(() => dragged$.get() !== null);
        return jsx("div", { title: String(hasDragged), "data-id": id });
      };
      const Row = projected ? Selected : Raw;
      await ui.render(Array.from({ length: ROWS }, (_value, id) => jsx(Row, { id, key: id })));
      renders = 0;
      await act(() => dragged$.set({ id: "a" }));
      assert.equal(renders, ROWS * passes);
      renders = 0;
      await act(() => dragged$.set({ id: "b" }));
      assert.equal(renders, (projected ? 0 : ROWS) * passes);
      assert.equal(ui.element('[data-id="0"]').getAttribute("title"), "true");
      await ui.render(null);
    }
  });

  test(`a render write confined to the equal side stays current (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    const active$ = observable(0);
    const focused = { current: -1 };
    const Row = ({ id }: { id: number }): ReactElement => {
      const isSelected = useValue(() => active$.get() === id);
      if (isSelected) {
        focused.current = id;
      }
      return jsx("div", { "aria-selected": isSelected, "data-id": id });
    };
    await ui.render(Array.from({ length: ROWS }, (_value, id) => jsx(Row, { id, key: id })));
    for (const next of [7, 3, 150]) {
      await act(() => active$.set(next));
      assert.equal(focused.current, next);
    }
  });
}
