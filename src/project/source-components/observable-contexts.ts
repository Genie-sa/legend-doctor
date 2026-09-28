import type { ModuleRecord, ObservableContextType, SourceIndexState } from "./model.js";
import { normalizeFile } from "./module-resolution.js";
import { resolvedFor } from "./symbol-resolution.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

/** How a local name reads a context: the context object itself, or a hook that returns its value. */
export interface ObservableContextReader extends ObservableContextType {
  readonly kind: "context" | "hook";
}

const NULLISH_TYPES: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.NullKeyword,
  ts.SyntaxKind.UndefinedKeyword,
]);

/** `createContext<T | null>(…)`: the declared value type `T`, when the module can name observables. */
export function declaredObservableContextType(
  initializer: ts.Expression,
  observableTypes: ReadonlySet<string>,
): ObservableContextType | null {
  const call = unwrapTransparentExpression(initializer);
  const [declared, ...rest] = ts.isCallExpression(call) ? (call.typeArguments ?? []) : [];
  if (observableTypes.size === 0 || !declared || rest.length > 0) {
    return null;
  }
  const members = ts.isUnionTypeNode(declared) ? declared.types : [declared];
  const values = members.filter((member) => !isNullishType(member));
  const [value, ...others] = values;
  return value && others.length === 0 ? { observableTypes, value } : null;
}

function isNullishType(type: ts.TypeNode): boolean {
  return (
    NULLISH_TYPES.has(type.kind) ||
    (ts.isLiteralTypeNode(type) && type.literal.kind === ts.SyntaxKind.NullKeyword)
  );
}

/** Context readers a single module declares, for analysis without a project index. */
export function localObservableContextReaders(
  record: ModuleRecord,
): ReadonlyMap<string, ObservableContextReader> {
  const readers = new Map<string, ObservableContextReader>();
  for (const [name, type] of record.observableContexts) {
    readers.set(name, { ...type, kind: "context" });
  }
  for (const [hook, context] of record.contextReaderHooks) {
    const type = record.observableContexts.get(context);
    if (type) {
      readers.set(hook, { ...type, kind: "hook" });
    }
  }
  return readers;
}

/** Every context, and every hook returning a context value, that `file` can name, keyed by local name. */
export function observableContextReadersFor(
  state: SourceIndexState,
  file: string,
): ReadonlyMap<string, ObservableContextReader> {
  const normalized = normalizeFile(file);
  const record = state.records.get(normalized);
  if (!record) {
    return new Map();
  }
  const readers = new Map(localObservableContextReaders(record));
  addReaders(readers, "hook", localHooksOfImportedContexts(state, normalized, record));
  addReaders(readers, "context", importedContexts(state, normalized));
  addReaders(readers, "hook", importedHooks(state, normalized));
  return readers;
}

function addReaders(
  readers: Map<string, ObservableContextReader>,
  kind: ObservableContextReader["kind"],
  types: Iterable<readonly [string, ObservableContextType | null]>,
): void {
  for (const [name, type] of types) {
    if (type && !readers.has(name)) {
      readers.set(name, { ...type, kind });
    }
  }
}

function* localHooksOfImportedContexts(
  state: SourceIndexState,
  file: string,
  record: ModuleRecord,
): Iterable<readonly [string, ObservableContextType | null]> {
  for (const [hook, context] of record.contextReaderHooks) {
    yield [hook, importedContextType(state, file, context)];
  }
}

function* importedContexts(
  state: SourceIndexState,
  file: string,
): Iterable<readonly [string, ObservableContextType | null]> {
  for (const name of resolvedFor(state, file, "react-context").keys()) {
    yield [name, importedContextType(state, file, name)];
  }
}

function* importedHooks(
  state: SourceIndexState,
  file: string,
): Iterable<readonly [string, ObservableContextType | null]> {
  for (const [name, hook] of resolvedFor(state, file, "context-reader-hook")) {
    const context = state.records.get(hook.file)?.contextReaderHooks.get(hook.localName);
    yield [name, context === undefined ? null : contextTypeIn(state, hook.file, context)];
  }
}

function contextTypeIn(
  state: SourceIndexState,
  file: string,
  name: string,
): ObservableContextType | null {
  return (
    state.records.get(file)?.observableContexts.get(name) ?? importedContextType(state, file, name)
  );
}

function importedContextType(
  state: SourceIndexState,
  file: string,
  name: string,
): ObservableContextType | null {
  const symbol = resolvedFor(state, file, "react-context").get(name);
  return symbol
    ? (state.records.get(symbol.file)?.observableContexts.get(symbol.localName) ?? null)
    : null;
}
