import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { HookFinding } from "../../src/core/types.js";
import { analyzePath } from "../../src/project/analyze-path/analyze-path.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

interface ReactionVerdict {
  readonly action: HookFinding["action"];
  readonly peeks: readonly string[];
  readonly reason: HookFinding["abstentionReason"] | null;
}

function manager(body: string, extraHooks = ""): string {
  return `
    import { observable } from "@legendapp/state";
    import { useObservable, useValue } from "@legendapp/state/react";
    import { useEffect } from "react";
    const window$ = observable({ isOpen: false, size: { width: 1 } });
    const player$ = observable({ isPlaying: false, autoClose: true });
    export function Manager({ store }: { store: { get: () => boolean } }) {
      const isPlaying = useValue(player$.isPlaying);
      const autoClose = useValue(player$.autoClose);
      ${extraHooks}
      useEffect(() => {
        ${body}
      }, [autoClose, isPlaying]);
      return null;
    }
  `;
}

function reactionVerdict(finding: HookFinding): ReactionVerdict {
  const peeks = [...finding.message.matchAll(/`(?<read>[^`]+)` with `[^`]+\.peek\([^`]*\)`/gu)].map(
    (match) => match.groups!.read!,
  );
  return { action: finding.action, peeks, reason: finding.abstentionReason ?? null };
}

function sourceVerdict(source: string): ReactionVerdict {
  const effect = requireValue(
    analyzeSource(source, "fixture.tsx").find((finding) => finding.hook === "useEffect"),
  );
  return reactionVerdict(effect);
}

const converted = (...peeks: string[]): ReactionVerdict => ({
  action: "use-observe-effect",
  peeks,
  reason: null,
});

const untrackable: ReactionVerdict = {
  action: "review-effect",
  peeks: [],
  reason: "callback-timing-unresolved",
};

const cases: readonly (readonly [string, string, ReactionVerdict])[] = [
  [
    "peeks an incidental read in the body",
    "if (!isPlaying && autoClose && window$.isOpen.get()) window$.isOpen.set(false);",
    converted("window$.isOpen.get()"),
  ],
  [
    "peeks an incidental read before the first await of an immediately invoked async function",
    "if (isPlaying && autoClose) { (async () => { const { size } = window$.get(); await open(size); })(); }",
    converted("window$.get()"),
  ],
  [
    "peeks a read that a conditional await does not put behind a suspension",
    "report(isPlaying, autoClose); void (async () => { if (paused()) { await pause(); } report(window$.isOpen.get()); })();",
    converted("window$.isOpen.get()"),
  ],
  [
    "leaves a read after an unconditional await untracked",
    "report(isPlaying, autoClose); void (async () => { await pause(); report(window$.isOpen.get()); })();",
    converted(),
  ],
  [
    "leaves a read inside a deferred callback untracked",
    "if (isPlaying && autoClose) setTimeout(() => report(window$.isOpen.get()), 10);",
    converted(),
  ],
  [
    "leaves reads of the trigger leaves and their descendants alone",
    "report(isPlaying, autoClose, player$.isPlaying.get(), player$.autoClose.get());",
    converted(),
  ],
  [
    "peeks a read of an ancestor of a trigger leaf",
    "report(isPlaying, autoClose, player$.get());",
    converted("player$.get()"),
  ],
  [
    "leaves a keyed lookup on a plain map alone",
    "report(isPlaying, autoClose, cache.get('key'));",
    converted(),
  ],
  [
    "blocks a read inside a callback of unknown timing",
    "if (isPlaying && autoClose) register(() => report(window$.isOpen.get()));",
    untrackable,
  ],
  [
    "blocks an argument-free get on a receiver not proven observable",
    "if (isPlaying && autoClose && store.get()) close();",
    untrackable,
  ],
];

for (const [name, body, expected] of cases) {
  test(`observable reaction reads: ${name}`, () => {
    assert.deepEqual(sourceVerdict(manager(body)), expected);
  });
}

test("observable reaction reads: peeks a stable useObservable handle listed as a dependency", () => {
  const source = manager(
    "if (!isPlaying && autoClose && draft$.get()) draft$.set(false);",
    "const draft$ = useObservable(false);",
  ).replace("[autoClose, isPlaying]", "[autoClose, isPlaying, draft$]");
  assert.deepEqual(sourceVerdict(source), converted("draft$.get()"));
});

test("observable reaction reads: resolves an observable imported from another module", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-reaction-peeks-"));
  try {
    await writeFile(
      path.join(root, "state.ts"),
      'import { observable } from "@legendapp/state";\nexport const visualizer$ = observable({ isOpen: false });\n',
    );
    await writeFile(
      path.join(root, "Manager.tsx"),
      manager("if (!isPlaying && autoClose && visualizer$.isOpen.get()) close();").replace(
        'import { useEffect } from "react";',
        'import { useEffect } from "react";\nimport { visualizer$ } from "./state";',
      ),
    );
    const report = await analyzePath(root);
    const effect = requireValue(report.findings.find((finding) => finding.hook === "useEffect"));
    assert.deepEqual(reactionVerdict(effect), converted("visualizer$.isOpen.get()"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
