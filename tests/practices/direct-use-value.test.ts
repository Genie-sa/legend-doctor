import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("passes a proven observable directly to useValue", () => {
  const [finding] = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const theme$ = observable({ accent: "blue" });
    export function Theme() {
      const accent = useValue(() => theme$.accent.get());
      return <span>{accent}</span>;
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.equal(requireValue(finding).action, "pass-observable-to-use-value");
  assert.equal(requireValue(finding).confidence, "certain");
  assert.match(requireValue(finding).message ?? "", /useValue\(theme\$\.accent\)/u);
});

test("passes a dynamically keyed observable directly only for one stable primitive parameter", () => {
  const positive = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const ratings$ = observable<Record<string, number | null>>({});
    export function useRating(key: string) {
      return useValue(() => ratings$[key].get());
    }
  `,
    fileName: "fixture.ts",
  });
  assert.deepEqual(
    positive.map((finding) => finding.action),
    ["pass-observable-to-use-value"],
  );
  assert.match(requireValue(positive[0]).message ?? "", /useValue\(ratings\$\[key\]\)/u);

  for (const [parameter, setup, key] of [
    ["key: { toString(): string }", "", "key"],
    ["key: string", "key = 'other';", "key"],
    ["key: string", "[key] = ['other'];", "key"],
    ["key: string", "for (key of ['other']) break;", "key"],
    ["key: string", "", "nextKey()"],
    ["key?: string", "", "key"],
  ] as const) {
    const findings = analyzeLegendPractices({
      sourceText: `
      import { observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      const ratings$ = observable<Record<string, number | null>>({});
      declare function nextKey(): string;
      export function useRating(${parameter}) {
        ${setup}
        return useValue(() => ratings$[${key}].get());
      }
    `,
      fileName: "fixture.ts",
    });
    assert.deepEqual(findings, [], `${parameter}; ${setup}; ${key}`);
  }
});

test("passes an eagerly read observable directly to useValue", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import { useValue as read } from "@legendapp/state/react";
    const profile$ = observable({ name: "Ada", avatar: Promise.resolve("ada.png") });
    export function Profile() {
      const name = read(profile$.name.get());
      const avatar = read(profile$.avatar.get(), { suspense: true });
      return <span>{name}{avatar}</span>;
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["pass-observable-to-use-value", "pass-observable-to-use-value"],
  );
  assert.match(requireValue(findings[0]).message ?? "", /read\(profile\$\.name\)/u);
  assert.match(
    requireValue(findings[1]).message ?? "",
    /read\(profile\$\.avatar, \{ suspense: true \}\)/u,
  );
  assert.match(
    requireValue(findings[0]).evidence.join(" ") ?? "",
    /before useValue can subscribe/u,
  );
});

test("preserves useValue types and options when simplifying one direct get selector", () => {
  const [finding] = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import * as LegendReact from "@legendapp/state/react";
    const profile$ = observable({ avatar: Promise.resolve("ada.png") });
    export function Profile() {
      return LegendReact.useValue<Promise<string>>(
        () => profile$.avatar.get(),
        { suspense: true }
      );
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.equal(requireValue(finding).action, "pass-observable-to-use-value");
  assert.match(
    requireValue(finding).message ?? "",
    /LegendReact\.useValue<Promise<string>>\(profile\$\.avatar, \{ suspense: true \}\)/u,
  );
});

test("keeps eager useValue inputs that are not one proven static get", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const profile$ = observable({ name: "Ada", rows: ["one"] });
    const external = { get: () => "outside" };
    const key = "name" as const;
    useValue(profile$.name.peek());
    useValue(profile$.rows.get(true));
    useValue(profile$[key].get());
    useValue(external.get());
    useValue(profile$.name?.get());
    useValue(profile$.name.get<string>());
    useValue(profile$.get.get());
    useValue(profile$.name.get(), {}, "extra");
  `,
    fileName: "fixture.tsx",
  });
  assert.deepEqual(findings, []);
});

test("keeps eager reads passed to a shadowing useValue binding", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const profile$ = observable({ name: "Ada" });
    export function Profile(useValue: (value: string) => string) {
      return useValue(profile$.name.get());
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.deepEqual(findings, []);
});

test("uses cross-file observable provenance for direct useValue", () => {
  assert.deepEqual(
    analyzeLegendPractices({
      sourceText: `
      import { useValue } from "@legendapp/state/react";
      import { settings$ } from "./store";
      export function Theme() {
        return <span>{useValue(() => settings$.theme.get())}</span>;
      }
    `,
      fileName: "fixture.tsx",
      importedObservables: new Set(["settings$"]),
    }).map((finding) => finding.action),
    ["pass-observable-to-use-value"],
  );
});
