import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { HookFinding } from "../../src/core/types.js";
import { analyzePath } from "../../src/project/analyze-path/analyze-path.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";

export interface ReactionVerdict {
  readonly action: HookFinding["action"];
  /** The called function the review names as able to track a read the rewrite cannot peek. */
  readonly callee: string | null;
  readonly peeks: readonly string[];
  readonly reason: HookFinding["abstentionReason"] | null;
}

export function manager(body: string, extraHooks = "", helpers = ""): string {
  return `
    import { observable } from "@legendapp/state";
    import { useObservable, useValue } from "@legendapp/state/react";
    import { useEffect, useState } from "react";
    const window$ = observable({ isOpen: false, size: { width: 1 } });
    const player$ = observable({ isPlaying: false, autoClose: true });
    export function Manager({ onStop, store }: { onStop: () => void; store: { get: () => boolean } }) {
      const isPlaying = useValue(player$.isPlaying);
      const autoClose = useValue(player$.autoClose);
      ${extraHooks}
      useEffect(() => {
        ${body}
      }, [autoClose, isPlaying]);
      return null;
    }
    ${helpers}
  `;
}

export function reactionVerdict(finding: HookFinding): ReactionVerdict {
  const peeks = [...finding.message.matchAll(/`(?<read>[^`]+)` with `[^`]+\.peek\([^`]*\)`/gu)].map(
    (match) => match.groups!.read!,
  );
  const callee = /`(?<callee>[^`]+)` can run, before it returns/u.exec(finding.message)?.groups
    ?.callee;
  return {
    action: finding.action,
    callee: callee ?? null,
    peeks,
    reason: finding.abstentionReason ?? null,
  };
}

export function sourceVerdict(source: string): ReactionVerdict {
  const effect = requireValue(
    analyzeSource(source, "fixture.tsx").find((finding) => finding.hook === "useEffect"),
  );
  return reactionVerdict(effect);
}

export const converted = (...peeks: string[]): ReactionVerdict => ({
  action: "use-observe-effect",
  callee: null,
  peeks,
  reason: null,
});

export const untrackable: ReactionVerdict = {
  action: "review-effect",
  callee: null,
  peeks: [],
  reason: "callback-timing-unresolved",
};

export const untrackableCall = (callee: string): ReactionVerdict => ({ ...untrackable, callee });

export async function projectVerdict(
  files: Readonly<Record<string, string>>,
): Promise<ReactionVerdict> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-reaction-helpers-"));
  try {
    await Promise.all(
      Object.entries(files).map(([name, source]) => writeFile(path.join(root, name), source)),
    );
    const report = await analyzePath(root);
    return reactionVerdict(
      requireValue(report.findings.find((finding) => finding.hook === "useEffect")),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}
