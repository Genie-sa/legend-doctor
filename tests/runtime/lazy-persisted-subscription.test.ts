import { createElement as jsx, useEffect } from "react";
import { JSDOM } from "jsdom";
import type { Observable } from "@legendapp/state";
import { ObservablePersistLocalStorageBase } from "@legendapp/state/persist-plugins/local-storage";
import type { ReactElement } from "react";
import assert from "node:assert/strict";
import { mountDom } from "../../src/runtime/dom.js";
import { observable } from "@legendapp/state";
import { synced } from "@legendapp/state/sync";
import test from "node:test";
import { useValue } from "@legendapp/state/react";

interface Preferences {
  autoClose: boolean;
}

/** Legend's storage plugin behind an async load that finishes only when the test releases it. */
class DeferredPersistence extends ObservablePersistLocalStorageBase {
  public loads = 0;
  public readonly release: () => void;
  private readonly loaded: Promise<void>;

  public constructor(storage: Storage) {
    super(storage);
    let release = (): void => {
      throw new Error("not initialized");
    };
    // eslint-disable-next-line promise/avoid-new -- The test controls when the persisted load settles.
    this.loaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.release = release;
  }

  public async loadTable(): Promise<void> {
    this.loads += 1;
    await this.loaded;
  }
}

interface Store {
  readonly plugin: DeferredPersistence;
  readonly preferences$: Observable<Preferences>;
}

function persistedStore(): Store {
  const { localStorage } = new JSDOM("", { url: "http://localhost" }).window;
  localStorage.setItem("preferences", JSON.stringify({ autoClose: false }));
  const plugin = new DeferredPersistence(localStorage);
  const preferences$ = observable<Preferences>(
    synced({ initial: { autoClose: true }, persist: { name: "preferences", plugin } }),
  );
  return { plugin, preferences$ };
}

interface ManagerProps {
  readonly commands: boolean[];
  readonly preferences$: Observable<Preferences>;
}

function useCloseCommand({ commands, preferences$ }: ManagerProps): void {
  useEffect(() => {
    const close = (): void => {
      commands.push(preferences$.autoClose.peek());
    };
    globalThis.window.addEventListener("close", close);
    return (): void => globalThis.window.removeEventListener("close", close);
  }, [commands, preferences$]);
}

function SubscribedManager(props: ManagerProps): ReactElement {
  useValue(props.preferences$.autoClose);
  useCloseCommand(props);
  return jsx("output");
}

function UnsubscribedManager(props: ManagerProps): ReactElement {
  useCloseCommand(props);
  return jsx("output");
}

for (const strict of [false, true]) {
  test(`deleting an unread subscription on a lazy persisted path delays its load (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    const observed = new Map<string, { loadsAfterMount: number; commands: boolean[] }>();
    for (const Manager of [SubscribedManager, UnsubscribedManager]) {
      const { plugin, preferences$ } = persistedStore();
      const commands: boolean[] = [];
      await ui.render(jsx(Manager, { commands, preferences$ }));
      const loadsAfterMount = plugin.loads;
      plugin.release();
      await ui.render(jsx(Manager, { commands, preferences$ }));
      await ui.signal("close");
      await ui.signal("close");
      await ui.render(null);
      observed.set(Manager.name, { loadsAfterMount, commands });
    }
    assert.deepEqual(observed.get(SubscribedManager.name), {
      loadsAfterMount: 1,
      commands: [false, false],
    });
    assert.deepEqual(
      observed.get(UnsubscribedManager.name),
      { loadsAfterMount: 0, commands: [true, false] },
      "the first peek activates the root and reads the default before the persisted value loads",
    );
  });
}
