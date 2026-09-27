import type { Change, Observable } from "@legendapp/state";
import { batch, observable, observe } from "@legendapp/state";
import { count, mountDom } from "../../src/runtime/dom.js";
import { createElement as jsx, useLayoutEffect } from "react";
import { JSDOM } from "jsdom";
import { ObservablePersistLocalStorageBase } from "@legendapp/state/persist-plugins/local-storage";
import type { ReactElement } from "react";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { syncObservable } from "@legendapp/state/sync";
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

type Transaction = (write: () => void) => void;

/** Legend's storage-backed persistence plugin, recording each save it receives. */
class RecordingPersistence extends ObservablePersistLocalStorageBase {
  public readonly saves: string[][] = [];

  public constructor(storage: Storage) {
    super(storage);
  }

  public override set(table: string, changes: Change[]): void {
    this.saves.push(changes.map((change) => change.path.join(".")).toSorted());
    super.set(table, changes);
  }
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
  [mode, transaction]: readonly [string, Transaction],
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

test("persistence saves separate writes together; a parent onChange listener still sees them apart", async (context) => {
  const outcomes = new Map<string, { notifications: string[][]; saves: string[][] }>();
  for (const [mode, transaction] of [
    ["separate", unbatched],
    ["batched", batch],
  ] as const satisfies readonly (readonly [string, Transaction])[]) {
    const player$ = observable<Player>({ index: 0, playing: false });
    const { window } = new JSDOM("", { url: "http://localhost/" });
    context.after(() => window.close());
    const persistence = new RecordingPersistence(window.localStorage);
    const notifications: string[][] = [];
    context.after(
      player$.onChange(({ changes }) => {
        notifications.push(changes.map((change) => change.path.join(".")));
      }),
    );
    syncObservable(player$, { persist: { name: `player-${mode}`, plugin: persistence } });
    await delay(0);
    persistence.saves.length = 0;

    transaction(() => {
      player$.index.set(1);
      player$.playing.set(true);
    });
    await delay(0);

    outcomes.set(mode, { notifications, saves: persistence.saves });
  }

  assert.deepEqual(outcomes.get("separate"), {
    notifications: [["index"], ["playing"]],
    saves: [["index", "playing"]],
  });
  assert.deepEqual(outcomes.get("batched"), {
    notifications: [["index", "playing"]],
    saves: [["index", "playing"]],
  });
});
