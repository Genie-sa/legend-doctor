import { act, createElement as jsx, useEffect } from "react";
import { useObserveEffect, useValue } from "@legendapp/state/react";
import type { Observable } from "@legendapp/state";
import assert from "node:assert/strict";
import { mountDom } from "../../src/runtime/dom.js";
import { observable } from "@legendapp/state";
import test from "node:test";

interface WindowState {
  autoClose: boolean;
  isOpen: boolean;
  isPlaying: boolean;
}

interface ManagerProps {
  runs: string[];
  state$: Observable<WindowState>;
}

function closeWhenStopped(state$: Observable<WindowState>, isOpen: boolean): void {
  if (isOpen) {
    state$.isOpen.set(false);
  }
}

function ReactManager({ runs, state$ }: ManagerProps): null {
  const isPlaying = useValue(state$.isPlaying);
  const autoClose = useValue(state$.autoClose);
  useEffect(() => {
    runs.push("run");
    if (!isPlaying && autoClose) {
      closeWhenStopped(state$, state$.isOpen.get());
    }
  }, [autoClose, isPlaying, runs, state$]);
  return null;
}

function UnpeekedManager({ runs, state$ }: ManagerProps): null {
  useObserveEffect(() => {
    runs.push("run");
    if (!state$.isPlaying.get() && state$.autoClose.get()) {
      closeWhenStopped(state$, state$.isOpen.get());
    }
  });
  return null;
}

function PeekedManager({ runs, state$ }: ManagerProps): null {
  useObserveEffect(() => {
    runs.push("run");
    if (!state$.isPlaying.get() && state$.autoClose.get()) {
      closeWhenStopped(state$, state$.isOpen.peek());
    }
  });
  return null;
}

/**
 * Each version with its reaction runs for opening the window while paused, then for playing, opening and stopping.
 * The unpeeked reaction also reruns on its own close write because it tracks `isOpen`.
 */
const managers = [
  [ReactManager, 0, 2],
  [UnpeekedManager, 2, 3],
  [PeekedManager, 0, 2],
] as const;

for (const [Manager, incidentalRuns, triggerRuns] of managers) {
  test(`${Manager.name} ${incidentalRuns === 0 ? "keeps" : "closes"} a window opened while paused`, async (context) => {
    const ui = mountDom(context, false);
    const runs: string[] = [];
    const state$ = observable<WindowState>({ autoClose: true, isOpen: false, isPlaying: false });
    await ui.render(jsx(Manager, { runs, state$ }));
    runs.length = 0;

    await act(() => state$.isOpen.set(true));

    assert.equal(runs.length, incidentalRuns);
    assert.equal(state$.isOpen.peek(), incidentalRuns === 0);

    runs.length = 0;
    await act(() => state$.isPlaying.set(true));
    await act(() => state$.isOpen.set(true));
    await act(() => state$.isPlaying.set(false));
    assert.equal(runs.length, triggerRuns);
    assert.equal(state$.isOpen.peek(), false, "stopping playback closes the window");
  });
}
