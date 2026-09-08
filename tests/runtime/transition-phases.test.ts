import { act, createElement as jsx, useState } from "react";
import { batch, observable } from "@legendapp/state";
import { count, mountDom } from "../../src/runtime/dom.js";
import { useObservable, useValue } from "@legendapp/state/react";
import type { Observable } from "@legendapp/state";
import type { ReactElement } from "react";
import assert from "node:assert/strict";
import test from "node:test";

interface Flags {
  menu: boolean;
  pending: boolean;
}

interface Props {
  events: string[];
  renders: Map<string, number>;
  work: () => Promise<void>;
}

async function command(props: Props, start: () => void, finish: () => void): Promise<void> {
  start();
  props.events.push("start");
  try {
    await props.work();
    props.events.push("success");
  } catch {
    props.events.push("failure");
  } finally {
    finish();
    props.events.push("finish");
  }
}

function view(flags: Flags, run: () => void): ReactElement {
  return jsx(
    "button",
    { disabled: flags.pending, "data-menu": flags.menu, onClick: run },
    "Duplicate",
  );
}

function ReactOwner(props: Props): ReactElement {
  count(props.renders, "owner");
  const [menu, setMenu] = useState(true);
  const [pending, setPending] = useState(false);
  return view({ menu, pending }, () => {
    command(
      props,
      () => {
        setPending(true);
        setMenu(false);
      },
      () => setPending(false),
    );
  });
}

function Leaf({ flags$, run }: { flags$: Observable<Flags>; run: () => void }): ReactElement {
  return view(useValue(flags$), run);
}

function LegendOwner(props: Props): ReactElement {
  count(props.renders, "owner");
  const flags$ = useObservable<Flags>({ menu: true, pending: false });
  return jsx(Leaf, {
    flags$,
    run: () => {
      command(
        props,
        () => flags$.assign({ pending: true, menu: false }),
        () => flags$.pending.set(false),
      );
    },
  });
}

// Risk: a handler-wide batch could hide the pending interval, or change synchronous-throw
// Completion into asynchronous completion. Adjacent literal fusion must spare the owner
// While retaining the same button instance and observable user-facing sequence.
for (const strict of [false, true]) {
  for (const outcome of ["success", "rejection", "synchronous-throw"]) {
    test(`literal handoff preserves execution phases (strict=${strict}, outcome=${outcome})`, async (context) => {
      const ui = mountDom(context, strict);
      const runs: { html: string[]; events: string[] }[] = [];
      for (const Owner of [ReactOwner, LegendOwner]) {
        const deferred = deferredWork();
        const events: string[] = [];
        const renders = new Map<string, number>();
        const work = (): Promise<void> => {
          if (outcome === "synchronous-throw") {
            throw new Error("sync");
          }
          return deferred.promise;
        };
        await ui.render(jsx(Owner, { events, renders, work }));
        const button = ui.element("button");
        const baseline = renders.get("owner")!;
        const html = [ui.html()];
        await ui.click("button");
        html.push(ui.html());
        assert.equal(ui.element("button"), button);
        assert.equal(button.matches('[data-menu="false"]'), true);
        assert.equal(button.hasAttribute("disabled"), outcome !== "synchronous-throw");
        assert.equal(renders.get("owner")! > baseline, Owner === ReactOwner);
        if (outcome !== "synchronous-throw") {
          assert.deepEqual(events, ["start"]);
          await ui.click("button");
          assert.deepEqual(events, ["start"]);
          await act(async () => {
            if (outcome === "rejection") {
              deferred.reject(new Error("rejected"));
            } else {
              deferred.resolve();
            }
            await deferred.promise.catch((error: Error) => assert.equal(error.message, "rejected"));
          });
        }
        html.push(ui.html());
        assert.equal(ui.element("button"), button);
        assert.equal(button.hasAttribute("disabled"), false);
        assert.deepEqual(events, [
          "start",
          outcome === "success" ? "success" : "failure",
          "finish",
        ]);
        runs.push({ html, events });
        await ui.render(null);
      }
      assert.deepEqual(runs[0], runs[1]);
    });
  }
}

test("a throwing RHS demonstrates why ordered writes cannot become one object assign", () => {
  const ordered$ = observable({ first: false, second: false });
  const fused$ = observable({ first: false, second: false });
  const snapshots: unknown[] = [];
  const dispose = ordered$.onChange(({ value }) => snapshots.push({ ...value }));
  const fail = (): boolean => {
    throw new Error("RHS failed");
  };
  assert.throws(
    () =>
      batch(() => {
        ordered$.first.set(true);
        ordered$.second.set(fail());
      }),
    /RHS failed/u,
  );
  assert.throws(() => fused$.assign({ first: true, second: fail() }), /RHS failed/u);
  assert.deepEqual(ordered$.peek(), { first: true, second: false });
  assert.deepEqual(fused$.peek(), { first: false, second: false });
  assert.deepEqual(
    snapshots,
    [{ first: true, second: false }],
    "batch publishes preceding writes even when later work throws",
  );
  dispose();
});

interface DeferredWork {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

function deferredWork(): DeferredWork {
  const completion = {
    resolve: (): void => {
      throw new Error("not initialized");
    },
    reject: (_error: Error): void => {
      throw new Error("not initialized");
    },
  };
  // A manually settled promise keeps the pending interval observable across separate React acts.
  // eslint-disable-next-line promise/avoid-new -- The test controls when the asynchronous operation settles.
  const promise = new Promise<void>((resolve, reject) => {
    completion.resolve = resolve;
    completion.reject = reject;
  });
  return { promise, ...completion };
}
