import type { ResolvedSymbol, SourceIndexState } from "./model.js";
import { isDeclarationName, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import type { ExecutionUnit } from "../../core/execution-units.js";
import { RESERVED_OBSERVABLE_MEMBERS } from "../../rules/observable-reads/observable-paths.js";
import { executionUnit } from "../../core/execution-units.js";
import { moduleRecord } from "./module-record.js";
import { normalizeFile } from "./module-resolution.js";
import path from "node:path";
import { resolvedFor } from "./symbol-resolution.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

/**
 * A write that changes an observable's raw value while keeping the object that holds the changed
 * member: Legend mutates arrays and objects in place for child writes and array methods.
 */
export interface InPlaceObservableWrite {
  readonly file: string;
  readonly line: number;
  readonly method: string;
  /** The changed member below the observable root; `*` is a key known only at runtime. */
  readonly path: readonly string[];
  /** Writes of one file with the same unit key run in one synchronous stretch, so one render sees them all. */
  readonly unit: ExecutionUnit;
}

/** In-place writes that can reach each observable a file can name, keyed by its local name. */
export type ObservableInPlaceWrites = ReadonlyMap<string, readonly InPlaceObservableWrite[]>;

interface RootedWrite {
  readonly root: string;
  readonly write: InPlaceObservableWrite;
}

export const ANY_MEMBER = "*";

export const ARRAY_MUTATORS: ReadonlySet<string> = new Set([
  "copyWithin",
  "fill",
  "pop",
  "push",
  "reverse",
  "shift",
  "sort",
  "splice",
  "unshift",
]);
const SET_MUTATORS = new Set(["add", "clear"]);
const CHILD_WRITES = new Set(["delete", "set", "toggle"]);
const CHILD_PROXY_FINDERS = new Set(["find", "findLast"]);

const writesBySymbolByIndex = new WeakMap<SourceIndexState, ReadonlyMap<string, RootedWrite[]>>();

export function observableInPlaceWritesFor(
  state: SourceIndexState,
  file: string,
): ObservableInPlaceWrites {
  const normalized = normalizeFile(file);
  const writesBySymbol = indexedWrites(state);
  const result = new Map<string, readonly InPlaceObservableWrite[]>();
  for (const [localName, symbol] of visibleObservables(state, normalized)) {
    const writes = writesBySymbol.get(symbolKey(symbol));
    if (writes) {
      result.set(
        localName,
        writes.map((entry) => entry.write),
      );
    }
  }
  return result;
}

/** Rewrites each write's file relative to the analysis root, as findings report locations. */
export function relativeInPlaceWrites(
  writes: ObservableInPlaceWrites,
  root: string,
): ObservableInPlaceWrites {
  return new Map(
    [...writes].map(([name, sites]) => [
      name,
      sites.map((site) => ({ ...site, file: path.relative(root, site.file) || site.file })),
    ]),
  );
}

/** The same facts for one parsed file on its own, for callers that analyze a single source. */
export function localObservableInPlaceWrites(sourceFile: ts.SourceFile): ObservableInPlaceWrites {
  const declared = moduleRecord(sourceFile).observableDeclarations;
  const counts = declarationCounts(sourceFile);
  const result = new Map<string, InPlaceObservableWrite[]>();
  for (const { root, write } of collectInPlaceWrites(sourceFile)) {
    if (declared.has(root) && counts.get(root) === 1) {
      result.set(root, [...(result.get(root) ?? []), write]);
    }
  }
  return result;
}

function visibleObservables(
  state: SourceIndexState,
  file: string,
): ReadonlyMap<string, ResolvedSymbol> {
  const visible = new Map(resolvedFor(state, file, "observable"));
  const sourceFile = state.sourceFiles.get(file);
  const counts = sourceFile ? declarationCounts(sourceFile) : new Map<string, number>();
  for (const localName of state.records.get(file)?.observableDeclarations ?? []) {
    if (counts.get(localName) === 1) {
      visible.set(localName, { file, localName });
    }
  }
  return visible;
}

function indexedWrites(state: SourceIndexState): ReadonlyMap<string, RootedWrite[]> {
  const cached = writesBySymbolByIndex.get(state);
  if (cached) {
    return cached;
  }
  const index = new Map<string, RootedWrite[]>();
  for (const [file, sourceFile] of state.sourceFiles) {
    for (const [key, entry] of keyedFileWrites(state, file, sourceFile)) {
      index.set(key, [...(index.get(key) ?? []), entry]);
    }
  }
  writesBySymbolByIndex.set(state, index);
  return index;
}

/** A write reaches an imported observable only when the writing file does not redeclare its root. */
function keyedFileWrites(
  state: SourceIndexState,
  file: string,
  sourceFile: ts.SourceFile,
): [string, RootedWrite][] {
  const writes = collectInPlaceWrites(sourceFile);
  if (writes.length === 0) {
    return [];
  }
  const visible = visibleObservables(state, file);
  const counts = declarationCounts(sourceFile);
  return writes.flatMap((entry): [string, RootedWrite][] => {
    const symbol = visible.get(entry.root);
    return symbol && (symbol.file === file || !counts.has(entry.root))
      ? [[symbolKey(symbol), entry]]
      : [];
  });
}

function symbolKey(symbol: ResolvedSymbol): string {
  return `${symbol.file}\0${symbol.localName}`;
}

function declarationCounts(sourceFile: ts.SourceFile): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  visit(sourceFile, (node) => {
    if (ts.isIdentifier(node) && isDeclarationName(node)) {
      counts.set(node.text, (counts.get(node.text) ?? 0) + 1);
    }
  });
  return counts;
}

function collectInPlaceWrites(sourceFile: ts.SourceFile): RootedWrite[] {
  const writes: RootedWrite[] = [];
  visit(sourceFile, (node) => {
    if (ts.isCallExpression(node)) {
      writes.push(...inPlaceWrites(node));
    }
  });
  return writes;
}

function inPlaceWrites(call: ts.CallExpression): RootedWrite[] {
  const callee = call.expression;
  const receiver = ts.isPropertyAccessExpression(callee)
    ? observableChain(callee.expression)
    : null;
  if (!receiver || !ts.isPropertyAccessExpression(callee)) {
    return [];
  }
  const method = callee.name.text;
  const sourceFile = call.getSourceFile();
  const line = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line + 1;
  const unit = executionUnit(call);
  return changedPaths(call, method, receiver.members).map((changed) => ({
    root: receiver.root,
    write: { file: sourceFile.fileName, line, method, path: changed, unit },
  }));
}

/** Map and Set observables mutate the collection itself for keyed `set`/`delete`, `add`, and `clear`. */
function changesMembership(method: string, argumentCount: number): boolean {
  return (
    ARRAY_MUTATORS.has(method) ||
    SET_MUTATORS.has(method) ||
    (method === "delete" && argumentCount > 0) ||
    (method === "set" && argumentCount > 1)
  );
}

function changedPaths(
  call: ts.CallExpression,
  method: string,
  members: readonly string[],
): (readonly string[])[] {
  if (changesMembership(method, call.arguments.length)) {
    return [[...members, ANY_MEMBER]];
  }
  if (CHILD_WRITES.has(method)) {
    return members.length > 0 ? [members] : [];
  }
  if (method !== "assign") {
    return [];
  }
  return assignedKeys(call).map((key) => [...members, key]);
}

function assignedKeys(call: ts.CallExpression): readonly string[] {
  const [argument] = call.arguments;
  const value = argument ? unwrapTransparentExpression(argument) : null;
  if (!value || !ts.isObjectLiteralExpression(value)) {
    return [ANY_MEMBER];
  }
  const keys = value.properties.map((property) =>
    (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
    !ts.isComputedPropertyName(property.name)
      ? property.name.text
      : ANY_MEMBER,
  );
  return keys.length > 0 ? [...new Set(keys)] : [];
}

interface ObservableChain {
  readonly members: readonly string[];
  readonly root: string;
}

function observableChain(expression: ts.Expression): ObservableChain | null {
  const current = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(current)) {
    return { members: [], root: current.text };
  }
  const step = chainStep(current);
  if (!step || step.member === null) {
    return null;
  }
  const receiver = observableChain(step.next);
  return receiver ? { members: [...receiver.members, step.member], root: receiver.root } : null;
}

interface ChainStep {
  readonly member: string | null;
  readonly next: ts.Expression;
}

function chainStep(node: ts.Expression): ChainStep | null {
  if (ts.isPropertyAccessExpression(node)) {
    const member = RESERVED_OBSERVABLE_MEMBERS.has(node.name.text) ? null : node.name.text;
    return { member, next: unwrapTransparentExpression(node.expression) };
  }
  if (ts.isElementAccessExpression(node)) {
    const key = unwrapTransparentExpression(node.argumentExpression);
    const member = ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text : ANY_MEMBER;
    return { member, next: unwrapTransparentExpression(node.expression) };
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    CHILD_PROXY_FINDERS.has(node.expression.name.text)
  ) {
    return { member: ANY_MEMBER, next: unwrapTransparentExpression(node.expression.expression) };
  }
  return null;
}
