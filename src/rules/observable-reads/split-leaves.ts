import type { ObservableReadScan, RawValueReadScan } from "./model.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import { isNonValueIdentifier } from "../../core/analysis-ast.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

const MIN_SPLIT_LEAVES = 2;

interface LeafSubscription {
  readonly name: string;
  readonly path: readonly string[];
}

function distinctLeafPaths(reads: readonly (readonly string[])[]): readonly (readonly string[])[] {
  const distinct: string[][] = [];
  for (const path of reads) {
    if (!distinct.some((existing) => existing.join(".") === path.join("."))) {
      distinct.push([...path]);
    }
  }
  distinct.sort((left, right) => left.length - right.length);
  return distinct.filter(
    (path) =>
      !distinct.some(
        (other) =>
          other.length < path.length && other.every((segment, index) => segment === path[index]),
      ),
  );
}

function hasProposedNameCollision(
  reads: RawValueReadScan,
  proposedNames: ReadonlySet<string>,
): boolean {
  let collision = false;
  visit(reads.owner.body, (node) => {
    if (
      !collision &&
      ts.isIdentifier(node) &&
      node !== reads.candidate.declaration.name &&
      !isNonValueIdentifier(node) &&
      proposedNames.has(node.text)
    ) {
      collision = true;
    }
  });
  return collision;
}

export function splitLeavesFinding(
  reads: RawValueReadScan,
  scan: ObservableReadScan,
): LegendPracticeFinding | null {
  const leaves = distinctLeafPaths(reads.paths);
  if (leaves.length < MIN_SPLIT_LEAVES) {
    return null;
  }
  const leafNames: readonly LeafSubscription[] = leaves.map((path) => ({
    name: leafSubscriptionName(path),
    path,
  }));
  const proposedNames = new Set(leafNames.map((leaf) => leaf.name));
  if (proposedNames.size !== leafNames.length || hasProposedNameCollision(reads, proposedNames)) {
    return null;
  }
  return splitLeavesMessage(reads, leafNames, scan);
}

function splitLeavesMessage(
  reads: RawValueReadScan,
  leafNames: readonly LeafSubscription[],
  scan: ObservableReadScan,
): LegendPracticeFinding {
  const { line, character } = scan.sourceFile.getLineAndCharacterOfPosition(
    reads.candidate.declaration.getStart(scan.sourceFile),
  );
  const parentPath = reads.candidate.observable.getText(scan.sourceFile);
  const declarations = leafNames
    .map((leaf) => `\`const ${leaf.name} = useValue(${parentPath}.${leaf.path.join(".")})\``)
    .join(", ");
  return {
    action: "split-use-value-leaves",
    confidence: "certain",
    disposition: "change",
    evidence: [
      `${reads.paths.length} raw-value reads resolve through ${leafNames.length} distinct static leaf paths`,
      "every read is a static property chain and no read escapes as a whole value, call, write, or dynamic access",
    ],
    location: { column: character + 1, file: scan.fileName, line: line + 1 },
    message: `Split \`${reads.localName}\` from \`useValue(${parentPath})\` into per-leaf subscriptions: ${declarations}; rewrite the ${reads.paths.length} raw-value reads of \`${reads.localName}.*\` to those leaf values so sibling fields no longer invalidate this component.`,
    practice: "reactivity",
  };
}

function leafSubscriptionName(path: readonly string[]): string {
  return path
    .map((segment, index) =>
      index === 0 ? segment : segment.charAt(0).toUpperCase() + segment.slice(1),
    )
    .join("");
}
