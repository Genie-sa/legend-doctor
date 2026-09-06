import { count, mountDom } from "../../src/runtime/dom.js";
import { createElement as jsx, useEffect, useState } from "react";
import { useObservable, useValue } from "@legendapp/state/react";
import type { Observable } from "@legendapp/state";
import type { ReactElement } from "react";
import assert from "node:assert/strict";
import test from "node:test";

interface OwnerProps {
  id: string;
  renders: Map<string, number>;
  lifecycle: string[];
}

function useReactReady({ id, lifecycle }: OwnerProps): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    lifecycle.push(`setup:${id}`);
    const readyNow = (): void => {
      lifecycle.push(`write:${id}`);
      setReady(true);
    };
    globalThis.window.addEventListener(id, readyNow);
    return (): void => {
      lifecycle.push(`cleanup:${id}`);
      globalThis.window.removeEventListener(id, readyNow);
    };
  }, [id, lifecycle]);
  return ready;
}

function useLegendReady({ id, lifecycle }: OwnerProps): Observable<boolean> {
  const ready$ = useObservable(false);
  useEffect(() => {
    lifecycle.push(`setup:${id}`);
    const readyNow = (): void => {
      lifecycle.push(`write:${id}`);
      ready$.set(true);
    };
    globalThis.window.addEventListener(id, readyNow);
    return (): void => {
      lifecycle.push(`cleanup:${id}`);
      globalThis.window.removeEventListener(id, readyNow);
    };
  }, [id, lifecycle]);
  return ready$;
}

function ReactOwner(props: OwnerProps): ReactElement {
  count(props.renders, props.id);
  const ready = useReactReady(props);
  return jsx(
    "section",
    { id: props.id },
    jsx("span", null, "Unrelated content"),
    jsx("output", null, String(ready)),
  );
}

function ReadyLeaf({ ready$ }: { ready$: Observable<boolean> }): ReactElement {
  return jsx("output", null, String(useValue(ready$)));
}

function LegendOwner(props: OwnerProps): ReactElement {
  count(props.renders, props.id);
  const ready$ = useLegendReady(props);
  return jsx(
    "section",
    { id: props.id },
    jsx("span", null, "Unrelated content"),
    jsx(ReadyLeaf, { ready$ }),
  );
}

for (const strict of [false, true]) {
  test(`hook publication preserves independent lifetimes, effect replay and cleanup (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    const traces: string[][] = [];
    for (const Component of [ReactOwner, LegendOwner]) {
      const renders = new Map<string, number>();
      const lifecycle: string[] = [];
      const owners = ["first", "second"].map((id) =>
        jsx(Component, { key: id, id, renders, lifecycle }),
      );
      await ui.render(owners);
      renders.clear();
      await ui.signal("first");
      assert.equal(ui.element("#first output").textContent, "true");
      assert.equal(ui.element("#second output").textContent, "false");
      assert.equal((renders.get("first") ?? 0) > 0, Component === ReactOwner);
      assert.equal(renders.get("second") ?? 0, 0);
      await ui.render([owners[1]]);
      const writes = lifecycle.filter((entry) => entry === "write:first").length;
      await ui.signal("first");
      assert.equal(lifecycle.filter((entry) => entry === "write:first").length, writes);
      await ui.signal("second");
      await ui.render(owners);
      assert.equal(ui.element("#first output").textContent, "false", "remount creates fresh state");
      assert.equal(
        ui.element("#second output").textContent,
        "true",
        "the other instance keeps its state",
      );
      await ui.render(null);
      assert.equal(
        lifecycle.filter((entry) => entry.startsWith("setup:")).length,
        lifecycle.filter((entry) => entry.startsWith("cleanup:")).length,
      );
      traces.push(lifecycle);
    }
    // Adding a subscribing child can change Strict Mode's interleaving between siblings.
    // These instances are independent; preserve each owner's ordered lifecycle, not a global order.
    for (const id of ["first", "second"]) {
      assert.deepEqual(
        traces[1]!.filter((entry) => entry.endsWith(`:${id}`)),
        traces[0]!.filter((entry) => entry.endsWith(`:${id}`)),
        `storage migration preserves ${id}'s ordered lifecycle`,
      );
    }
  });
}
