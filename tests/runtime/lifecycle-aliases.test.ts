import { createElement as jsx, useEffect } from "react";
import { useMount, useUnmount } from "@legendapp/state/react";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mountDom } from "../../src/runtime/dom.js";
import test from "node:test";

interface LifecycleProps {
  readonly calls: string[];
}

type LifecycleComponent = (props: LifecycleProps) => null;

function ReactSetup({ calls }: LifecycleProps): null {
  useEffect(() => {
    calls.push("setup");
  }, []);
  return null;
}

function LegendSetup({ calls }: LifecycleProps): null {
  useMount(() => {
    calls.push("setup");
  });
  return null;
}

function ReactTeardown({ calls }: LifecycleProps): null {
  useEffect(
    () => (): void => {
      calls.push("teardown");
    },
    [],
  );
  return null;
}

function LegendTeardown({ calls }: LifecycleProps): null {
  useUnmount(() => {
    calls.push("teardown");
  });
  return null;
}

async function mountAndUnmount(
  context: TestContext,
  component: LifecycleComponent,
  strict: boolean,
): Promise<string[]> {
  const calls: string[] = [];
  const dom = mountDom(context, strict);
  await dom.render(jsx(component, { calls }));
  await dom.render(null);
  return calls;
}

const CASES = [
  [ReactSetup, false, ["setup"]],
  [LegendSetup, false, ["setup"]],
  [ReactSetup, true, ["setup", "setup"]],
  [LegendSetup, true, ["setup", "setup"]],
  [ReactTeardown, false, ["teardown"]],
  [LegendTeardown, false, ["teardown"]],
  [ReactTeardown, true, ["teardown", "teardown"]],
  [LegendTeardown, true, ["teardown"]],
] as const;

for (const [component, strict, expected] of CASES) {
  test(`${component.name} under ${strict ? "Strict Mode" : "a plain root"} calls ${expected.join(", ")}`, async (context) => {
    assert.deepEqual(await mountAndUnmount(context, component, strict), expected);
  });
}
