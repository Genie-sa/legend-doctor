import { count, mountDom } from "../../src/runtime/dom.js";
import { createElement as jsx, useEffect, useMemo } from "react";
import { observer, useValue } from "@legendapp/state/react";
import type { Observable } from "@legendapp/state";
import type { ReactElement } from "react";
import assert from "node:assert/strict";
import { observable } from "@legendapp/state";
import test from "node:test";

interface Track {
  title: string;
  artist: string;
}
interface Props {
  track$: Observable<Track>;
  label: string;
  renders: Map<string, number>;
  lifecycle: string[];
}
function useSubtitle(track$: Observable<Track>): string {
  const track = useValue(track$);
  return useMemo(() => {
    const parts: string[] = [];
    if (track.title) {
      parts.push(track.title);
    }
    if (track.artist) {
      parts.push(track.artist);
    }
    return parts.join(" · ");
  }, [track]);
}
function Child({ track$ }: Pick<Props, "track$">): ReactElement {
  return jsx("output", null, useSubtitle(track$));
}
function Before({ track$, label, renders, lifecycle }: Props): ReactElement {
  count(renders, "owner");
  const subtitle = useSubtitle(track$);
  useEffect(() => {
    lifecycle.push(`start:${label}`);
    return (): void => {
      lifecycle.push(`stop:${label}`);
    };
  }, [label]);
  return jsx("main", null, jsx("output", null, subtitle), jsx("input", { defaultValue: "draft" }));
}
function After({ track$, label, renders, lifecycle }: Props): ReactElement {
  count(renders, "owner");
  useEffect(() => {
    lifecycle.push(`start:${label}`);
    return (): void => {
      lifecycle.push(`stop:${label}`);
    };
  }, [label]);
  return jsx("main", null, jsx(Child, { track$ }), jsx("input", { defaultValue: "draft" }));
}
const ObservedBefore = observer(Before);
const ObservedAfter = observer(After);

for (const strict of [false, true]) {
  test(`memo relocation preserves object identity and effect timing (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    const histories: string[][] = [];
    for (const Component of [Before, After, ObservedBefore, ObservedAfter]) {
      const track$ = observable({ title: "First", artist: "Artist" });
      const renders = new Map<string, number>();
      const lifecycle: string[] = [];
      await ui.render(jsx(Component, { track$, label: "initial", renders, lifecycle }));
      const output = ui.element("output");
      const draft = ui.element("input");
      const mountEffects = [...lifecycle];
      renders.clear();
      globalThis.window.addEventListener("nested", () => track$.artist.set("Changed"), {
        once: true,
      });
      await ui.signal("nested");
      // Legend keeps the object identity on nested writes. React's [track] memo must keep its cache.
      assert.equal(output.textContent, "First · Artist");
      assert.deepEqual(lifecycle, mountEffects);
      assert.equal(
        (renders.get("owner") ?? 0) > 0,
        Component === Before || Component === ObservedBefore,
      );
      globalThis.window.addEventListener(
        "replace",
        () => track$.set({ title: "Next", artist: "New" }),
        { once: true },
      );
      await ui.signal("replace");
      assert.equal(output.textContent, "Next · New");
      assert.equal(ui.element("output"), output);
      assert.equal(ui.element("input"), draft);
      assert.deepEqual(lifecycle, mountEffects);
      await ui.render(jsx(Component, { track$, label: "next", renders, lifecycle }));
      assert.deepEqual(lifecycle.slice(mountEffects.length), ["stop:initial", "start:next"]);
      await ui.render(null);
      assert.equal(lifecycle.at(-1), "stop:next");
      histories.push(lifecycle);
    }
    for (const history of histories) {
      assert.deepEqual(history, histories[0]);
    }
  });
}
