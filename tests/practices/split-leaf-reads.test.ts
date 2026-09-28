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
    export function reportScan(progress: number) {
      localMusicState$.scanProgress.set(progress);
    }
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
  assert.match(
    requireValue(finding).evidence.join(" ") ?? "",
    /unread `scanProgress` is written without any field this owner reads/u,
  );
});

test("splits a legacy whole-object subscription with the hook the source calls", () => {
  const [finding] = analyzeLegendPractices({
    installedLegendState: {
      source: "lockfile",
      syncExport: "available",
      useValueExport: "missing",
      version: "3.0.0-beta.30",
    },
    sourceText: `
    import { observable } from "@legendapp/state";
    import { use$ } from "@legendapp/state/react";
    const player$ = observable({ currentIndex: -1, currentTime: 0, isPlaying: false });
    export function tick(time: number) {
      player$.currentTime.set(time);
    }
    export function Playlist({ tracks }: { tracks: string[] }) {
      const player = use$(player$);
      const rows = tracks.map((track, index) => index === player.currentIndex && player.isPlaying);
      return <ul>{rows.map((playing) => <li>{String(playing)}</li>)}</ul>;
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.equal(requireValue(finding).action, "split-use-value-leaves");
  assert.ok(
    requireValue(finding).message.startsWith(
      "Split `player` from `use$(player$)` into per-leaf subscriptions: " +
        "`const currentIndex = use$(player$.currentIndex)`, `const isPlaying = use$(player$.isPlaying)`",
    ),
    requireValue(finding).message,
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
    export function describe(detail: string) {
      spotify$.detail.set(detail);
      appleMusic$.assign({ detail });
    }
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
    export function addRow(row: string) {
      profile$.rows.push(row);
    }
    export function Profile({ keyName }: { keyName: "name" }) {
      const profile = useValue(profile$);
      return <span>{profile.name} {profile.email}</span>;
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.equal(requireValue(finding).action, "split-use-value-leaves");
});

function blocklistSplits(store: string, writer: string): string[] {
  return analyzeLegendPractices({
    fileName: "fixture.tsx",
    sourceText: `
      import { batch, observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      declare function loadBlocklist(): { channels: string[]; keywords: string[]; draft: string };
      declare function defaults(): { channels: string[]; keywords: string[] };
      declare function save(): Promise<void>;
      declare function onBlur(listener: () => void): void;
      const store$ = ${store};
      export async function write(field: "draft") {
        ${writer}
      }
      export function Blocklist() {
        const blocklist = useValue(store$);
        return <span>{blocklist.channels.length}{blocklist.keywords.length}</span>;
      }
    `,
  })
    .filter((finding) => finding.action === "split-use-value-leaves")
    .map((finding) => finding.message);
}

const EDITABLE_BLOCKLIST = `observable({ channels: [] as string[], keywords: [] as string[], draft: "" })`;

test("splits when an unread data field is written without any read field", () => {
  for (const writer of [
    `store$.draft.set("");`,
    `store$.assign({ draft: "" });`,
    `store$.keywords.set([]);
    await save();
    store$.draft.set("");`,
    `store$.keywords.set([]);
    store$.draft.set("");
    onBlur(() => store$.draft.set(""));`,
  ]) {
    assert.equal(blocklistSplits(EDITABLE_BLOCKLIST, writer).length, 1, writer);
  }
});

test("keeps the broad subscription when no unread field is written on its own", () => {
  for (const [label, store, writer] of [
    [
      "constant schema version and function members",
      `observable({
        schemaVersion: 1,
        channels: [] as string[],
        keywords: [] as string[],
        addChannel: (value: string) => { store$.channels.push(value); },
        addKeyword(value: string) { store$.keywords.push(value); },
      })`,
      ``,
    ],
    [
      "function-valued member replaced at runtime",
      `observable({ channels: [] as string[], keywords: [] as string[], onChange: () => {} })`,
      `store$.onChange.set(() => () => {});`,
    ],
    [
      "unread field assigned together with a read field",
      EDITABLE_BLOCKLIST,
      `store$.assign({ channels: [], draft: "" });`,
    ],
    [
      "unread field written on the same line as a read field",
      EDITABLE_BLOCKLIST,
      `store$.keywords.set([]); store$.draft.set("");`,
    ],
    [
      "unread field written on a later line of the same synchronous stretch",
      EDITABLE_BLOCKLIST,
      `store$.keywords.set([]);
      store$.draft.set("");`,
    ],
    [
      "unread field written inside a batch beside a read field",
      EDITABLE_BLOCKLIST,
      `store$.keywords.set([]);
      batch(() => store$.draft.set(""));`,
    ],
    [
      "unread field written by an array callback beside a read field",
      EDITABLE_BLOCKLIST,
      `["a"].forEach(() => store$.draft.set(""));
      store$.channels.set([]);`,
    ],
    [
      "unread field written after an await that loops back to a read-field write",
      EDITABLE_BLOCKLIST,
      `for (const channel of ["a"]) {
        store$.channels.push(channel);
        await save();
        store$.draft.set("");
      }`,
    ],
    ["unread field written through a runtime key", EDITABLE_BLOCKLIST, `store$[field].set("");`],
    [
      "unread field replaced only by a whole-value write",
      EDITABLE_BLOCKLIST,
      `store$.set({ channels: [], keywords: [], draft: "" });`,
    ],
    ["field set from a factory result", `observable(loadBlocklist())`, `store$.draft.set("");`],
    [
      "field set widened by spread defaults",
      `observable({ ...defaults(), draft: "" })`,
      `store$.draft.set("");`,
    ],
  ] as const) {
    assert.deepEqual(blocklistSplits(store, writer), [], label);
  }
});

test("ignores unread-field writes that run only while the module loads", () => {
  const splits = (writes: string): number =>
    analyzeLegendPractices({
      fileName: "fixture.tsx",
      sourceText: `
      import { observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      const saved$ = observable({ draft: "" });
      const store$ = ${EDITABLE_BLOCKLIST};
      ${writes}
      export function Blocklist() {
        const blocklist = useValue(store$);
        return <span>{blocklist.channels.length}{blocklist.keywords.length}</span>;
      }
    `,
    }).filter((finding) => finding.action === "split-use-value-leaves").length;
  assert.equal(splits(`store$.draft.set(saved$.draft.peek());`), 0);
  assert.equal(splits(`saved$.draft.onChange(({ value }) => store$.draft.set(value));`), 1);
});
