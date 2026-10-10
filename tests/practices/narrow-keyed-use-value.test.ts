import type { LegendPracticeFinding } from "../../src/core/types.js";
import assert from "node:assert/strict";
import { practiceFindings } from "./edit-assertions.js";
import { requireValue } from "./harness.js";
import test from "node:test";

const WRITER = "export function rename(id: string, name: string) { areas$[id].name.set(name); }";

const fixture = (body: string, writer = WRITER, prelude = ""): string => `
import { observable } from "@legendapp/state";
import { observer, use$, useValue } from "@legendapp/state/react";
import { useEffect, useRef } from "react";
declare function Child(props: { value: unknown }): JSX.Element;
declare function useThing(value: unknown): string;
declare function format(value: unknown): string;
interface Area { name: string; run(): void }
const areas$ = observable<Record<string, Area>>({});
const tabs$ = observable<Area[]>([]);
const state$ = observable({ areas: {} as Record<string, Area>, other: 0 });
${prelude}
${writer}
export function AreaLabel({ areaId, ids }: { areaId: string; ids: string[] }) {
  ${body}
}
`;
const findings = (source: string): LegendPracticeFinding[] =>
  practiceFindings(source, "narrow-use-value-subscription");
const body = "const allAreas = useValue(areas$); return <span>{allAreas[areaId]?.name}</span>;";

test("narrows a whole-map subscription to the one key the owner reads", () => {
  const [finding, ...rest] = findings(fixture(body));
  assert.equal(rest.length, 0);
  assert.equal(requireValue(finding).disposition, "change");
  assert.equal(requireValue(finding).confidence, "certain");
  assert.match(
    requireValue(finding).message,
    /^Narrow `allAreas` from `useValue\(areas\$\)` to `useValue\(areas\$\[areaId\]\)`; bind the entry directly and replace the `allAreas\[areaId\]` reads/u,
  );
  assert.match(
    requireValue(finding).evidence.join(" "),
    /`areas\$\[…\]\.name` is written at fixture\.tsx:\d+ without replacing `areas\$`/u,
  );
});

for (const [name, source, narrowed] of [
  [
    "a selector that returns the whole map",
    fixture(body.replace("useValue(areas$)", "useValue(() => areas$.get())")),
    "useValue(areas$[areaId])",
  ],
  [
    "a legacy hook alias",
    fixture(body.replace("useValue(areas$)", "use$(areas$)")),
    "use$(areas$[areaId])",
  ],
  [
    "repeated reads of the same key",
    fixture(
      body.replace(
        "<span>{allAreas[areaId]?.name}</span>",
        "<span title={allAreas[areaId]?.name} onClick={() => allAreas[areaId]?.run()}>{allAreas[areaId]?.name}</span>",
      ),
    ),
    "useValue(areas$[areaId])",
  ],
  [
    "a key held in an earlier const",
    fixture(
      body
        .replace("const allAreas", "const key = areaId.trim(); const allAreas")
        .replaceAll("[areaId]", "[key]"),
    ),
    "useValue(areas$[key])",
  ],
  [
    "a key held in a later const",
    fixture(
      "const allAreas = useValue(areas$); const other = useRef(0); const key = areaId.trim(); return <span onClick={() => other}>{allAreas[key]?.name}</span>;",
    ),
    "useValue(areas$[key])`, declared after `key`",
  ],
  [
    "an array index",
    fixture(
      "const tabs = useValue(tabs$); return <span>{tabs[0]?.name}</span>;",
      "export function rename(index: number, name: string) { tabs$[index].name.set(name); }",
    ),
    "useValue(tabs$[0])",
  ],
  [
    "an appended entry",
    fixture(body, "export function add(id: string) { areas$[id].set({ name: id, run() {} }); }"),
    "useValue(areas$[areaId])",
  ],
  [
    "a nested map whose writes leave its siblings alone",
    fixture(
      body.replace("useValue(areas$)", "useValue(state$.areas)"),
      "export function rename(id: string) { state$.areas[id]!.name.set(''); state$.other.set(1); }",
    ),
    "useValue(state$.areas[areaId])",
  ],
] as const) {
  test(`narrows the keyed read across ${name}`, () => {
    const [finding, ...rest] = findings(source);
    assert.equal(rest.length, 0);
    assert.ok(requireValue(finding).message.includes(narrowed), finding?.message);
  });
}

for (const [name, source] of Object.entries({
  secondKey: fixture(
    body.replace("{allAreas[areaId]?.name}", "{allAreas[areaId]?.name}{allAreas[ids[0]!]?.name}"),
  ),
  secondKeyIdentifier: fixture(
    body
      .replace("const allAreas", "const other = ids[0]!; const allAreas")
      .replace("{allAreas[areaId]?.name}", "{allAreas[areaId]?.name}{allAreas[other]?.name}"),
  ),
  iteration: fixture(
    body.replace(
      "{allAreas[areaId]?.name}",
      "{Object.keys(allAreas).length}{allAreas[areaId]?.name}",
    ),
  ),
  passedToChild: fixture(body.replace("<span>", "<span><Child value={allAreas} />")),
  passedToHook: fixture(
    body.replace(
      "const allAreas = useValue(areas$);",
      "const allAreas = useValue(areas$); useThing(allAreas);",
    ),
  ),
  passedToFunction: fixture(body.replace("{allAreas[areaId]?.name}", "{format(allAreas)}")),
  spread: fixture(body.replace("{allAreas[areaId]?.name}", "{format({ ...allAreas })}")),
  keyDerivedFromValue: fixture(
    body.replace("allAreas[areaId]", "allAreas[Object.keys(allAreas)[0]!]"),
  ),
  laterKeyAfterEarlyReturn: fixture(
    "const allAreas = useValue(areas$); if (!areaId) return null; const key = areaId.trim(); return <span>{allAreas[key]?.name}</span>;",
  ),
  laterKeyAfterThrow: fixture(
    "const allAreas = useValue(areas$); if (!areaId) { throw new Error(); } const key = areaId.trim(); return <span>{allAreas[key]?.name}</span>;",
  ),
  laterKeyAfterValueRead: fixture(
    "const allAreas = useValue(areas$); const label = () => allAreas[key]?.name; const key = areaId.trim(); return <span>{label()}</span>;",
  ),
  laterLetKey: fixture(
    "const allAreas = useValue(areas$); let key = areaId.trim(); return <span>{allAreas[key]?.name}</span>;",
  ),
  callbackKey: fixture(
    body.replace("{allAreas[areaId]?.name}", "{ids.map((id) => allAreas[id]?.name)}"),
  ),
  reassignedKey: fixture(
    "let key = areaId; key += '!'; const allAreas = useValue(areas$); return <span>{allAreas[key]?.name}</span>;",
  ),
  reservedLiteralKey: fixture(body.replace("[areaId]", '["get"]')),
  entryWrite: fixture(body.replace("return", "allAreas[areaId] = { name: '', run() {} }; return")),
  entryFieldWrite: fixture(body.replace("return", "allAreas[areaId]!.name = ''; return")),
  entryCall: fixture(
    "const handlers = useValue(handlers$); return <span onClick={() => handlers[areaId]?.()} />;",
    "export function bind(id: string) { handlers$[id].set(() => () => {}); }",
    "const handlers$ = observable<Record<string, () => void>>({});",
  ),
  wholeReplacementOnly: fixture(body, "export function reset() { areas$.set({}); }"),
  noWrite: fixture(body, ""),
  opaqueWrite: fixture(
    body,
    "declare const handlers: unknown[]; function register(value: unknown) { return handlers.includes(value); } export function rename(id: string, done: () => void) { register(done); areas$[id].name.set(''); }",
  ),
  entryWrittenWithWholeMap: fixture(
    body.replace("useValue(areas$)", "useValue(state$.areas)"),
    "export function rename(id: string) { state$.areas[id]!.name.set(''); state$.areas.set({}); }",
  ),
  runtimeKeyedAncestorWrite: fixture(
    "const allAreas = useValue(state$.areas); return <span>{allAreas[areaId]?.name}</span>;",
    "export function reset(id: string, key: 'areas' | 'other') { state$.areas[id]!.name.set(''); state$[key].set(0 as never); }",
  ),
  overlappingSubscription: fixture(
    body
      .replace(
        "const allAreas = useValue(areas$);",
        "const allAreas = useValue(areas$); const count = useValue(() => Object.keys(areas$.get()).length);",
      )
      .replace("</span>", "{count}</span>"),
  ),
  observerRead: `${fixture(
    body.replace("</span>", "{Object.keys(areas$.get()).length}</span>"),
  )}export const Tracked = observer(AreaLabel);`,
  effectDependency: fixture(
    body.replace("return", "useEffect(() => format(allAreas), [allAreas]); return"),
  ),
  everyRenderEffect: fixture(
    body.replace("return", "useEffect(() => { format(areaId); }); return"),
  ),
  refRead: fixture(
    body.replace(
      "return <span>",
      "const ref = useRef(0); return <span title={String(ref.current)}>",
    ),
  ),
  shadowedBinding: fixture(
    body.replace(
      "return",
      "{ const allAreas = {} as Record<string, Area>; format(allAreas); } return",
    ),
  ),
  letBinding: fixture(body.replace("const allAreas", "let allAreas")),
})) {
  test(`keyed narrowing abstains on ${name}`, () => assert.deepEqual(findings(source), []));
}
