import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("splits divergent leaf reads into per-leaf subscriptions", () => {
  const [finding] = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const localMusicState$ = observable({ tracks: [], isLocalFilesSelected: false, scanProgress: 0 });
    export function Playlist() {
      const state = useValue(localMusicState$);
      const hasTracks = state.tracks.length > 0;
      return <section>{hasTracks && String(state.isLocalFilesSelected)}{String(state.tracks)}</section>;
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.equal(requireValue(finding).action, "split-use-value-leaves");
  assert.equal(requireValue(finding).confidence, "certain");
  assert.equal(requireValue(finding).disposition, "change");
  assert.match(
    requireValue(finding).message ?? "",
    /const tracks = useValue\(localMusicState\$\.tracks\)/u,
  );
  assert.match(
    requireValue(finding).message ?? "",
    /const isLocalFilesSelected = useValue\(localMusicState\$\.isLocalFilesSelected\)/u,
  );
  assert.match(
    requireValue(finding).evidence.join(" ") ?? "",
    /3 raw-value reads resolve through 2 distinct static leaf paths/u,
  );
});

test("abstains from the split when the whole value escapes as a bare read", () => {
  for (const escape of [
    `track(state);`,
    `const snapshot = state;`,
    `<Row item={state} />`,
    `<Row {...state} />`,
    `[state].length;`,
  ]) {
    const findings = analyzeLegendPractices({
      sourceText: `
      import { observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      const state$ = observable({ title: "a", done: false });
      function Row(props: Record<string, unknown>) { return null; }
      function track(value: unknown) { return value; }
      export function Screen() {
        const state = useValue(state$);
        ${escape}
        return <span>{state.title}{String(state.done)}</span>;
      }
    `,
      fileName: "fixture.tsx",
    });
    assert.deepEqual(findings, [], escape);
  }
});

test("abstains from the split on writes, calls, dynamic access, and reserved members", () => {
  for (const hazard of [
    `state.title = "x";`,
    `state?.title;`,
    `state["title"];`,
    `state.validate();`,
    `String(state.size);`,
  ]) {
    const findings = analyzeLegendPractices({
      sourceText: `
      import { observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      const state$ = observable({ title: "a", done: false, validate: () => true, size: 1 });
      export function Screen() {
        const state = useValue(state$);
        ${hazard}
        return <span>{state.title}{String(state.done)}</span>;
      }
    `,
      fileName: "fixture.tsx",
    });
    assert.deepEqual(findings, [], hazard);
  }
});

test("abstains from the split when a proposed leaf name already binds in the owner", () => {
  const [finding] = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const state$ = observable({ tracks: [], ready: true, scanProgress: 0 });
    export function Screen() {
      const state = useValue(state$);
      const tracks = [1, 2, 3];
      return <span>{String(tracks.length)}{String(state.ready)}{String(state.tracks)}</span>;
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.equal(finding, undefined);
});

test("sibling splits in one owner never propose the same leaf names", () => {
  const messages = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const spotify$ = observable({ enabled: false, authenticated: false, detail: "" });
    const appleMusic$ = observable({ enabled: false, authenticated: false, detail: "" });
    export function Sources() {
      const spotify = useValue(spotify$);
      const appleMusic = useValue(appleMusic$);
      return <span>{String(spotify.enabled && spotify.authenticated)}{String(appleMusic.enabled && appleMusic.authenticated)}</span>;
    }
  `,
    fileName: "fixture.tsx",
  })
    .filter((finding) => finding.action === "split-use-value-leaves")
    .map((finding) => finding.message);
  assert.equal(messages.length, 2);
  const declared = messages.flatMap((message) =>
    [...message.matchAll(/const (?<name>\w+) = useValue/gu)].map((match) => match.groups?.["name"]),
  );
  assert.deepEqual(declared.toSorted(), [
    "appleMusicAuthenticated",
    "appleMusicEnabled",
    "spotifyAuthenticated",
    "spotifyEnabled",
  ]);
});

test("splits divergent static leaf reads instead of keeping the broad subscription", () => {
  const [finding] = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const profile$ = observable({ name: "Ada", email: "ada@example.com", rows: [] as string[] });
    export function Profile({ keyName }: { keyName: "name" }) {
      const profile = useValue(profile$);
      return <span>{profile.name} {profile.email}</span>;
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.equal(requireValue(finding).action, "split-use-value-leaves");
});
