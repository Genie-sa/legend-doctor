import type { CapturedRead, MemoCaptureScan, StaleMemo } from "./model.js";
import { computedReference, computedTagEdits } from "./computed-edits.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import { withEdits } from "../../core/text-edits.js";

const LISTED_READS = 4;

interface MemoNames {
  readonly computed: string;
  readonly owner: string;
  readonly tag: string;
}

export function staleMemoFinding(
  stale: StaleMemo,
  fileStale: readonly StaleMemo[],
  scan: MemoCaptureScan,
): LegendPracticeFinding {
  const proven = stale.reads.some((read) => read.change.kind === "subscribed");
  const { line, character } = scan.sourceFile.getLineAndCharacterOfPosition(
    stale.memo.element.getStart(scan.sourceFile),
  );
  const names: MemoNames = {
    computed: computedReference(stale, scan),
    owner: stale.ownerName ? `\`${stale.ownerName}\`` : "its owner",
    tag: stale.memo.openingTag.getText(scan.sourceFile),
  };
  return withEdits(
    {
      action: "use-computed-for-parent-reads",
      confidence: proven ? "certain" : "probable",
      disposition: proven ? "change" : "candidate",
      evidence: [
        `\`${names.tag}\` compares its props with an equality check that ignores new children unless \`scoped\` is set, so a render of ${names.owner} never reaches the child`,
        ...stale.reads.map((read) => readEvidence(read, names.owner)),
      ],
      location: { column: character + 1, file: scan.fileName, line: line + 1 },
      message: staleMemoMessage(stale.reads, names),
      practice: "reactivity",
    },
    computedTagEdits(stale, fileStale, scan),
  );
}

function staleMemoMessage(
  reads: readonly CapturedRead[],
  { computed, owner, tag }: MemoNames,
): string {
  const subscribed = reads.filter((read) => read.change.kind === "subscribed");
  const replacement = `\`<${tag}>\` with \`<${computed}>\``;
  const computedBehavior = `\`${computed}\` re-renders with its parent and still tracks the observables the child reads`;
  if (subscribed.length > 0) {
    return `Replace ${replacement}. ${readList(subscribed)} ${subscribed.length === 1 ? "changes" : "change"} when ${owner} re-renders, but \`${tag}\` never re-renders from its parent, so the child keeps the value from its first render. ${computedBehavior}.`;
  }
  return `\`${tag}\` never re-renders from its parent, so its child keeps the first render's ${readList(reads)}. If ${reads.length === 1 ? "it" : "any of them"} can change while ${owner} stays mounted, replace ${replacement}; ${computedBehavior}.`;
}

function readList(reads: readonly CapturedRead[]): string {
  const names = reads.slice(0, LISTED_READS).map((read) => `\`${read.name}\``);
  const hidden = reads.length - names.length;
  return hidden > 0 ? `${names.join(", ")} and ${hidden} more` : names.join(", ");
}

function readEvidence(read: CapturedRead, owner: string): string {
  const { change } = read;
  const origin =
    change.kind === "subscribed"
      ? `the \`${change.hook}\` result at line ${change.line}, which re-renders ${owner}`
      : `${change.source} at line ${change.line}`;
  return change.binding === read.name
    ? `\`${read.name}\` (line ${read.line}) is ${origin}`
    : `\`${read.name}\` (line ${read.line}) depends on \`${change.binding}\`, ${origin}`;
}
