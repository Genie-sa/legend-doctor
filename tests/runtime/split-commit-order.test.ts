import { Profiler, createElement as jsx, useState } from "react";
import { useObservable, useValue } from "@legendapp/state/react";
import type { Observable } from "@legendapp/state";
import type { ReactElement } from "react";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { mountDom } from "../../src/runtime/dom.js";
import test from "node:test";

const IDLE = "idle";
const DONE = "done";

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

interface Writers {
  /** Writes the cell a migration would convert to an observable. */
  readonly converted: (value: string) => void;
  /** Writes the cell that stays in React. */
  readonly react: (value: string) => void;
}

type Transition = (writers: Writers, work: () => Promise<void>) => Promise<void>;

interface OwnerProps {
  readonly transition: Transition;
  readonly work: () => Promise<void>;
}

interface Scenario {
  readonly name: string;
  readonly splitCommits: readonly string[];
  readonly transition: Transition;
}

function deferredWork(): Deferred {
  let release: () => void = () => {
    throw new Error("Work not initialized");
  };
  // oxlint-disable-next-line promise/avoid-new -- The test controls the exact async completion boundary.
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: () => release() };
}

function view(converted: string, react: string, run: () => Promise<void>): ReactElement {
  return jsx("button", { onClick: run, type: "button" }, `${converted}|${react}`);
}

function viewHtml(converted: string, react: string): string {
  return `<button type="button">${converted}|${react}</button>`;
}

function ReactOwner({ transition, work }: OwnerProps): ReactElement {
  const [converted, setConverted] = useState(IDLE);
  const [react, setReact] = useState(IDLE);
  return view(converted, react, () =>
    transition({ converted: setConverted, react: setReact }, work),
  );
}

function ConvertedLeaf({
  converted$,
  react,
  run,
}: {
  readonly converted$: Observable<string>;
  readonly react: string;
  readonly run: () => Promise<void>;
}): ReactElement {
  return view(useValue(converted$), react, run);
}

function ConvertedOwner({ transition, work }: OwnerProps): ReactElement {
  const converted$ = useObservable(IDLE);
  const [react, setReact] = useState(IDLE);
  const writers: Writers = { converted: (value) => converted$.set(value), react: setReact };
  return jsx(ConvertedLeaf, { converted$, react, run: () => transition(writers, work) });
}

function setActEnvironment(enabled: boolean): void {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: enabled,
    writable: true,
  });
}

/** Resolves the awaited work outside `act`, so only React's own lanes decide what commits together. */
async function settleOutsideAct(deferred: Deferred): Promise<void> {
  setActEnvironment(false);
  try {
    deferred.resolve();
    await delay(20);
  } finally {
    setActEnvironment(true);
  }
}

const SINGLE_COMMIT = [viewHtml(DONE, DONE)];
const CONVERTED_FIRST = [viewHtml(DONE, IDLE), viewHtml(DONE, DONE)];

/**
 * Risk: React 19 renders a `useSyncExternalStore` notification together with every update pending
 * at its microtask flush, so writes in one stretch still commit once. A write that a promise
 * settlement resumes after the observable's flush lands in a later commit, splitting one transition
 * and publishing the converted cell first.
 */
const SCENARIOS: readonly Scenario[] = [
  {
    name: "writes in one stretch after an await",
    splitCommits: SINGLE_COMMIT,
    transition: async ({ converted, react }, work) => {
      await work();
      converted(DONE);
      react(DONE);
    },
  },
  {
    name: "an awaited helper writes before the caller's finally",
    splitCommits: CONVERTED_FIRST,
    transition: async ({ converted, react }, work) => {
      const run = async (): Promise<void> => {
        await work();
        converted(DONE);
      };
      try {
        await run();
      } finally {
        react(DONE);
      }
    },
  },
  {
    name: "a then callback writes before a chained finally",
    splitCommits: CONVERTED_FIRST,
    /* oxlint-disable promise/prefer-await-to-then -- The chained callbacks are the timing under test. */
    transition: ({ converted, react }, work) =>
      work()
        .then(() => converted(DONE))
        .finally(() => react(DONE)),
    /* oxlint-enable promise/prefer-await-to-then */
  },
  {
    name: "a rethrowing helper writes before the caller's catch",
    splitCommits: CONVERTED_FIRST,
    transition: async ({ converted, react }, work) => {
      const run = async (): Promise<void> => {
        try {
          await work();
          throw new Error("rejected");
        } catch (error) {
          converted(DONE);
          throw error;
        }
      };
      try {
        await run();
      } catch {
        react(DONE);
      }
    },
  },
  {
    name: "the React write resumes a microtask before the observable",
    splitCommits: SINGLE_COMMIT,
    transition: async ({ converted, react }, work) => {
      const run = async (): Promise<void> => {
        await work();
        react(DONE);
      };
      try {
        await run();
      } finally {
        converted(DONE);
      }
    },
  },
];

/** The distinct markups committed once the awaited work settles, recorded in a DOM of its own. */
async function settledCommits(
  context: TestContext,
  Owner: (props: OwnerProps) => ReactElement,
  { strict, transition }: { readonly strict: boolean; readonly transition: Transition },
): Promise<readonly string[]> {
  const ui = mountDom(context, strict);
  const deferred = deferredWork();
  const commits: string[] = [];
  await ui.render(
    jsx(
      Profiler,
      { id: "transition", onRender: () => commits.push(ui.html()) },
      jsx(Owner, { transition, work: () => deferred.promise }),
    ),
  );
  await ui.click("button");
  commits.length = 0;

  await settleOutsideAct(deferred);

  assert.equal(ui.html(), viewHtml(DONE, DONE));
  return [...new Set(commits)];
}

for (const { name, splitCommits, transition } of SCENARIOS) {
  for (const strict of [false, true]) {
    test(`React 19 commit order when ${name} (strict=${strict})`, async (context) => {
      await context.test("React state", async (subtest) => {
        assert.deepEqual(
          await settledCommits(subtest, ReactOwner, { strict, transition }),
          SINGLE_COMMIT,
        );
      });
      await context.test("one converted cell", async (subtest) => {
        assert.deepEqual(
          await settledCommits(subtest, ConvertedOwner, { strict, transition }),
          splitCommits,
        );
      });
    });
  }
}
