import type { ComponentProps, ReactElement } from "react";
import { act, createElement as jsx, useState } from "react";
import { count, mountDom } from "../../src/runtime/dom.js";
import { useObservable, useValue } from "@legendapp/state/react";
import type { Observable } from "@legendapp/state";
import assert from "node:assert/strict";
import { mergeProps } from "@base-ui/react/merge-props";
import test from "node:test";
import { useRender } from "@base-ui/react/use-render";

function Button(props: ComponentProps<"button">): ReactElement {
  return useRender({ defaultTagName: "button", props: mergeProps({ type: "button" }, props) });
}

interface OwnerProps {
  work: Promise<void>;
  renders: Map<string, number>;
  events: string[];
}

async function runCommand(props: OwnerProps, write: (value: boolean) => void): Promise<void> {
  props.events.push("start");
  write(true);
  try {
    await props.work;
    props.events.push("success");
  } catch {
    props.events.push("failure");
  } finally {
    props.events.push("finish");
    write(false);
  }
}

function ReactOwner(props: OwnerProps): ReactElement {
  count(props.renders, "owner");
  const [pending, setPending] = useState(false);
  return jsx(
    "main",
    null,
    jsx("aside", null, "independent"),
    jsx(Button, {
      disabled: pending,
      onClick: () => {
        runCommand(props, setPending);
      },
      children: "Save",
    }),
  );
}

function PendingLeaf({
  pending$,
  command,
}: {
  pending$: Observable<boolean>;
  command: () => void;
}): ReactElement {
  return jsx(Button, { disabled: useValue(pending$), onClick: command, children: "Save" });
}

function LegendOwner(props: OwnerProps): ReactElement {
  count(props.renders, "owner");
  const pending$ = useObservable(false);
  return jsx(
    "main",
    null,
    jsx("aside", null, "independent"),
    jsx(PendingLeaf, {
      pending$,
      command: () => {
        runCommand(props, (value) => pending$.set(value));
      },
    }),
  );
}

for (const strict of [false, true]) {
  for (const reject of [false, true]) {
    test(`Base UI 1.7 pending migration preserves timing and button identity (strict=${strict}, reject=${reject})`, async (context) => {
      const ui = mountDom(context, strict);
      const snapshots: string[][] = [];
      const traces: string[][] = [];
      for (const Owner of [ReactOwner, LegendOwner]) {
        const deferred = deferredWork();
        const renders = new Map<string, number>();
        const events: string[] = [];
        await ui.render(jsx(Owner, { work: deferred.promise, renders, events }));
        const button = ui.element("button");
        const baseline = renders.get("owner")!;
        const html = [ui.html()];
        assert.deepEqual(events, [], "render must not execute the command");
        await ui.click("button");
        html.push(ui.html());
        assert.equal(button.hasAttribute("disabled"), true);
        assert.equal(ui.element("button"), button);
        assert.deepEqual(events, ["start"]);
        assert.equal(renders.get("owner")! > baseline, Owner === ReactOwner);
        await ui.click("button");
        assert.deepEqual(events, ["start"], "disabled button must not restart work");
        await act(async () => {
          if (reject) {
            deferred.reject(new Error("work failed"));
          } else {
            deferred.resolve();
          }
          await deferred.promise.catch((error: Error) =>
            assert.equal(error.message, "work failed"),
          );
        });
        assert.equal(button.hasAttribute("disabled"), false);
        assert.equal(ui.element("button"), button);
        html.push(ui.html());
        snapshots.push(html);
        traces.push(events);
        await ui.render(null);
      }
      assert.deepEqual(snapshots[0], snapshots[1]);
      assert.deepEqual(traces[0], ["start", reject ? "failure" : "success", "finish"]);
      assert.deepEqual(traces[0], traces[1]);
    });
  }
}

test("Base UI merge function can execute the command eagerly", () => {
  const events: string[] = [];
  mergeProps<"button">({ onClick: () => events.push("called") }, (previous) => {
    // This contract counterexample deliberately calls before any React event exists.
    previous.onClick?.(null!);
    return previous;
  });
  assert.deepEqual(events, ["called"]);
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
