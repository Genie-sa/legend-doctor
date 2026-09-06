import { StrictMode, act, createElement } from "react";
import { JSDOM } from "jsdom";
import type { ReactNode } from "react";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createRoot } from "react-dom/client";
import process from "node:process";

/** A jsdom-backed React root with the interactions a render-count comparison needs. */
export interface MountedDom {
  element: (selector: string) => Element;
  render: (children: ReactNode) => Promise<void>;
  click: (selector: string) => Promise<void>;
  input: (selector: string, value: string) => Promise<void>;
  submit: () => Promise<void>;
  signal: (name: string) => Promise<void>;
  /** The container's current markup, for step-by-step DOM comparison between two versions. */
  html: () => string;
}

/** Tallies one render of the named component; call it at the top of the component body. */
export function count(renders: Map<string, number>, name: string): void {
  renders.set(name, (renders.get(name) ?? 0) + 1);
}

interface InstalledDom {
  readonly dom: JSDOM;
  readonly restore: () => void;
}

function installDom(): InstalledDom {
  const previousEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  const dom = new JSDOM("<!doctype html><html><body><main></main></body></html>");
  const globals = {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  return {
    dom,
    restore: () => {
      dom.window.close();
      if (previousEnvironment === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousEnvironment;
      }
      for (const [key, descriptor] of previous) {
        if (descriptor) {
          Object.defineProperty(globalThis, key, descriptor);
        } else {
          Reflect.deleteProperty(globalThis, key);
        }
      }
    },
  };
}

interface Mount {
  readonly container: Element;
  readonly dom: JSDOM;
  readonly strict: boolean;
  readonly root: ReturnType<typeof createRoot>;
}

function interactions({ container, dom, root, strict }: Mount): MountedDom {
  function element(selector: string): Element {
    const selected = container.querySelector(selector);
    assert.ok(selected, `Missing element: ${selector}`);
    return selected;
  }
  return {
    element,
    html: () => container.innerHTML,
    async render(children: ReactNode): Promise<void> {
      await act(() => root.render(strict ? createElement(StrictMode, null, children) : children));
    },
    async click(selector: string): Promise<void> {
      await act(() =>
        element(selector).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })),
      );
    },
    async input(selector: string, value: string): Promise<void> {
      const input = element(selector);
      assert.ok(input instanceof dom.window.HTMLInputElement);
      await act(() => {
        input.value = value;
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    },
    async submit(): Promise<void> {
      await act(() =>
        element("form").dispatchEvent(
          new dom.window.Event("submit", { bubbles: true, cancelable: true }),
        ),
      );
    },
    async signal(name: string): Promise<void> {
      await act(() => dom.window.dispatchEvent(new dom.window.Event(name)));
    },
  };
}

/** Each test owns its DOM and restores the process globals after unmounting React. */
export function mountDom(context: TestContext, strict: boolean): MountedDom {
  const { dom, restore } = installDom();
  const container = dom.window.document.querySelector("main")!;
  const root = createRoot(container);
  context.after(async () => {
    try {
      await act(() => root.unmount());
    } finally {
      restore();
    }
  });
  return interactions({ container, dom, root, strict });
}
