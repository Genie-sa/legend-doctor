import type { LegendPracticeFinding } from "../../src/core/types.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("keeps computed, shallow, dynamic, and unproven useValue selectors", () => {
  const source = (selector: string): LegendPracticeFinding[] =>
    analyzeLegendPractices({
      sourceText: `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const state$ = observable({ selected: 1, rows: [{ name: "one" }] });
    const external = { get: () => 1 };
    export function Row({ index }: { index: number }) {
      const value = useValue(${selector});
      return <span>{String(value)}</span>;
    }
  `,
      fileName: "fixture.tsx",
    });
  for (const selector of [
    `() => state$.selected.get() === 1`,
    `() => state$.rows.get(true)`,
    `() => state$.rows[index].get()`,
    `() => external.get()`,
  ]) {
    assert.deepEqual(source(selector), [], selector);
  }
});

test("narrows a broad useValue binding to its only static child", () => {
  const [finding] = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const profile$ = observable({ name: "Ada", email: "ada@example.com" });
    export function Profile() {
      const profile = useValue(profile$);
      return <><h1>{profile.name}</h1><span>{profile.name.trim()}</span></>;
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.equal(requireValue(finding).action, "narrow-use-value-subscription");
  assert.equal(requireValue(finding).confidence, "certain");
  assert.match(requireValue(finding).message ?? "", /useValue\(profile\$\.name\)/u);
  assert.match(requireValue(finding).evidence.join(" ") ?? "", /2 raw-value reads/u);
});

test("narrows useValue to the deepest shared static observable path", () => {
  const [finding] = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const profile$ = observable({ contact: { name: "Ada", email: "ada@example.com" } });
    export function Profile() {
      const profile = useValue(profile$);
      return <><h1>{profile.contact.name}</h1><span>{profile.contact.name.trim()}</span></>;
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.equal(requireValue(finding).action, "narrow-use-value-subscription");
  assert.match(requireValue(finding).message ?? "", /useValue\(profile\$\.contact\.name\)/u);
  assert.match(requireValue(finding).message ?? "", /profile\.contact\.name/u);
});

test("uses the deepest common path when sibling leaves are read", () => {
  const [finding] = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const profile$ = observable({ contact: { name: "Ada", email: "ada@example.com" } });
    export function Profile() {
      const profile = useValue(profile$);
      return <span>{profile.contact.name} {profile.contact.email}</span>;
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.equal(requireValue(finding).action, "narrow-use-value-subscription");
  assert.match(requireValue(finding).message ?? "", /useValue\(profile\$\.contact\)/u);
});

test("keeps a broad subscription when every known observable field is consumed", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const single$ = observable({ value: "one" });
    const pair$ = observable({ first: "one", second: "two" });
    export function Screen() {
      const single = useValue(single$);
      const pair = useValue(pair$);
      return <span>{single.value}{pair.first}{pair.second}</span>;
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.deepEqual(
    findings.filter(
      (finding) =>
        finding.action === "narrow-use-value-subscription" ||
        finding.action === "split-use-value-leaves",
    ),
    [],
  );
});

test("keeps the single-path narrowing when one shared path exists", () => {
  const [finding] = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const profile$ = observable({ contact: { name: "Ada" }, other: 1 });
    export function Profile() {
      const profile = useValue(profile$);
      return <span>{profile.contact.name} {profile.contact.name.trim()}</span>;
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.equal(requireValue(finding).action, "narrow-use-value-subscription");
});

test("stops narrowing at a TypeScript assertion boundary", () => {
  const [finding] = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const profile$ = observable({
      contact: { name: "Ada" } as { name: string } | null,
      status: "active",
    });
    export function Profile() {
      const profile = useValue(profile$);
      return <span>{(profile.contact!).name}</span>;
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.match(requireValue(finding).message ?? "", /useValue\(profile\$\.contact\)/u);
});

test("narrows a child used by a boolean projection", () => {
  const [finding] = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const profile$ = observable({ enabled: false, name: "Ada" });
    export function Profile() {
      const profile = useValue(profile$);
      return <span>{!profile.enabled ? "off" : "on"}</span>;
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.equal(requireValue(finding).action, "narrow-use-value-subscription");
  assert.match(requireValue(finding).message ?? "", /useValue\(profile\$\.enabled\)/u);
});

test("narrows a single-property useValue destructure", () => {
  const [finding] = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const theme$ = observable({ colors: { dark: { text: "black" }, light: { text: "white" } } });
    export function Theme() {
      const { dark: palette } = useValue(theme$.colors);
      return <span>{palette.text}</span>;
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.equal(requireValue(finding).action, "narrow-use-value-subscription");
  assert.match(requireValue(finding).message ?? "", /useValue\(theme\$\.colors\.dark\)/u);
  assert.match(requireValue(finding).message ?? "", /const palette =/u);
  assert.doesNotMatch(requireValue(finding).message ?? "", /palette\.dark/u);
});

test("narrows optional raw-value reads only when they share one static child path", () => {
  const [finding] = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const dialog$ = observable<{ state: boolean; data?: { id: string } } | undefined>(undefined);
    export function Dialog() {
      const dialog = useValue(dialog$);
      return <span>{dialog?.data?.id}{dialog?.data?.id}</span>;
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.equal(requireValue(finding).action, "narrow-use-value-subscription");
  assert.match(requireValue(finding).message ?? "", /useValue\(dialog\$\.data\.id\)/u);

  for (const body of [
    `return <span>{dialog?.state}{dialog?.data?.id}</span>;`,
    `return <span>{dialog?.data?.[key]}</span>;`,
    `return <span>{dialog?.data?.id.trim()}</span>;`,
    `return <Child value={dialog} />;`,
  ]) {
    const findings = analyzeLegendPractices({
      sourceText: `
      import { observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      const dialog$ = observable<{ state: boolean; data?: Record<string, string> } | undefined>(undefined);
      function Child({ value }: { value: unknown }) { return <>{String(value)}</>; }
      export function Dialog({ key }: { key: string }) {
        const dialog = useValue(dialog$);
        ${body}
      }
    `,
      fileName: "fixture.tsx",
    });
    assert.deepEqual(findings, [], body);
  }
});

test("keeps broad useValue reads when the child subscription is not proven equivalent", () => {
  const source = (body: string): LegendPracticeFinding[] =>
    analyzeLegendPractices({
      sourceText: `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const profile$ = observable({ name: "Ada", email: "ada@example.com", rows: [] as string[] });
    export function Profile({ keyName }: { keyName: "name" }) {
      const profile = useValue(profile$);
      ${body}
    }
  `,
      fileName: "fixture.tsx",
    });
  for (const body of [
    `return <span>{profile[keyName]}</span>;`,
    `return <Child profile={profile} />;`,
    `profile.name = "Grace"; return <span>{profile.name}</span>;`,
    `profile.contact.name = "Grace"; return <span>{profile.contact.name}</span>;`,
    `delete profile.contact.name; return <span>{String(profile.contact)}</span>;`,
    `return <span>{profile.name()}</span>;`,
    `return <span>{profile.contact[keyName]}</span>;`,
    `function nested(profile: { name: string }) { return profile.name; } return <span>{profile.name}</span>;`,
  ]) {
    assert.deepEqual(source(body), [], body);
  }
});

test("keeps array length as a selector concern rather than an observable child", () => {
  assert.deepEqual(
    analyzeLegendPractices({
      sourceText: `
      import { observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      const rows$ = observable(["one"]);
      export function Count() {
        const rows = useValue(rows$);
        return <span>{rows.length}</span>;
      }
    `,
      fileName: "fixture.tsx",
    }),
    [],
  );
});

test("keeps multi-property, defaulted, and rest useValue destructures", () => {
  const source = (binding: string): LegendPracticeFinding[] =>
    analyzeLegendPractices({
      sourceText: `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const profile$ = observable({ name: "Ada", email: "ada@example.com" });
    export function Profile() {
      const ${binding} = useValue(profile$);
      return null;
    }
  `,
      fileName: "fixture.tsx",
    });
  for (const binding of [`{ name, email }`, `{ name = "Unknown" }`, `{ name, ...rest }`]) {
    assert.deepEqual(source(binding), [], binding);
  }
});
