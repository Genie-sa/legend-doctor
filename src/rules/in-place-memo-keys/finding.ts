import type { InPlaceMemoKeyScan, RawValueBinding, RelativeWrite, StaleMemo } from "./model.js";
import { ARRAY_MUTATORS } from "../../project/source-components/observable-in-place-writes.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import { primitiveMemoName } from "./primitive-selection.js";

const LISTED_WRITES = 3;

export function inPlaceMemoKeyFinding(
  binding: RawValueBinding,
  memos: readonly StaleMemo[],
  scan: InPlaceMemoKeyScan,
): LegendPracticeFinding {
  const writes = distinctWrites(memos);
  const proven = memos.some((memo) => memo.otherDependencies.length === 0);
  const { line, character } = scan.sourceFile.getLineAndCharacterOfPosition(
    binding.call.getStart(scan.sourceFile),
  );
  return {
    action: "snapshot-mutated-use-value",
    confidence: proven ? "certain" : "probable",
    disposition: proven ? "change" : "candidate",
    evidence: [
      `${binding.sourceText} is written in place at ${describeWrites(writes)}; Legend keeps the object that holds the changed member, so \`${binding.call.expression.getText(scan.sourceFile)}\` rerenders with the same reference`,
      ...memos.map((memo) => memoEvidence(memo, binding, scan)),
    ],
    location: { column: character + 1, file: scan.fileName, line: line + 1 },
    message: proven ? provenMessage(binding, memos, scan) : candidateMessage(binding, memos, scan),
    practice: "reactivity",
  };
}

function provenMessage(
  binding: RawValueBinding,
  memos: readonly StaleMemo[],
  scan: InPlaceMemoKeyScan,
): string {
  const writes = distinctWrites(memos);
  const [memo] = memos;
  const selected = memo && memos.length === 1 ? primitiveMemoName(binding, memo, scan) : null;
  if (memo && selected) {
    const callee = binding.call.expression.getText(scan.sourceFile);
    return `Select the primitive instead of a snapshot: replace the useMemo at line ${lineOf(memo, scan)} with \`const ${selected} = ${callee}(() => …)\` computing the same expression from \`${binding.sourceText}.get()\` in place of \`${binding.name}\`, and delete \`const ${binding.name} = ${binding.call.getText(scan.sourceFile)}\`. The in-place write at ${describeWrites(writes)} keeps the reference, so the memo keeps a stale result; the selector reruns on every render, and an observable write rerenders the component only when \`${selected}\` changes.`;
  }
  return `${snapshotInstruction(binding, writes, scan)}. The in-place write at ${describeWrites(writes)} keeps the reference, so ${memoList(memos, scan)} keyed on \`${binding.name}\` keeps a stale result while the component rerenders. If the derivation is cheap, compute it without useMemo instead.`;
}

function candidateMessage(
  binding: RawValueBinding,
  memos: readonly StaleMemo[],
  scan: InPlaceMemoKeyScan,
): string {
  const writes = distinctWrites(memos);
  const others = [...new Set(memos.flatMap((memo) => memo.otherDependencies))];
  const names = others.map((name) => `\`${name}\``).join(", ");
  const [dependencies, pronoun] = others.length === 1 ? [names, "it"] : [`one of ${names}`, "them"];
  return `The in-place write at ${describeWrites(writes)} keeps the reference of \`${binding.name}\`, so ${memoList(memos, scan)} recomputes only when ${dependencies} also changes. If a write can leave ${pronoun} unchanged, ${lowercaseFirst(snapshotInstruction(binding, writes, scan))}.`;
}

function snapshotInstruction(
  binding: RawValueBinding,
  writes: readonly RelativeWrite[],
  scan: InPlaceMemoKeyScan,
): string {
  const current = binding.call.getText(scan.sourceFile);
  const read = `${binding.sourceText}.get()`;
  const copy = holdsArray(binding, writes, scan) ? `[...${read}]` : `({ ...${read} })`;
  const callee = binding.call.expression.getText(scan.sourceFile);
  return `Select a copy so the reference changes with the contents: replace \`${current}\` with \`${callee}(() => ${copy})\``;
}

function holdsArray(
  binding: RawValueBinding,
  writes: readonly RelativeWrite[],
  scan: InPlaceMemoKeyScan,
): boolean {
  return (
    scan.arrayPaths.has(binding.sourcePath.join(".")) ||
    writes.some((write) => write.path.length === 1 && ARRAY_MUTATORS.has(write.write.method))
  );
}

function memoEvidence(memo: StaleMemo, binding: RawValueBinding, scan: InPlaceMemoKeyScan): string {
  const line = lineOf(memo, scan);
  const others =
    memo.otherDependencies.length === 0
      ? "every other dependency keeps its identity across renders"
      : `it also depends on ${memo.otherDependencies.join(", ")}`;
  return `the useMemo at line ${line} reads what the write changes and compares \`${binding.name}\` by reference; ${others}`;
}

function memoList(memos: readonly StaleMemo[], scan: InPlaceMemoKeyScan): string {
  const lines = memos.map((memo) => lineOf(memo, scan));
  return lines.length === 1
    ? `the useMemo at line ${lines[0]}`
    : `the useMemos at lines ${lines.join(", ")}`;
}

function lineOf(memo: StaleMemo, scan: InPlaceMemoKeyScan): number {
  return (
    scan.sourceFile.getLineAndCharacterOfPosition(memo.call.getStart(scan.sourceFile)).line + 1
  );
}

function distinctWrites(memos: readonly StaleMemo[]): RelativeWrite[] {
  const seen = new Map<string, RelativeWrite>();
  for (const write of memos.flatMap((memo) => memo.writes)) {
    seen.set(`${write.write.file}:${write.write.line}:${write.write.method}`, write);
  }
  return [...seen.values()].toSorted(
    (left, right) =>
      left.write.file.localeCompare(right.write.file) || left.write.line - right.write.line,
  );
}

function describeWrites(writes: readonly RelativeWrite[]): string {
  const listed = writes
    .slice(0, LISTED_WRITES)
    .map(({ write }) => `${write.file}:${write.line} (\`${write.method}\`)`);
  const hidden = writes.length - listed.length;
  return hidden > 0 ? `${listed.join(", ")} and ${hidden} more` : listed.join(", ");
}

function lowercaseFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
