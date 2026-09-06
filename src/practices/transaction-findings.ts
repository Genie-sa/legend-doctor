import type { ObservableWrite, TransactionRun, TransactionScan } from "./model.js";
import type { LegendPracticeFinding } from "../core/types.js";
import { isEvaluationInert } from "../core/analysis-ast.js";
import ts from "typescript";
import { visit } from "../core/ast.js";

function hasDistinctNonOverlappingPaths(writes: readonly ObservableWrite[]): boolean {
  const paths = writes.map((write) => write.path);
  if (new Set(paths).size !== paths.length) {
    return false;
  }
  return paths.every((path, index) =>
    paths.every((other, otherIndex) => {
      if (index === otherIndex) {
        return true;
      }
      return !path.startsWith(`${other}.`) && !other.startsWith(`${path}.`);
    }),
  );
}

function writeLocation(
  write: ObservableWrite,
  scan: TransactionScan,
): LegendPracticeFinding["location"] {
  const { character, line } = scan.sourceFile.getLineAndCharacterOfPosition(
    write.call.getStart(scan.sourceFile),
  );
  return { column: character + 1, file: scan.fileName, line: line + 1 };
}

export function transactionFinding(
  run: TransactionRun,
  scan: TransactionScan,
): LegendPracticeFinding | null {
  const { conditionalWrites, writes } = run;
  if (conditionalWrites.length > 0) {
    return hasDistinctNonOverlappingPaths([...writes, ...conditionalWrites])
      ? conditionalBatchFinding(run, scan)
      : null;
  }
  if (!hasDistinctNonOverlappingPaths(writes)) {
    return null;
  }
  const location = writeLocation(writes[0]!, scan);
  const assignTarget = commonAssignTarget(writes);
  if (assignTarget) {
    return assignFieldsFinding(writes, assignTarget, location);
  }
  return batchWritesFinding(writes, location);
}

function assignFieldsFinding(
  writes: readonly ObservableWrite[],
  assignTarget: string,
  location: LegendPracticeFinding["location"],
): LegendPracticeFinding {
  const fields = writes.map((write) => `\`${write.property}\``).join(", ");
  return {
    action: "assign-observable-fields",
    confidence: "probable",
    disposition: "change",
    evidence: [
      `${writes.length} consecutive writes target direct fields of ${assignTarget}`,
      "each value is independent of the updated observable and no control-flow boundary splits the writes",
    ],
    location,
    message: `Replace ${writes.length} \`.set()\` calls with one \`${assignTarget}.assign(...)\` for ${fields}; observers publish once.`,
    practice: "assign",
  };
}

function batchWritesFinding(
  writes: readonly ObservableWrite[],
  location: LegendPracticeFinding["location"],
): LegendPracticeFinding {
  return {
    action: "batch-observable-writes",
    confidence: "probable",
    disposition: "change",
    evidence: [
      `${writes.length} consecutive writes target distinct proven Legend observable paths`,
      "no await, yield, control-flow boundary, or existing batch surrounds the writes",
    ],
    location,
    message: `Wrap these ${writes.length} consecutive Legend observable writes in \`batch(() => { ... })\` so observers publish the transaction once.`,
    practice: "batch",
  };
}

function conditionalBatchFinding(
  run: TransactionRun,
  scan: TransactionScan,
): LegendPracticeFinding {
  const { conditionalWrites, writes } = run;
  const assignTarget = commonAssignTarget(writes);
  const conditionalPaths = conditionalWrites.map((write) => `\`${write.path}\``).join(", ");
  const assignHint = assignTarget
    ? ` inside the batch, one \`${assignTarget}.assign(...)\` can replace the unconditional field writes;`
    : "";
  return {
    action: "batch-observable-writes",
    confidence: "probable",
    disposition: "change",
    evidence: [
      `${writes.length} consecutive writes and a conditional write to ${conditionalPaths} target the same proven Legend observable`,
      "replacing only the unconditional writes would still let the conditional write publish a separate, torn transaction",
    ],
    location: writeLocation(writes[0]!, scan),
    message: `Wrap these ${writes.length} \`.set()\` calls and the conditional write to ${conditionalPaths} in one \`batch(() => { ... })\`;${assignHint} observers publish the transaction once.`,
    practice: "batch",
  };
}

function commonAssignTarget(writes: readonly ObservableWrite[]): string | null {
  const target = writes[0]?.parentPath;
  if (
    !target ||
    writes.some(
      (write) =>
        write.parentPath !== target ||
        write.property === null ||
        ts.isArrowFunction(write.argument) ||
        ts.isFunctionExpression(write.argument) ||
        !isEvaluationInert(write.argument) ||
        expressionReferencesIdentifier(write.argument, write.root),
    )
  ) {
    return null;
  }
  return target;
}

function expressionReferencesIdentifier(expression: ts.Expression, name: string): boolean {
  let found = false;
  visit(expression, (node) => {
    if (ts.isIdentifier(node) && node.text === name) {
      found = true;
    }
  });
  return found;
}
