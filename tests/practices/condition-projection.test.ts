import { assertVerifiedEdits, practiceFindings } from "./edit-assertions.js";
import type { LegendPracticeFinding } from "../../src/core/types.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

const fixture = (body: string): string => `
import { observable } from "@legendapp/state";
import { observer, useValue } from "@legendapp/state/react";
import { useEffect, useRef } from "react";
interface Task { id: string; done: boolean }
interface User { role: string; name: string }
interface Bag { includes(id: string): boolean }
type Status = "idle" | "loading" | "saving" | "error";
declare function Badge(props: { value: unknown }): JSX.Element;
declare function useThing(value: unknown): string;
declare function track(value: unknown): boolean;
declare function go(): void;
const items$ = observable<Task[]>([]);
const status$ = observable<Status>("idle");
const user$ = observable<User | null>(null);
const count$ = observable(0);
const selected$ = observable<string[]>([]);
const pick$ = observable<string | null>(null);
const bag$ = observable<Bag>({ includes: () => false });
const toggle$ = observable<"on" | "off">("on");
const mode$ = observable<"off" | "one" | "all">("off");
function Row({ id, limit }: { id: string; limit: number }) {
  ${body}
}
export function App() { return <Row id="a" limit={3} />; }
`;

const findings = (source: string): LegendPracticeFinding[] =>
  practiceFindings(source, "select-primitive-projection");

const soleMessage = (source: string): string => {
  const [finding, ...rest] = findings(source);
  assert.equal(rest.length, 0);
  assert.equal(requireValue(finding).disposition, "change");
  return requireValue(finding).message;
};

for (const [name, body, selector] of [
  [
    "a length test merged into its const",
    "const items = useValue(items$); const hasTasks = items.length > 0; return <div data-on={hasTasks} />;",
    "const hasTasks = useValue(() => items$.get().length > 0)",
  ],
  [
    "status checks joined with ||",
    'const status = useValue(status$); const isBusy = status === "loading" || status === "saving"; return <div data-busy={isBusy} />;',
    'const isBusy = useValue(() => { const status = status$.get(); return status === "loading" || status === "saving"; })',
  ],
  [
    "an optional member comparison",
    'const user = useValue(user$); return <div hidden={user?.role !== "admin"} />;',
    'const userRoleDiffers = useValue(() => user$.get()?.role !== "admin")',
  ],
  [
    "an includes call with a prop argument",
    "const selected = useValue(selected$); return <div data-on={selected.includes(id)} />;",
    "const selectedIncludes = useValue(() => selected$.get().includes(id))",
  ],
  [
    "a some call with a pure callback",
    "const items = useValue(items$); if (!items.some((item) => item.done)) return null; return <div />;",
    "const itemsSome = useValue(() => items$.get().some((item) => item.done))",
  ],
  [
    "a relational comparison against a changing prop",
    "const count = useValue(count$); return <div hidden={count > limit} />;",
    "const countExceeds = useValue(() => count$.get() > limit)",
  ],
  [
    "a nullish and identity check",
    "const pick = useValue(pick$); const isOff = pick !== null && pick !== id; return <div data-off={isOff} />;",
    "const isOff = useValue(() => { const pick = pick$.get(); return pick !== null && pick !== id; })",
  ],
  [
    "a member test guarded by the value's truthiness",
    'const user = useValue(user$); return <div>{user && user.role === "admin" ? "admin" : "guest"}</div>;',
    'const userCondition = useValue(() => { const user = user$.get(); return !!(user && user.role === "admin"); })',
  ],
  [
    "a length truthiness test",
    "const items = useValue(items$); return <div hidden={!items.length} />;",
    "const hasItems = useValue(() => !!items$.get().length)",
  ],
  [
    "a condition an event handler reads",
    "const items = useValue(items$); return <button hidden={items.length > 0} onClick={() => { if (items.length > 0) go(); }} />;",
    "const hasItems = useValue(() => items$.get().length > 0)",
  ],
] as const) {
  test(`selects the boolean of ${name}`, () => {
    const message = soleMessage(fixture(body));
    assert.ok(message.includes(`\`${selector}\``), message);
  });
}

test("selects one boolean per distinct condition over the same value", () => {
  const message = soleMessage(
    fixture(
      "const items = useValue(items$); return <div data-any={items.length > 0} data-done={items.some((item) => item.done)} />;",
    ),
  );
  assert.ok(
    message.includes("`const hasItems = useValue(() => items$.get().length > 0)`"),
    message,
  );
  assert.ok(
    message.includes("`const itemsSome = useValue(() => items$.get().some((item) => item.done))`"),
    message,
  );
});

test("literal checks that leave two statuses together select two booleans", () => {
  const message = soleMessage(
    fixture(
      'const status = useValue(status$); return <div data-idle={status === "idle"} data-loading={status === "loading"} />;',
    ),
  );
  assert.ok(
    message.includes('`const isStatusIdle = useValue(() => status$.get() === "idle")`'),
    message,
  );
  assert.ok(
    message.includes('`const isStatusLoading = useValue(() => status$.get() === "loading")`'),
    message,
  );
});

test("one selector replaces repeated copies of the same condition", () => {
  const message = soleMessage(
    fixture(
      'const count = useValue(count$); return <div hidden={count > limit} title={count > limit ? "many" : "few"} />;',
    ),
  );
  assert.match(message, /replace the 2 `count > limit` conditions with `countExceeds`/u);
});

test("names the boolean domain evidence", () => {
  const [finding] = findings(
    fixture(
      'const status = useValue(status$); const isBusy = status === "loading" || status === "saving"; return <div data-busy={isBusy} />;',
    ),
  );
  assert.match(requireValue(finding).evidence.join(" "), /every read of `status` sits inside/u);
});

for (const [name, body] of Object.entries({
  renderedValue:
    "const items = useValue(items$); return <div>{items.length > 0 && <Badge value={items} />}</div>;",
  passedToChild: "const items = useValue(items$); return <Badge value={items} />;",
  passedToHook:
    "const items = useValue(items$); const label = useThing(items); return <div title={label} hidden={items.length > 0} />;",
  renderedLength: "const items = useValue(items$); return <div>{items.length}</div>;",
  numericLengthGuard:
    "const items = useValue(items$); return <div>{items.length && <Badge value={1} />}</div>;",
  impureCallback:
    "const items = useValue(items$); return <div hidden={items.some((item) => track(item))} />;",
  impureCall: "const items = useValue(items$); return <div hidden={track(items.length)} />;",
  userMethod: "const bag = useValue(bag$); return <div hidden={bag.includes(id)} />;",
  callbackOperand:
    "const selected = useValue(selected$); return <ul>{[id].map((key) => <li key={key} hidden={selected.includes(key)} />)}</ul>;",
  laterOperand:
    "const count = useValue(count$); const max = limit * 2; return <div hidden={count > max} />;",
  nullableMember: 'const user = useValue(user$); return <div hidden={user!.role === "admin"} />;',
  fullPartition:
    'const mode = useValue(mode$); return <div data-off={mode === "off"} data-one={mode === "one"} hidden={mode !== "all"} />;',
  twoValueDomain: 'const toggle = useValue(toggle$); return <div hidden={toggle >= "on"} />;',
  effectDependency:
    "const items = useValue(items$); useEffect(() => { if (items.length > 0) go(); }, [items]); return <div />;",
  observerRead:
    "const items = useValue(items$); const total = count$.get(); return <div data-n={total} hidden={items.length > 0} />;",
  customHook:
    "const items = useValue(items$); const theme = useThing(id); return <div title={theme} hidden={items.length > 0} />;",
  refRead:
    "const items = useValue(items$); const ref = useRef(0); return <div title={String(ref.current)} hidden={items.length > 0} />;",
  takenName:
    "const items = useValue(items$); const hasItems = 1; return <div data-n={hasItems} hidden={!items.length} />;",
})) {
  test(`condition projection abstains on ${name}`, () =>
    assert.deepEqual(findings(fixture(body)), []));
}

test("leaves a uniform comparison to the plain projection", () => {
  const source = fixture(
    "const pick = useValue(pick$); const selected = pick === id; return <div data-on={selected} />;",
  );
  const [finding, ...rest] = findings(source);
  assert.equal(rest.length, 0);
  assert.match(requireValue(finding).message, /delete `const selected = pick === id`/u);
});

test("observer-wrapped owners keep their subscription", () => {
  const source = `${fixture("const items = useValue(items$); return <div hidden={items.length > 0} />;")}export const Tracked = observer(Row);`;
  assert.deepEqual(findings(source), []);
});

test("merged edits replace the subscription with a block selector", () => {
  const source = `import { observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";

type Status = "idle" | "loading" | "saving" | "error";

const status$ = observable<Status>("idle");

export function Spinner() {
  const status = useValue(status$);
  const isBusy = status === "loading" || status === "saving";
  return <div data-busy={isBusy} />;
}
`;
  assertVerifiedEdits(
    source,
    `import { observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";

type Status = "idle" | "loading" | "saving" | "error";

const status$ = observable<Status>("idle");

export function Spinner() {
  const isBusy = useValue(() => { const status = status$.get(); return status === "loading" || status === "saving"; });
  return <div data-busy={isBusy} />;
}
`,
    findings(source),
  );
});

test("edits add one selector per condition and replace every site", () => {
  const source = `import { observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";

interface Task {
  id: string;
  done: boolean;
}

const items$ = observable<Task[]>([]);

export function Summary({ id }: { id: string }) {
  const items = useValue(items$);
  if (items.length === 0) {
    return null;
  }
  return <div data-mine={items.some((item) => item.id === id)} hidden={items.length === 0} />;
}
`;
  assertVerifiedEdits(
    source,
    `import { observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";

interface Task {
  id: string;
  done: boolean;
}

const items$ = observable<Task[]>([]);

export function Summary({ id }: { id: string }) {
  const isItemsEmpty = useValue(() => items$.get().length === 0);
  const itemsSome = useValue(() => items$.get().some((item) => item.id === id));
  if (isItemsEmpty) {
    return null;
  }
  return <div data-mine={itemsSome} hidden={isItemsEmpty} />;
}
`,
    findings(source),
  );
});

test("edits compose with the legacy hook rename", () => {
  const source = `import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";

const count$ = observable(0);

export function Counter({ limit }: { limit: number }) {
  const count = use$(count$);
  return <div hidden={count > limit} />;
}
`;
  assertVerifiedEdits(
    source,
    `import { observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";

const count$ = observable(0);

export function Counter({ limit }: { limit: number }) {
  const countExceeds = useValue(() => count$.get() > limit);
  return <div hidden={countExceeds} />;
}
`,
    [...findings(source), ...practiceFindings(source, "replace-legacy-use-value")],
  );
});
