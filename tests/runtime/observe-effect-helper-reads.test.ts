import { act, createElement as jsx, useEffect } from "react";
import { useObserveEffect, useValue } from "@legendapp/state/react";
import type { Observable } from "@legendapp/state";
import assert from "node:assert/strict";
import { mountDom } from "../../src/runtime/dom.js";
import { observable } from "@legendapp/state";
import { setTimeout } from "node:timers/promises";
import test from "node:test";

interface MailState {
  errorId: string;
  selectedId: string;
}

type Mail$ = Observable<MailState>;

/** Records each thread fetch and fails the first `failures` of them. */
interface Server {
  failures: number;
  readonly fetches: string[];
}

type ThreadLoader = (mail$: Mail$, server: Server, id: string) => Promise<void>;

interface ReaderProps {
  mail$: Mail$;
  server: Server;
}

async function fetchThread(server: Server, id: string): Promise<void> {
  server.fetches.push(id);
  await Promise.resolve();
  if (server.failures > 0) {
    server.failures -= 1;
    throw new Error("offline");
  }
}

/** A shared loader that clears a stale error for the thread before its first `await`. */
function threadLoader(readErrorId: (mail$: Mail$) => string): ThreadLoader {
  return async (mail$, server, id) => {
    if (readErrorId(mail$) === id) {
      mail$.errorId.set("");
    }
    try {
      await fetchThread(server, id);
    } catch {
      mail$.errorId.set(id);
    }
  };
}

const loadThread = threadLoader((mail$) => mail$.errorId.get());
const loadThreadPeekingError = threadLoader((mail$) => mail$.errorId.peek());

function ReactReader({ mail$, server }: ReaderProps): null {
  const selectedId = useValue(mail$.selectedId);
  useEffect(() => {
    if (!selectedId) {
      return;
    }
    loadThread(mail$, server, selectedId);
  }, [mail$, selectedId, server]);
  return null;
}

function ObservedReader({ mail$, server }: ReaderProps): null {
  useObserveEffect(() => {
    const selectedId = mail$.selectedId.get();
    if (selectedId) {
      loadThread(mail$, server, selectedId);
    }
  });
  return null;
}

function ObservedPeekingReader({ mail$, server }: ReaderProps): null {
  useObserveEffect(() => {
    const selectedId = mail$.selectedId.get();
    if (selectedId) {
      loadThreadPeekingError(mail$, server, selectedId);
    }
  });
  return null;
}

/** Lets every pending fetch settle, including the retries settled fetches start. */
async function settle(): Promise<void> {
  await act(() => setTimeout(0));
}

const FAILURES = 2;

/**
 * Against a server that fails twice, the React effect fetches once and leaves the error on screen.
 * The observer tracks the loader's `errorId.get()` before its first `await`, so each failure reruns
 * the reaction twice, for the recorded error and for the rerun's own clear of it, until the server
 * answers; an unrelated `errorId` write fetches once more. Peeking the read inside the loader
 * restores the React behavior.
 */
const readers = [
  [ReactReader, 1, "a", 0],
  [ObservedReader, 2 * FAILURES + 1, "", 1],
  [ObservedPeekingReader, 1, "a", 0],
] as const;

for (const [Reader, fetches, error, refetches] of readers) {
  test(`${Reader.name} ${fetches === 1 ? "fetches once" : "retries"} when a fetch fails`, async (context) => {
    const ui = mountDom(context, false);
    const server: Server = { failures: FAILURES, fetches: [] };
    const mail$ = observable<MailState>({ errorId: "", selectedId: "a" });
    await ui.render(jsx(Reader, { mail$, server }));
    await settle();

    assert.equal(server.fetches.length, fetches);
    assert.equal(mail$.errorId.peek(), error);

    server.fetches.length = 0;
    await act(() => mail$.errorId.set("b"));
    await settle();
    assert.equal(server.fetches.length, refetches);
  });
}
