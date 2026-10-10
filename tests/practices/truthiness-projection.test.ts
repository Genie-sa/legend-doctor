import { assertVerifiedEdits, practiceFindings } from "./edit-assertions.js";
import type { LegendPracticeFinding } from "../../src/core/types.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

const fixture = (body: string, source = "observable<Track | null>(null)"): string => `
import { observable } from "@legendapp/state";
import { observer, useValue } from "@legendapp/state/react";
import { useEffect, useRef } from "react";
interface Track { id: string }
declare function Badge(props: { value: unknown }): JSX.Element;
declare function useThing(value: unknown): string;
declare function go(): void;
const dragged$ = ${source};
function Zone({ id }: { id: string }) {
  ${body}
}
export function App() { return <Zone id="a" />; }
`;
const findings = (source: string): LegendPracticeFinding[] =>
  practiceFindings(source, "select-primitive-projection");
const body =
  'const dragged = useValue(dragged$); return <div className={dragged ? "on" : "off"} />;';

test("selects the truthiness of a value the owner only tests", () => {
  const [finding, ...rest] = findings(fixture(body));
  assert.equal(rest.length, 0);
  assert.equal(requireValue(finding).disposition, "change");
  assert.equal(requireValue(finding).confidence, "certain");
  assert.match(
    requireValue(finding).message,
    /^Replace `const dragged = useValue\(dragged\$\)` with `const hasDragged = useValue\(\(\) => !!dragged\$\.get\(\)\)` and replace `dragged` with `hasDragged`\. Zone then renders only when dragged\$ turns truthy or falsy/u,
  );
});

for (const [name, source] of [
  ["a negation", fixture(body.replace("dragged ?", "!dragged ?"))],
  [
    "an early return",
    fixture(
      "const dragged = useValue(dragged$); if (!dragged) return null; return <div id={id} />;",
    ),
  ],
  [
    "a Boolean() prop",
    fixture(body.replace('className={dragged ? "on" : "off"}', "hidden={Boolean(dragged)}")),
  ],
  [
    "a JSX guard over an object domain",
    fixture(
      body.replace(
        'className={dragged ? "on" : "off"} />',
        "><>{dragged && <Badge value={1} />}</></div>",
      ),
    ),
  ],
  [
    "chained JSX guards",
    fixture(
      body.replace(
        'className={dragged ? "on" : "off"} />',
        ">{dragged && id && <Badge value={1} />}</div>",
      ),
    ),
  ],
  ["a compound condition", fixture(body.replace("dragged ?", "dragged && id ?"))],
  ["a falsy fallback inside a test", fixture(body.replace("dragged ?", "!(dragged || id) ?"))],
  ["an unbounded string domain", fixture(body, 'observable<string>("")')],
  [
    "a numeric domain tested with !!",
    fixture(body.replace("dragged ?", "!!dragged ?"), "observable<number>(0)"),
  ],
  ["three string literals", fixture(body, 'observable<"a" | "b" | null>(null)')],
] as const) {
  test(`selects the truthiness across ${name}`, () => {
    const [finding, ...rest] = findings(source);
    assert.equal(rest.length, 0);
    assert.ok(
      requireValue(finding).message.includes("useValue(() => !!dragged$.get())"),
      finding?.message,
    );
  });
}

test("a test only an event handler runs yields to dropping the subscription", () => {
  const source = fixture(
    body.replace('className={dragged ? "on" : "off"}', "onClick={() => { if (dragged) go(); }}"),
  );
  assert.deepEqual(findings(source), []);
  assert.equal(practiceFindings(source, "peek-unrendered-use-value").length, 1);
});

test("a truthiness test joined with a comparison selects the joined condition", () => {
  const [finding, ...rest] = findings(
    fixture(body.replace("dragged ?", "dragged && dragged !== null ?")),
  );
  assert.equal(rest.length, 0);
  assert.ok(
    requireValue(finding).message.includes(
      "`const draggedCondition = useValue(() => { const dragged = dragged$.get(); return !!(dragged && dragged !== null); })`",
    ),
    finding?.message,
  );
});

test("merges a sole named coercion into the selector", () => {
  const [finding] = findings(
    fixture(
      "const dragged = useValue(dragged$); const isDragging = !!dragged; return <div data-on={isDragging} />;",
    ),
  );
  assert.match(
    requireValue(finding).message,
    /^Replace `const dragged = useValue\(dragged\$\)` with `const isDragging = useValue\(\(\) => !!dragged\$\.get\(\)\)` and delete `const isDragging = !!dragged`\./u,
  );
});

test("names the JSX guard evidence only when a falsy value reaches JSX", () => {
  const guarded = fixture(
    body.replace(
      'className={dragged ? "on" : "off"} />',
      ">{dragged && <Badge value={1} />}</div>",
    ),
  );
  assert.match(requireValue(findings(guarded)[0]).evidence.join(" "), /never `0`, `NaN`, or `""`/u);
  const [tested] = findings(fixture(body));
  assert.doesNotMatch(requireValue(tested).evidence.join(" "), /never `0`/u);
});

for (const [name, source] of Object.entries({
  renderedValue: fixture(body.replace('className={dragged ? "on" : "off"}', "title={dragged?.id}")),
  passedToChild: fixture(
    body.replace('className={dragged ? "on" : "off"} />', "><Badge value={dragged} /></div>"),
  ),
  passedToHook: fixture(body.replace("return", "useThing(dragged); return")),
  shadowedBoolean: fixture(
    body
      .replace("return", "const Boolean = (value: unknown) => value; return")
      .replace('className={dragged ? "on" : "off"}', "title={Boolean(dragged)}"),
  ),
  concatenated: fixture(body.replace('"on"', '"track " + dragged'), 'observable<string>("")'),
  lengthRead: fixture(body.replace('"on"', "String(dragged.length)"), 'observable<string>("a")'),
  numericJsxGuard: fixture(
    body.replace(
      'className={dragged ? "on" : "off"} />',
      ">{dragged && <Badge value={1} />}</div>",
    ),
    "observable<number>(0)",
  ),
  stringJsxGuard: fixture(
    body.replace(
      'className={dragged ? "on" : "off"} />',
      ">{dragged && <Badge value={1} />}</div>",
    ),
    'observable<string>("")',
  ),
  jsxFallback: fixture(
    body.replace(
      'className={dragged ? "on" : "off"} />',
      ">{dragged || <Badge value={1} />}</div>",
    ),
    'observable<string>("")',
  ),
  guardedValue: fixture(
    body.replace('className={dragged ? "on" : "off"} />', ">{id && dragged}</div>"),
    'observable<string>("")',
  ),
  ternaryBranch: fixture(body.replace('"on"', "dragged"), 'observable<string>("")'),
  attributeGuard: fixture(
    body.replace('dragged ? "on" : "off"', 'dragged && "on"'),
    'observable<string>("")',
  ),
  effectDependency: fixture(
    body.replace("return", "useEffect(() => { if (dragged) go(); }, [dragged]); return"),
  ),
  everyRenderEffect: fixture(body.replace("return", "useEffect(() => { go(); }); return")),
  refRead: fixture(
    body.replace("return <div", "const ref = useRef(0); return <div title={String(ref.current)}"),
  ),
  booleanDomain: fixture(body, "observable<boolean>(false)"),
  oneTruthyValue: fixture(body, 'observable<"a" | null | undefined>(null)'),
  observerWrapped: `${fixture(body)}export const Tracked = observer(Zone);`,
  customHook: fixture(
    body
      .replace("return", "const theme = useThing(id); return")
      .replace("<div", "<div title={theme}"),
  ),
  takenName: fixture(
    body
      .replace("return", "const hasDragged = 1; return")
      .replace("<div", "<div data-n={hasDragged}"),
  ),
  unreadMergedName: fixture(
    "const dragged = useValue(dragged$); const isDragging = !!dragged; return <div />;",
  ),
})) {
  test(`truthiness projection abstains on ${name}`, () => assert.deepEqual(findings(source), []));
}

test("fresh-name edits replace every truthiness read", () => {
  const source = `import { observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";

interface Track {
  id: string;
}

const dragged$ = observable<Track | null>(null);

export function Zone({ id }: { id: string }) {
  const dragged = useValue(dragged$);
  if (!dragged) {
    return null;
  }
  return <div data-on={Boolean(dragged)}>{dragged && id}</div>;
}
`;
  assertVerifiedEdits(
    source,
    `import { observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";

interface Track {
  id: string;
}

const dragged$ = observable<Track | null>(null);

export function Zone({ id }: { id: string }) {
  const hasDragged = useValue(() => !!dragged$.get());
  if (!hasDragged) {
    return null;
  }
  return <div data-on={hasDragged}>{hasDragged && id}</div>;
}
`,
    findings(source),
  );
});

test("merged edits replace the raw subscription and delete the coercion", () => {
  const source = `import { observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";

const name$ = observable<string>("");

export function Title() {
  const name = useValue(name$);
  const named = !!name;
  return <h1 data-named={named} />;
}
`;
  assertVerifiedEdits(
    source,
    `import { observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";

const name$ = observable<string>("");

export function Title() {
  const named = useValue(() => !!name$.get());
  return <h1 data-named={named} />;
}
`,
    findings(source),
  );
});

test("edits compose with the legacy hook rename", () => {
  const source = `import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";

const name$ = observable<string>("");

export function Title() {
  const name = use$(name$);
  return <h1 hidden={!name} />;
}
`;
  assertVerifiedEdits(
    source,
    `import { observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";

const name$ = observable<string>("");

export function Title() {
  const hasName = useValue(() => !!name$.get());
  return <h1 hidden={!hasName} />;
}
`,
    [...findings(source), ...practiceFindings(source, "replace-legacy-use-value")],
  );
});
