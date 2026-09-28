import type { LegendPracticeFinding } from "../../src/core/types.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

function profileNarrowings(writer: string): LegendPracticeFinding[] {
  return analyzeLegendPractices({
    fileName: "fixture.tsx",
    sourceText: `
    import { batch, observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    declare function save(): Promise<void>;
    declare function onBlur(listener: () => void): void;
    const profile$ = observable({ name: "Ada", email: "ada@example.com" });
    export async function write(key: "name" | "email") {
      ${writer}
    }
    export function Profile() {
      const profile = useValue(profile$);
      return <h1>{profile.name}</h1>;
    }
  `,
  }).filter((finding) => finding.action === "narrow-use-value-subscription");
}

test("narrows only when a sibling is written in a stretch that leaves the leaf alone", () => {
  for (const writer of [
    `profile$.email.set("");`,
    `profile$.assign({ email: "" });`,
    `profile$.name.set("");
      await save();
      profile$.email.set("");`,
    `profile$.name.set("");
      profile$.email.set("");
      onBlur(() => profile$.email.set(""));`,
  ]) {
    assert.equal(profileNarrowings(writer).length, 1, writer);
  }
  assert.match(
    requireValue(profileNarrowings(`profile$.email.set("");`)[0]).evidence.join(" "),
    /`profile\$\.email` is written at fixture\.tsx:8 without touching `profile\$\.name`/u,
  );
});

test("keeps the broad subscription when no write changes a sibling without the leaf", () => {
  for (const [label, writer] of [
    ["no production write", ``],
    ["only the leaf is written", `profile$.name.set("");`],
    ["whole-value replacement", `profile$.set({ name: "", email: "" });`],
    ["sibling assigned with the leaf", `profile$.assign({ name: "", email: "" });`],
    ["sibling written through a runtime key", `profile$[key].set("");`],
    [
      "sibling written on a later line of the same synchronous stretch",
      `profile$.name.set("");
      profile$.email.set("");`,
    ],
    [
      "sibling written inside a batch beside the leaf",
      `batch(() => profile$.email.set(""));
      profile$.name.set("");`,
    ],
  ] as const) {
    assert.deepEqual(profileNarrowings(writer), [], label);
  }
});

test("keeps the broad subscription for an observable whose writers are out of view", () => {
  const findings = analyzeLegendPractices({
    fileName: "fixture.tsx",
    sourceText: `
    import type { Observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    export function Profile({ profile$ }: { profile$: Observable<{ name: string; email: string }> }) {
      const profile = useValue(profile$);
      return <h1>{profile.name}</h1>;
    }
  `,
  });
  assert.deepEqual(findings, []);
});

test("proves a sibling write only when it can land after the owner mounts", () => {
  const narrowings = (writes: string): LegendPracticeFinding[] =>
    analyzeLegendPractices({
      fileName: "fixture.tsx",
      sourceText: `
      import { observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      const settings$ = observable({ email: "" });
      const profile$ = observable({ name: "Ada", email: "" });
      ${writes}
      export function Profile() {
        const profile = useValue(profile$);
        return <h1>{profile.name}</h1>;
      }
    `,
    }).filter((finding) => finding.action === "narrow-use-value-subscription");
  assert.deepEqual(narrowings(`profile$.email.set(settings$.email.peek());`), []);
  assert.equal(
    narrowings(`settings$.email.onChange(({ value }) => profile$.email.set(value));`).length,
    1,
  );
});
