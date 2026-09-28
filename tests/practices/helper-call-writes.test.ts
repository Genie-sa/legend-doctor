import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import test from "node:test";

function narrowings(module: string): number {
  return analyzeLegendPractices({
    fileName: "fixture.tsx",
    sourceText: `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const profile$ = observable({ name: "Ada", email: "ada@example.com" });
    ${module}
    export function Profile() {
      const profile = useValue(profile$);
      return <h1>{profile.name}</h1>;
    }
  `,
  }).filter((finding) => finding.action === "narrow-use-value-subscription").length;
}

test("a helper's writes join every stretch that calls it", () => {
  assert.equal(
    narrowings(`
    function clearEmail() { profile$.email.set(""); }
    export function reset() {
      profile$.name.set("");
      clearEmail();
    }`),
    0,
  );
  assert.equal(
    narrowings(`
    const clearEmail = () => profile$.email.set("");
    export function reset() {
      clearEmail();
      profile$.name.set("");
    }
    export function Button() { return <button onClick={clearEmail} />; }`),
    1,
    "a helper that is also handed out as a handler runs alone too",
  );
});

test("a helper call before an await stays in the caller's first stretch", () => {
  assert.equal(
    narrowings(`
    declare function save(): Promise<void>;
    function clearEmail() { profile$.email.set(""); }
    export async function reset() {
      profile$.name.set("");
      await save();
      clearEmail();
    }`),
    1,
  );
});

test("a stretch that calls application code it does not follow proves nothing", () => {
  for (const module of [
    `import { track } from "./analytics";
    export function write() { profile$.email.set(""); track(); }`,
    `export function write(notify: () => void) { profile$.email.set(""); notify(); }`,
    `export function write({ onDone }: { onDone: () => void }) { profile$.email.set(""); onDone(); }`,
    `import { dialog } from "./dialogs";
    export function write() { profile$.email.set(""); dialog.close(); }`,
    `const actions$ = observable({ reset: () => profile$.name.set("") });
    export function write() { profile$.email.set(""); actions$.reset(); }`,
  ]) {
    assert.equal(narrowings(module), 0, module);
  }
  for (const module of [
    `import { track } from "analytics-sdk";
    export function write() { profile$.email.set(""); track("email"); }`,
    `const tags$ = observable<string[]>([]);
    export function write() { profile$.email.set(""); tags$.push("email"); }`,
    `import { useState } from "react";
    export function Editor() {
      const [, setDirty] = useState(false);
      return <button onClick={() => { profile$.email.set(""); setDirty(true); }} />;
    }`,
  ]) {
    assert.equal(narrowings(module), 1, module);
  }
});

test("a parameter call runs exactly what each caller hands over", () => {
  assert.equal(
    narrowings(`
    function logged(run: () => void) { run(); }
    export function reset() {
      profile$.name.set("");
      logged(() => profile$.email.set(""));
    }`),
    0,
    "the handed literal runs inside the stretch that also writes the leaf",
  );
  assert.equal(
    narrowings(`
    function logged(run: () => void) { run(); }
    export function clear() { logged(() => profile$.email.set("")); }`),
    1,
  );
  assert.equal(
    narrowings(`
    function deferred(run: () => void) { setTimeout(run, 0); }
    export function reset() {
      profile$.name.set("");
      deferred(() => profile$.email.set(""));
    }`),
    1,
    "a literal the callee only schedules runs as its own stretch",
  );
  assert.equal(
    narrowings(`
    declare const allowed: string[];
    function isAllowed(value?: string | null) { return allowed.includes(value as never); }
    export function write(email: string) { if (isAllowed(email)) profile$.email.set(email); }`),
    1,
    "a parameter declared with a primitive type is data, never a function to call",
  );
  assert.equal(
    narrowings(`
    declare const handlers: unknown[];
    function register(value: unknown) { return handlers.includes(value); }
    export function write(email: () => void) { register(email); profile$.email.set(""); }`),
    0,
    "a parameter that may hold a function still reaches code out of view",
  );
});

test("an object-literal assign writes its keys and a spread writes unknown keys", () => {
  assert.equal(
    narrowings(`export function write(email: string) { profile$.assign({ email }); }`),
    1,
  );
  assert.equal(
    narrowings(`
    declare const patch: { email: string };
    export function write() { profile$.assign({ ...patch }); }`),
    0,
  );
});
