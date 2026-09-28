import {
  converted,
  manager,
  projectVerdict,
  sourceVerdict,
  untrackableCall,
} from "./observable-reaction-fixtures.js";
import type { ReactionVerdict } from "./observable-reaction-fixtures.js";
import assert from "node:assert/strict";
import test from "node:test";

const REFRESH_BODY = "if (isPlaying && autoClose) void refresh();";

const NAVIGATOR_BODY = 'if (isPlaying && autoClose) void navigator.open("a");';

const KEYED_OPEN_BODY = "if (isPlaying && autoClose) void navigator.open(WINDOW_KEY);";

const KEYED_OPEN =
  "const entry = registry.get(key); await load(entry); report(window$.isOpen.get());";

function navigatorFactory(open: string): string {
  return `const navigator = createNavigator();
    function createNavigator() {
      const registry = new Map<string, number>();
      const open = async (key) => { ${open} };
      return { open };
    }`;
}

const helperCases: readonly (readonly [string, string, string, string, ReactionVerdict])[] = [
  [
    "blocks a call whose helper reads an observable before its first await",
    REFRESH_BODY,
    "",
    "async function refresh() { if (window$.isOpen.get()) return; await load(); }",
    untrackableCall("refresh"),
  ],
  [
    "blocks a helper read that runs when a conditional await is skipped",
    REFRESH_BODY,
    "",
    "async function refresh() { if (paused()) { await pause(); } report(window$.size.get()); }",
    untrackableCall("refresh"),
  ],
  [
    "blocks a helper read in a catch that a throwing await operand reaches synchronously",
    REFRESH_BODY,
    "",
    "async function refresh() { try { await load(); } catch { report(window$.isOpen.get()); } }",
    untrackableCall("refresh"),
  ],
  [
    "blocks a read two calls deep",
    REFRESH_BODY,
    "",
    "function refresh() { return measure(); } function measure() { return window$.size.width.get(); }",
    untrackableCall("refresh"),
  ],
  [
    "blocks a read in a callback the helper hands to a global function",
    REFRESH_BODY,
    "",
    "function refresh() { register(() => report(window$.isOpen.get())); }",
    untrackableCall("refresh"),
  ],
  [
    "blocks a helper that subscribes through useValue",
    REFRESH_BODY,
    "",
    "function refresh() { return useValue(window$.size); }",
    untrackableCall("refresh"),
  ],
  [
    "blocks a helper that loops over an observable array",
    REFRESH_BODY,
    "",
    "const list$ = observable([1]); function refresh() { list$.forEach((item) => report(item)); }",
    untrackableCall("refresh"),
  ],
  [
    "blocks a function held in a variable",
    REFRESH_BODY,
    "const refresh = pickRefresh(player$);",
    "",
    untrackableCall("refresh"),
  ],
  [
    "blocks a method of an object the application defines",
    "if (isPlaying && autoClose) void sync.refresh();",
    "",
    "const sync = { refresh() { return window$.isOpen.get(); } };",
    untrackableCall("sync.refresh"),
  ],
  [
    "blocks a callback prop, whose code is not in view",
    "if (isPlaying && autoClose) onStop();",
    "",
    "",
    untrackableCall("onStop"),
  ],
  [
    "blocks a factory-built method that reads an observable before its first await",
    NAVIGATOR_BODY,
    "",
    navigatorFactory("report(window$.isOpen.get()); await load(registry.get(key));"),
    untrackableCall("navigator.open"),
  ],
  [
    "blocks a factory-built method handed a key that may hold a function",
    KEYED_OPEN_BODY,
    "",
    `const WINDOW_KEY = pickKey(); ${navigatorFactory(KEYED_OPEN)}`,
    untrackableCall("navigator.open"),
  ],
  [
    "blocks a method of an object that spreads another",
    "if (isPlaying && autoClose) sync.close();",
    "",
    "const sync = { ...base, close() { window$.isOpen.set(false); } };",
    untrackableCall("sync.close"),
  ],
  [
    "blocks a method of an object held in a reassignable binding",
    "if (isPlaying && autoClose) sync.close();",
    "",
    "let sync = { close() { window$.isOpen.set(false); } };",
    untrackableCall("sync.close"),
  ],
  [
    "follows a helper that reads only after its first unconditional await",
    REFRESH_BODY,
    "",
    "async function refresh() { await load(); report(window$.isOpen.get()); }",
    converted(),
  ],
  [
    "follows a helper that only writes and peeks observables",
    REFRESH_BODY,
    "",
    "function refresh() { report(window$.size.peek()); window$.isOpen.set(false); window$.assign({ isOpen: false }); }",
    converted(),
  ],
  [
    "abstains on a helper that reads only the trigger leaves",
    REFRESH_BODY,
    "",
    "function refresh() { report(player$.isPlaying.get(), player$.autoClose.get()); }",
    untrackableCall("refresh"),
  ],
  [
    "abstains on a method of a constant object literal",
    "if (isPlaying && autoClose) sync.close();",
    "",
    "const sync = { close() { window$.isOpen.set(false); } };",
    untrackableCall("sync.close"),
  ],
  [
    "abstains on a factory-built method that reads only after its first await",
    NAVIGATOR_BODY,
    "",
    navigatorFactory("await load(registry.get(key)); report(window$.isOpen.get());"),
    untrackableCall("navigator.open"),
  ],
  [
    "follows a helper that calls built-in methods on local constants",
    REFRESH_BODY,
    "",
    "function refresh() { const tag = navigator.language; const lower = (tag || '').toLowerCase(); return lower.startsWith('en'); }",
    converted(),
  ],
  [
    "blocks a method of a constant that a project function builds",
    REFRESH_BODY,
    "",
    "function refresh() { const sync = pickSync(); sync.close(); } function pickSync() { return { close: () => window$.isOpen.get() }; }",
    untrackableCall("refresh"),
  ],
  [
    "follows a component helper that only calls a React setter",
    REFRESH_BODY,
    "const [, setCount] = useState(0); const refresh = () => setCount(1);",
    "",
    converted(),
  ],
  [
    "leaves a helper handed to a timer alone",
    "if (isPlaying && autoClose) setTimeout(refresh, 10);",
    "",
    "function refresh() { report(window$.isOpen.get()); }",
    converted(),
  ],
  [
    "still peeks a direct read while following a helper that only writes",
    "if (!isPlaying && autoClose && window$.isOpen.get()) close();",
    "",
    "function close() { window$.isOpen.set(false); }",
    converted("window$.isOpen.get()"),
  ],
];

for (const [name, body, extraHooks, helpers, expected] of helperCases) {
  test(`observable reaction reads: ${name}`, () => {
    assert.deepEqual(sourceVerdict(manager(body, extraHooks, helpers)), expected);
  });
}

test("observable reaction reads: blocks a helper imported from a module that is not in view", () => {
  const source = manager(REFRESH_BODY).replace(
    'import { useEffect, useState } from "react";',
    'import { useEffect, useState } from "react";\nimport { refresh } from "./sync";',
  );
  assert.deepEqual(sourceVerdict(source), untrackableCall("refresh"));
});

function describedStore(guard: string): string {
  return manager(
    "if (isPlaying && autoClose) describe(store);",
    "",
    `function describe(value: unknown) { return ${guard}(value); }`,
  ).replace(
    'import { observable } from "@legendapp/state";',
    `import { ${guard}, observable } from "@legendapp/state";`,
  );
}

test("observable reaction reads: follows a Legend type guard handed a value of unknown shape", () => {
  assert.deepEqual(sourceVerdict(describedStore("isString")), converted());
});

const MAIL = `
  import { observable } from "@legendapp/state";
  export const mail$ = observable({ errorId: "", openedId: "", selectedId: "" });
  export async function loadThread(id: string) {
    if (mail$.errorId.get() === id) mail$.errorId.set("");
    try {
      await fetchThread(id);
    } catch {
      mail$.errorId.set(id);
    }
  }
  export function openThread(id: string) {
    if (mail$.selectedId.get() === id) mail$.openedId.set(id);
  }
`;

function reader(helper: string): string {
  return `
    import { useEffect } from "react";
    import { useValue } from "@legendapp/state/react";
    import { ${helper}, mail$ } from "./mail";
    export function Reader() {
      const selectedId = useValue(mail$.selectedId);
      useEffect(() => {
        if (!selectedId) return;
        void ${helper}(selectedId);
      }, [selectedId]);
      return null;
    }
  `;
}

test("observable reaction reads: blocks an imported helper that reads an observable before its first await", async () => {
  assert.deepEqual(
    await projectVerdict({ "mail.ts": MAIL, "Reader.tsx": reader("loadThread") }),
    untrackableCall("loadThread"),
  );
});

test("observable reaction reads: abstains on an imported helper that reads only the trigger", async () => {
  assert.deepEqual(
    await projectVerdict({ "mail.ts": MAIL, "Reader.tsx": reader("openThread") }),
    untrackableCall("openThread"),
  );
});

const WINDOWS = `
  import { observable } from "@legendapp/state";
  export const layout$ = observable({ width: 1 });
  function createNavigator() {
    const measure = () => layout$.width.get();
    const open = async (id: string) => {
      await showWindow(id);
      return layout$.width.get();
    };
    return { measure, open };
  }
  export const navigator = createNavigator();
`;

function navigatorReader(method: string): string {
  return reader("openThread")
    .replace(
      'import { openThread, mail$ } from "./mail";',
      'import { mail$ } from "./mail";\n    import { navigator } from "./windows";',
    )
    .replace("void openThread(selectedId);", `void navigator.${method}(selectedId);`);
}

test("observable reaction reads: blocks an imported factory-built method that reads before its first await", async () => {
  assert.deepEqual(
    await projectVerdict({
      "mail.ts": MAIL,
      "Reader.tsx": navigatorReader("measure"),
      "windows.ts": WINDOWS,
    }),
    untrackableCall("navigator.measure"),
  );
});
