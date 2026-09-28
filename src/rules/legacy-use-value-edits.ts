import {
  directObservableArgumentEdit,
  directObservableSelectorPath,
} from "./observable-reads/use-value-inputs.js";
import {
  isLegacyUseValueSpecifier,
  isUnusedName,
  legendReactImports,
  namedImportElements,
  useValueReference,
} from "../core/use-value-import.js";
import { rangeHasComment, replaceNode, replaceRange } from "../core/text-edits.js";
import type { EditSource } from "../core/text-edits.js";
import type { TextEdit } from "../core/types.js";
import { identifiersNamed } from "../core/ast.js";
import { isNonValueIdentifier } from "../core/analysis-ast.js";
import ts from "typescript";

const USE_VALUE = "useValue";

export interface LegacyEditScan {
  readonly calls: readonly ts.CallExpression[];
  readonly observableBindings: ReadonlySet<string>;
  readonly source: EditSource;
}

interface MigrationTarget {
  readonly callee: string;
  readonly edits: readonly TextEdit[];
  readonly renamed: ts.ImportSpecifier | null;
}

type ElementRun = readonly [first: number, last: number];

function argumentEdits(call: ts.CallExpression, scan: LegacyEditScan): TextEdit[] | null {
  const [argument] = call.arguments;
  const observable =
    argument && call.arguments.length === 1
      ? directObservableSelectorPath(argument, scan.observableBindings)
      : null;
  if (!argument || !observable) {
    return [];
  }
  const edit = directObservableArgumentEdit(scan.source, argument, observable);
  return edit ? [edit] : null;
}

function namespaceCallEdits(
  call: ts.CallExpression,
  method: ts.PropertyAccessExpression,
  scan: LegacyEditScan,
): TextEdit[] | null {
  const argument = argumentEdits(call, scan);
  return argument && [replaceNode(scan.source, method.name, USE_VALUE), ...argument];
}

function retiredSpecifiers(
  sourceFile: ts.SourceFile,
  callees: ReadonlySet<string>,
): ts.ImportSpecifier[] {
  return legendReactImports(sourceFile)
    .flatMap((clause) => namedImportElements(clause))
    .filter((element) => isLegacyUseValueSpecifier(element) && callees.has(element.name.text));
}

/** Every value reference to a retired binding is one of the reported calls, so none survives the rename. */
function onlyCallsReference(
  sourceFile: ts.SourceFile,
  retired: readonly ts.ImportSpecifier[],
  calls: readonly ts.CallExpression[],
): boolean {
  const callees = new Set<ts.Node>(calls.map((call) => call.expression));
  return retired.every((specifier) =>
    identifiersNamed(sourceFile, specifier.name.text).every(
      (identifier) =>
        identifier === specifier.name ||
        isNonValueIdentifier(identifier) ||
        callees.has(identifier),
    ),
  );
}

function migrationTarget(
  source: EditSource,
  retired: readonly ts.ImportSpecifier[],
): MigrationTarget | null {
  const reference = useValueReference(source);
  if (reference) {
    return { ...reference, renamed: null };
  }
  const [first] = retired;
  if (!first || !isUnusedName(source.sourceFile, USE_VALUE)) {
    return null;
  }
  return { callee: USE_VALUE, edits: [replaceNode(source, first, USE_VALUE)], renamed: first };
}

function removedRuns(
  elements: readonly ts.ImportSpecifier[],
  removed: ReadonlySet<ts.ImportSpecifier>,
): ElementRun[] {
  const runs: ElementRun[] = [];
  for (const [index, element] of elements.entries()) {
    const previous = runs.at(-1);
    if (!removed.has(element)) {
      continue;
    }
    if (previous && previous[1] === index - 1) {
      runs[runs.length - 1] = [previous[0], index];
    } else {
      runs.push([index, index]);
    }
  }
  return runs;
}

/** A run takes the separator after it, or before it when it ends the list, so the rest stays well formed. */
function runRange(
  elements: readonly ts.ImportSpecifier[],
  [first, last]: ElementRun,
): ts.TextRange {
  const next = elements[last + 1];
  return next
    ? { end: next.getStart(), pos: elements[first]!.getStart() }
    : { end: elements[last]!.getEnd(), pos: elements[first - 1]!.getEnd() };
}

function removalEdits(
  source: EditSource,
  removed: ReadonlySet<ts.ImportSpecifier>,
): TextEdit[] | null {
  const ranges: ts.TextRange[] = [];
  for (const clause of legendReactImports(source.sourceFile)) {
    const elements = namedImportElements(clause);
    if (elements.length > 0 && elements.every((element) => removed.has(element))) {
      return null;
    }
    ranges.push(...removedRuns(elements, removed).map((run) => runRange(elements, run)));
  }
  return ranges.some((range) => rangeHasComment(source.sourceFile, range))
    ? null
    : ranges.map((range) => replaceRange(source, range, ""));
}

/**
 * One rewrite for every named legacy call in the file: each callee becomes `useValue`, and the
 * legacy specifiers they share leave the import. A partial rewrite would strand the other calls.
 */
function namedMigrationEdits(
  calls: readonly ts.CallExpression[],
  scan: LegacyEditScan,
): TextEdit[] | null {
  const { sourceFile } = scan.source;
  const retired = retiredSpecifiers(
    sourceFile,
    new Set(calls.map((call) => call.expression.getText(sourceFile))),
  );
  const retiredNames = new Set(retired.map((specifier) => specifier.name.text));
  const callEdits = calls.map((call) => argumentEdits(call, scan));
  const target = migrationTarget(scan.source, retired);
  if (
    !target ||
    calls.some((call) => !retiredNames.has(call.expression.getText(sourceFile))) ||
    !onlyCallsReference(sourceFile, retired, calls) ||
    callEdits.some((edits) => edits === null)
  ) {
    return null;
  }
  const removals = removalEdits(
    scan.source,
    new Set(retired.filter((specifier) => specifier !== target.renamed)),
  );
  return (
    removals && [
      ...target.edits,
      ...removals,
      ...calls.flatMap((call, index) => [
        replaceNode(scan.source, call.expression, target.callee),
        ...callEdits[index]!,
      ]),
    ]
  );
}

/** The edits for each legacy call; named calls share one file-wide rewrite because they share imports. */
export function legacyUseValueEdits(
  scan: LegacyEditScan,
): ReadonlyMap<ts.CallExpression, readonly TextEdit[]> {
  const named = scan.calls.filter((call) => ts.isIdentifier(call.expression));
  const shared = named.length > 0 ? namedMigrationEdits(named, scan) : null;
  return new Map(
    scan.calls.flatMap<[ts.CallExpression, readonly TextEdit[]]>((call) => {
      const method = call.expression;
      const edits = ts.isPropertyAccessExpression(method)
        ? namespaceCallEdits(call, method, scan)
        : shared;
      return edits ? [[call, edits]] : [];
    }),
  );
}
