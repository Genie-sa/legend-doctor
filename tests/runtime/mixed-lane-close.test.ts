import { createElement as jsx, startTransition, useLayoutEffect, useState } from "react";
import { useObservable, useValue } from "@legendapp/state/react";
import type { Observable } from "@legendapp/state";
import type { ReactElement } from "react";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { mountDom } from "../../src/runtime/dom.js";
import test from "node:test";

/** Each commit of the prompt while it is mounted, as the value its input shows. */
type PromptCommits = string[];

interface PromptProps {
  commits: PromptCommits;
  value: string;
}

interface ObservablePromptProps {
  commits: PromptCommits;
  value$: Observable<string>;
}

type Close = () => void;

/** Where an owner publishes its close command, so a test can call it outside React events. */
interface CloseHandle {
  close?: Close;
}

interface OwnerProps {
  commits: PromptCommits;
  onClose: (close: Close) => void;
}

function Prompt({ commits, value }: PromptProps): ReactElement {
  useLayoutEffect(() => {
    commits.push(value);
  });
  return jsx("input", { readOnly: true, value });
}

function ObservablePrompt({ commits, value$ }: ObservablePromptProps): ReactElement {
  return jsx(Prompt, { commits, value: useValue(value$) });
}

/** The replay parent: the visibility flag and the typed ref are both React state. */
function StateOwner({ commits, onClose }: OwnerProps): ReactElement {
  const [visible, setVisible] = useState(true);
  const [input, setInput] = useState("main");
  const close = (): void => {
    setVisible(false);
    setInput("");
  };
  onClose(close);
  return jsx(
    "section",
    null,
    jsx("button", { onClick: close, type: "button" }),
    visible ? jsx(Prompt, { commits, value: input }) : null,
  );
}

/** The labeled edit alone: the typed ref moves to an owner observable, the flag stays React state. */
function ObservableOwner({ commits, onClose }: OwnerProps): ReactElement {
  const [visible, setVisible] = useState(true);
  const input$ = useObservable("main");
  const close = (): void => {
    setVisible(false);
    input$.set("");
  };
  onClose(close);
  return jsx(
    "section",
    null,
    jsx("button", { onClick: close, type: "button" }),
    visible ? jsx(ObservablePrompt, { commits, value$: input$ }) : null,
  );
}

/** A control whose flag update is deferred, so the observable write commits into the visible prompt first. */
function TransitionOwner({ commits, onClose }: OwnerProps): ReactElement {
  const [visible, setVisible] = useState(true);
  const input$ = useObservable("main");
  const close = (): void => {
    startTransition(() => setVisible(false));
    input$.set("");
  };
  onClose(close);
  return jsx(
    "section",
    null,
    jsx("button", { onClick: close, type: "button" }),
    visible ? jsx(ObservablePrompt, { commits, value$: input$ }) : null,
  );
}

interface CloseScenario {
  origin: "click" | "callback";
  owner: typeof StateOwner;
  strict: boolean;
}

function setActEnvironment(enabled: boolean): void {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: enabled,
    writable: true,
  });
}

/** Commits the prompt makes after mount when `close` runs from a click or from a native-style callback. */
async function closeCommits(
  context: TestContext,
  { origin, owner, strict }: CloseScenario,
): Promise<PromptCommits> {
  const ui = mountDom(context, strict);
  const commits: PromptCommits = [];
  const closer: CloseHandle = {};
  await ui.render(
    jsx(owner, {
      commits,
      onClose: (next: Close) => {
        closer.close = next;
      },
    }),
  );
  commits.length = 0;
  if (origin === "click") {
    await ui.click("button");
  } else {
    setActEnvironment(false);
    try {
      await delay(0);
      closer.close?.();
      await delay(20);
    } finally {
      setActEnvironment(true);
    }
  }
  assert.equal(ui.html(), '<section><button type="button"></button></section>');
  return commits;
}

for (const strict of [false, true]) {
  test(`a synchronous close unmounts the prompt before it shows the cleared ref; only a deferred flag lets it through (strict=${strict})`, async (context) => {
    for (const owner of [StateOwner, ObservableOwner]) {
      for (const origin of ["click", "callback"] as const) {
        await context.test(`${owner.name} ${origin}`, async (subtest) => {
          assert.deepEqual(await closeCommits(subtest, { origin, owner, strict }), []);
        });
      }
    }
    await context.test("TransitionOwner callback", async (subtest) => {
      assert.deepEqual(
        await closeCommits(subtest, { origin: "callback", owner: TransitionOwner, strict }),
        [""],
      );
    });
  });
}
