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
  assert.equal(requireValue(finding).disposition, "style");
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
  assert.equal(requireValue(positive[0]).disposition, "style");
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
      const avatar = read(profile$.avatar.get());
      return <span>{name}{avatar}</span>;
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["pass-observable-to-use-value", "pass-observable-to-use-value"],
  );
  assert.deepEqual(
    findings.map(({ disposition }) => disposition),
    ["change", "change"],
  );
  assert.match(requireValue(findings[0]).message ?? "", /read\(profile\$\.name\)/u);
  assert.match(requireValue(findings[1]).message ?? "", /read\(profile\$\.avatar\)/u);
  assert.match(
    requireValue(findings[0]).evidence.join(" ") ?? "",
    /before useValue receives its input/u,
  );
  assert.match(requireValue(findings[0]).evidence.join(" "), /outside observer/u);
  assert.doesNotMatch(requireValue(findings[0]).message, /missing.*subscription/u);
});

test("preserves useValue types when simplifying one direct get selector without options", () => {
  const [finding] = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import * as LegendReact from "@legendapp/state/react";
    const profile$ = observable({ avatar: Promise.resolve("ada.png") });
    export function Profile() {
      return LegendReact.useValue<Promise<string>>(
        () => profile$.avatar.get()
      );
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.equal(requireValue(finding).action, "pass-observable-to-use-value");
  assert.match(
    requireValue(finding).message ?? "",
    /LegendReact\.useValue<Promise<string>>\(profile\$\.avatar\)/u,
  );
});

test("keeps async selectors and options whose read forwarding is not equivalent", () => {
  for (const input of [
    "profile$.name.get(), { shallow: true }",
    "profile$.name.get(), options",
    "profile$.name.get(), { suspense: true }",
    "async () => profile$.name.get()",
    "() => profile$.name.get(), { shallow: true }",
    "() => profile$.name.get(), options",
    "() => profile$.name.get(), { suspense: true }",
  ]) {
    const findings = analyzeLegendPractices({
      sourceText: `
        import { observable } from "@legendapp/state";
        import { useValue } from "@legendapp/state/react";
        const profile$ = observable({ name: "Ada" });
        export function Profile() { return useValue(${input}); }
      `,
      fileName: "fixture.tsx",
    });
    assert.equal(
      findings.some((finding) => finding.action === "pass-observable-to-use-value"),
      false,
      input,
    );
  }
});

test("does not promise identical subscription ownership inside observer", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
      import { observable } from "@legendapp/state";
      import { observer, useValue } from "@legendapp/state/react";
      const state$ = observable({ value: 1 });
      export const View = observer(() => <span>{useValue(() => state$.value.get())}</span>);
    `,
    fileName: "fixture.tsx",
  });
  const finding = requireValue(
    findings.find((candidate) => candidate.action === "pass-observable-to-use-value"),
  );
  assert.equal(finding.disposition, "style");
  assert.match(finding.evidence.join(" "), /observer.*subscription ownership/u);
  assert.doesNotMatch(finding.message, /same subscription/u);
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
