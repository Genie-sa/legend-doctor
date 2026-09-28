import type { ObservableReadScan, RawValueReadScan } from "./model.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import type { ObservableFieldFacts } from "./field-writes.js";
import { identifiedUseValueDeclaration } from "./observable-paths.js";
import { isNonValueIdentifier } from "../../core/analysis-ast.js";
import { topLevelFields } from "./field-writes.js";
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

interface OwnerNames {
  /** Identifiers the owner already reads; reusing one would shadow or redeclare it. */
  readonly bound: ReadonlySet<string>;
  /** Leaf names another `useValue` binding in the owner reads, which its own split would declare. */
  readonly siblingLeaves: ReadonlySet<string>;
}

function ownerNames(reads: RawValueReadScan, scan: ObservableReadScan): OwnerNames {
  const siblings = new Set<string>();
  visit(reads.owner.body, (node) => {
    if (ts.isVariableDeclaration(node) && node !== reads.candidate.declaration) {
      const sibling = identifiedUseValueDeclaration(node, scan);
      if (sibling) {
        siblings.add(sibling.localName);
      }
    }
  });
  const bound = new Set<string>();
  const siblingLeaves = new Set<string>();
  visit(reads.owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node !== reads.candidate.declaration.name &&
      !isNonValueIdentifier(node)
    ) {
      bound.add(node.text);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      siblings.has(node.expression.text)
    ) {
      siblingLeaves.add(node.name.text);
    }
  });
  return { bound, siblingLeaves };
}

function leafSubscriptions(
  leaves: readonly (readonly string[])[],
  prefix: readonly string[],
): readonly LeafSubscription[] {
  return leaves.map((path) => ({ name: camelName([...prefix, ...path]), path }));
}

function avoids(leafNames: readonly LeafSubscription[], names: ReadonlySet<string>): boolean {
  return leafNames.every((leaf) => !names.has(leaf.name));
}

export function splitLeavesFinding(
  reads: RawValueReadScan,
  scan: ObservableReadScan,
): LegendPracticeFinding | null {
  const leaves = distinctLeafPaths(reads.paths);
  const siblings =
    leaves.length < MIN_SPLIT_LEAVES ? [] : independentlyWrittenSiblings(reads, scan);
  const leafNames = siblings.length === 0 ? null : unboundLeafNames(reads, leaves, scan);
  return leafNames ? splitLeavesMessage({ leafNames, reads, siblings }, scan) : null;
}

function unboundLeafNames(
  reads: RawValueReadScan,
  leaves: readonly (readonly string[])[],
  scan: ObservableReadScan,
): readonly LeafSubscription[] | null {
  const { bound, siblingLeaves } = ownerNames(reads, scan);
  const plain = leafSubscriptions(leaves, []);
  const leafNames = avoids(plain, siblingLeaves)
    ? plain
    : leafSubscriptions(leaves, [reads.localName]);
  const distinct = new Set(leafNames.map((leaf) => leaf.name)).size === leafNames.length;
  return distinct && avoids(plain, bound) && avoids(leafNames, bound) ? leafNames : null;
}

/**
 * Unread data fields that some write changes without touching a field the owner reads. Without
 * one, every render the broad subscription causes is a render the leaf subscriptions cause too.
 */
function independentlyWrittenSiblings(
  reads: RawValueReadScan,
  scan: ObservableReadScan,
): readonly string[] {
  const { observable } = reads.candidate;
  const name = ts.isIdentifier(observable) ? observable.text : null;
  const read =
    name === null ? null : provenReadFields(reads.paths, scan.observableFields.keys.get(name));
  return name !== null && read ? unreadWrittenFields(scan.observableFields, name, read) : [];
}

function unreadWrittenFields(
  { dataKeys, writes }: ObservableFieldFacts,
  name: string,
  read: ReadonlySet<string>,
): readonly string[] {
  const data = dataKeys.get(name) ?? new Set<string>();
  const siblings = (writes.get(name) ?? [])
    .map((group) => topLevelFields(group))
    .filter((fields) => fields !== null && [...fields].every((field) => !read.has(field)))
    .flatMap((fields) => [...(fields ?? [])].filter((field) => data.has(field)));
  return [...new Set(siblings)].toSorted();
}

/** The top-level fields the reads consume, when each is a key of the observable's exact shape. */
function provenReadFields(
  paths: readonly (readonly string[])[],
  fields: ReadonlySet<string> | undefined,
): ReadonlySet<string> | null {
  const read = new Set<string>();
  for (const [field] of paths) {
    if (field === undefined || !fields?.has(field)) {
      return null;
    }
    read.add(field);
  }
  return read;
}

interface SplitInstruction {
  readonly leafNames: readonly LeafSubscription[];
  readonly reads: RawValueReadScan;
  readonly siblings: readonly string[];
}

function splitLeavesMessage(
  { leafNames, reads, siblings }: SplitInstruction,
  scan: ObservableReadScan,
): LegendPracticeFinding {
  const { line, character } = scan.sourceFile.getLineAndCharacterOfPosition(
    reads.candidate.declaration.getStart(scan.sourceFile),
  );
  const parentPath = reads.candidate.observable.getText(scan.sourceFile);
  const { hook } = reads.candidate;
  const declarations = leafNames
    .map((leaf) => `\`const ${leaf.name} = ${hook}(${parentPath}.${leaf.path.join(".")})\``)
    .join(", ");
  return {
    action: "split-use-value-leaves",
    confidence: "certain",
    disposition: "change",
    evidence: [
      `${reads.paths.length} raw-value reads resolve through ${leafNames.length} distinct static leaf paths`,
      "every read is a static property chain and no read escapes as a whole value, call, write, or dynamic access",
      `unread ${siblings.map((sibling) => `\`${sibling}\``).join(", ")} ${siblings.length === 1 ? "is" : "are"} written without any field this owner reads, so each such write rerenders it today`,
    ],
    location: { column: character + 1, file: scan.fileName, line: line + 1 },
    message: `Split \`${reads.localName}\` from \`${hook}(${parentPath})\` into per-leaf subscriptions: ${declarations}; rewrite the ${reads.paths.length} raw-value reads of \`${reads.localName}.*\` to those leaf values so sibling fields no longer invalidate this component.`,
    practice: "reactivity",
  };
}

function camelName(segments: readonly string[]): string {
  return segments
    .map((segment, index) =>
      index === 0 ? segment : segment.charAt(0).toUpperCase() + segment.slice(1),
    )
    .join("");
}
