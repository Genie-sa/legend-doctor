import { act, createContext, createElement as jsx, useContext, useMemo } from "react";
import { useObservable, useValue } from "@legendapp/state/react";
import type { MountedDom } from "../../src/runtime/dom.js";
import type { Observable } from "@legendapp/state";
import type { ReactElement } from "react";
import assert from "node:assert/strict";
import { mountDom } from "../../src/runtime/dom.js";
import { observable } from "@legendapp/state";
import test from "node:test";

/**
 * The legend-apps Slides presentation runtime at replay parents b73924e and 81c6183: a deck
 * publishes the live slide clocks to deck components through a context-held observable, and a
 * component reads them through `useSlideLifecycle`-style whole-runtime hooks or per-field hooks.
 */
interface Clocks {
  currentStep: number;
  direction: "backward" | "forward";
  stepEpochs: Record<number, number>;
  stepStartedAt: number;
}

interface Runtime {
  currentStep: number;
  direction: "backward" | "forward";
  isActive: boolean;
  isPreview: boolean;
  stepEpochs: Record<number, number>;
  stepIndex: number;
  stepStartedAt: number;
}

type Provider = "computed" | "render-built";
type Consumer =
  | "field-flags"
  | "field-lifecycle"
  | "field-step"
  | "whole-flags"
  | "whole-lifecycle"
  | "whole-step";

interface Scenario {
  readonly consumer: Consumer;
  readonly memoizedContent: boolean;
  readonly provider: Provider;
}

const STEPS = 3;
const STEP_AT = 1;

const INITIAL_RUNTIME: Runtime = {
  currentStep: 0,
  direction: "forward",
  isActive: false,
  isPreview: false,
  stepEpochs: {},
  stepIndex: 0,
  stepStartedAt: 0,
};

/** One `set` per navigation, as `setSlidesState` writes it: the step, its clock, epochs, and direction. */
function advance(clocks$: Observable<Clocks>): void {
  const current = clocks$.peek();
  const currentStep = current.currentStep + 1;
  const stepStartedAt = current.stepStartedAt + 1;
  clocks$.set({
    currentStep,
    direction: "forward",
    stepEpochs: { ...current.stepEpochs, [currentStep]: stepStartedAt },
    stepStartedAt,
  });
}

function runtimeFrom(clocks: Clocks): Runtime {
  return { ...clocks, isActive: true, isPreview: false, stepIndex: clocks.currentStep };
}

interface Harness {
  readonly clocks$: Observable<Clocks>;
  readonly renders: () => number;
  readonly reset: () => void;
  readonly tree: ReactElement;
}

function presentation({ consumer, memoizedContent, provider }: Scenario): Harness {
  const clocks$ = observable<Clocks>({
    currentStep: 0,
    direction: "forward",
    stepEpochs: { 0: 0 },
    stepStartedAt: 0,
  });
  const RuntimeContext = createContext<Observable<Runtime>>(observable(INITIAL_RUNTIME));
  let renders = 0;

  const useRuntime$ = (): Observable<Runtime> => useContext(RuntimeContext);
  const useRuntimeField = <Key extends keyof Runtime>(key: Key): Runtime[Key] => {
    const runtime$ = useRuntime$();
    // SAFETY: `runtime$[key]` is the child observable of `Runtime[Key]`; Legend's generic child type does not narrow by key.
    return useValue(() => runtime$[key].get()) as Runtime[Key];
  };

  const WholeFlags = (): ReactElement => {
    renders += 1;
    const { isActive, isPreview } = useValue(useRuntime$());
    return jsx("output", { title: `${isActive}:${isPreview}` });
  };
  const FieldFlags = (): ReactElement => {
    renders += 1;
    const isActive = useRuntimeField("isActive");
    const isPreview = useRuntimeField("isPreview");
    return jsx("output", { title: `${isActive}:${isPreview}` });
  };
  const WholeLifecycle = (): ReactElement => {
    renders += 1;
    const { isActive, isPreview, stepIndex, stepStartedAt } = useValue(useRuntime$());
    return jsx("output", { title: `${isActive}:${isPreview}:${stepIndex}:${stepStartedAt}` });
  };
  const FieldLifecycle = (): ReactElement => {
    renders += 1;
    const isActive = useRuntimeField("isActive");
    const isPreview = useRuntimeField("isPreview");
    const stepIndex = useRuntimeField("stepIndex");
    const stepStartedAt = useRuntimeField("stepStartedAt");
    return jsx("output", { title: `${isActive}:${isPreview}:${stepIndex}:${stepStartedAt}` });
  };
  const WholeStep = (): ReactElement => {
    renders += 1;
    const runtime = useValue(useRuntime$());
    const reached = runtime.stepIndex >= STEP_AT;
    return jsx("output", {
      title: `${reached}:${runtime.stepEpochs[STEP_AT]}:${runtime.direction}`,
    });
  };
  const FieldStep = (): ReactElement => {
    renders += 1;
    const runtime$ = useRuntime$();
    const reached = useValue(() => runtime$.stepIndex.get() >= STEP_AT);
    const epoch = useValue(() => runtime$.stepEpochs[STEP_AT]?.get());
    const direction = useRuntimeField("direction");
    return jsx("output", { title: `${reached}:${epoch}:${direction}` });
  };
  const consumers = {
    "field-flags": FieldFlags,
    "field-lifecycle": FieldLifecycle,
    "field-step": FieldStep,
    "whole-flags": WholeFlags,
    "whole-lifecycle": WholeLifecycle,
    "whole-step": WholeStep,
  } satisfies Record<Consumer, () => ReactElement>;
  const Component = consumers[consumer];
  const useContent = (): ReactElement => {
    const content = useMemo(() => jsx(Component), []);
    return memoizedContent ? content : jsx(Component);
  };

  const RenderBuiltProvider = ({
    children,
    value,
  }: {
    children: ReactElement;
    value: Runtime;
  }): ReactElement => {
    const runtime$ = useObservable(() => value, [value]);
    return jsx(RuntimeContext.Provider, { value: runtime$ }, children);
  };
  const RenderBuiltDeck = (): ReactElement => {
    const clocks = useValue(clocks$);
    const children = jsx("section", null, useContent());
    return jsx(RenderBuiltProvider, { children, value: runtimeFrom(clocks) });
  };
  const ComputedDeck = (): ReactElement => {
    const runtime$ = useObservable(() => runtimeFrom(clocks$.get()));
    return jsx(RuntimeContext.Provider, { value: runtime$ }, jsx("section", null, useContent()));
  };
  return {
    clocks$,
    renders: () => renders,
    reset: () => {
      renders = 0;
    },
    tree: jsx(provider === "computed" ? ComputedDeck : RenderBuiltDeck),
  };
}

async function consumerRendersOverSteps(ui: MountedDom, scenario: Scenario): Promise<number> {
  const harness = presentation(scenario);
  await ui.render(harness.tree);
  await act(() => advance(harness.clocks$));
  harness.reset();
  for (let step = 0; step < STEPS; step += 1) {
    await act(() => advance(harness.clocks$));
  }
  const renders = harness.renders();
  await ui.render(null);
  return renders;
}

for (const strict of [false, true]) {
  const passes = strict ? 2 : 1;

  test(`a deck that rebuilds the runtime in render re-renders flag readers on every step (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    for (const consumer of ["whole-flags", "field-flags"] as const) {
      const renders = await consumerRendersOverSteps(ui, {
        consumer,
        memoizedContent: false,
        provider: "render-built",
      });
      assert.equal(renders, STEPS * passes, consumer);
    }
  });

  test(`flag readers skip steps only once the deck memoizes its content or computes the runtime (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    const decks = [
      { memoizedContent: true, provider: "render-built" },
      { memoizedContent: false, provider: "computed" },
    ] as const;
    for (const deck of decks) {
      const whole = await consumerRendersOverSteps(ui, { ...deck, consumer: "whole-flags" });
      const field = await consumerRendersOverSteps(ui, { ...deck, consumer: "field-flags" });
      assert.deepEqual([whole, field], [STEPS * passes, 0], deck.provider);
    }
  });

  test(`under a computed runtime, step selectors skip steps that flip no comparison (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    const deck = { memoizedContent: false, provider: "computed" } as const;
    const whole = await consumerRendersOverSteps(ui, { ...deck, consumer: "whole-step" });
    const field = await consumerRendersOverSteps(ui, { ...deck, consumer: "field-step" });
    assert.deepEqual([whole, field], [STEPS * passes, 0]);
  });

  test(`under a computed runtime, every step changes a field the lifecycle hook returns (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    const deck = { memoizedContent: false, provider: "computed" } as const;
    const whole = await consumerRendersOverSteps(ui, { ...deck, consumer: "whole-lifecycle" });
    const field = await consumerRendersOverSteps(ui, { ...deck, consumer: "field-lifecycle" });
    assert.deepEqual([whole, field], [STEPS * passes, STEPS * passes]);
  });
}
