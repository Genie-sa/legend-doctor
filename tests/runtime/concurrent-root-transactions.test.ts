import { batch, observable, observe } from "@legendapp/state";
import { count, mountDom } from "../../src/runtime/dom.js";
import { createElement as jsx, useLayoutEffect } from "react";
import type { Observable } from "@legendapp/state";
import type { ReactElement } from "react";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { useValue } from "@legendapp/state/react";

interface Player {
  index: number;
  playing: boolean;
}

interface PlayerViewProps {
  commits: string[];
  player$: Observable<Player>;
  renders: Map<string, number>;
}

interface TransactionOutcome {
  commits: readonly string[];
  observed: readonly string[];
  renders: number;
}

function PlayerView({ commits, player$, renders }: PlayerViewProps): ReactElement {
  count(renders, "PlayerView");
  const index = useValue(player$.index);
  const playing = useValue(player$.playing);
  useLayoutEffect(() => {
    commits.push(`${index}/${playing}`);
  });
  return jsx("output", null, `${index}/${playing}`);
}

/** Writes after a timer outside `act`, where only React's own scheduler can coalesce renders. */
async function writeOutsideAct(write: () => void): Promise<void> {
  setActEnvironment(false);
  try {
    await delay(0);
    write();
    await delay(20);
  } finally {
    setActEnvironment(true);
  }
}

function unbatched(write: () => void): void {
  write();
}

function setActEnvironment(enabled: boolean): void {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: enabled,
    writable: true,
  });
}

async function transactionOutcome(
  context: TestContext,
  strict: boolean,
  [mode, transaction]: readonly [string, (write: () => void) => void],
): Promise<TransactionOutcome> {
  let outcome: TransactionOutcome = { commits: [], observed: [], renders: 0 };
  await context.test(mode, async (subtest) => {
    const ui = mountDom(subtest, strict);
    const player$ = observable<Player>({ index: 0, playing: false });
    const commits: string[] = [];
    const observed: string[] = [];
    const renders = new Map<string, number>();
    await ui.render(jsx(PlayerView, { commits, player$, renders }));
    subtest.after(
      observe(() => {
        observed.push(`${player$.index.get()}/${player$.playing.get()}`);
      }),
    );
    commits.length = 0;
    observed.length = 0;
    renders.clear();

    await writeOutsideAct(() =>
      transaction(() => {
        player$.index.set(1);
        player$.playing.set(true);
      }),
    );

    assert.equal(ui.html(), "<output>1/true</output>");
    outcome = { commits, observed, renders: renders.get("PlayerView") ?? 0 };
  });
  return outcome;
}

for (const strict of [false, true]) {
  test(`a concurrent root commits separate Legend writes once; only a multi-path observer sees them apart (strict=${strict})`, async (context) => {
    const separate = await transactionOutcome(context, strict, ["separate", unbatched]);
    const batched = await transactionOutcome(context, strict, ["batched", batch]);

    assert.equal(separate.renders, batched.renders);
    assert.deepEqual(separate.commits, ["1/true"]);
    assert.deepEqual(batched.commits, ["1/true"]);
    assert.deepEqual(separate.observed, ["1/false", "1/true"]);
    assert.deepEqual(batched.observed, ["1/true"]);
  });
}
