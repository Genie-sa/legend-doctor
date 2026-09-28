import type { ModuleRecord, SourceIndexState } from "./model.js";
import { hasExport, unwrapTransparentExpression } from "./declaration-shapes.js";
import { lexicalBinding } from "../../core/lexical-bindings.js";
import { resolveModule } from "./module-resolution.js";
import ts from "typescript";

/** A component binding whose props are compared before it renders again. */
export interface MemoizedComponent {
  /** `memo` received its own props comparator, so shallow identity no longer decides a render. */
  readonly comparator: boolean;
  readonly file: string;
  readonly name: string;
  readonly wrapper: MemoizingWrapper;
}

/** `observer` from Legend State or MobX wraps its component in `memo`. */
type MemoizingWrapper = "memo" | "observer";

type ComponentWrapper = MemoizingWrapper | "forwardRef";

interface MemoizedModule {
  readonly exports: ReadonlyMap<string, MemoizedComponent>;
  readonly locals: ReadonlyMap<string, MemoizedComponent>;
}

interface ExportTarget {
  readonly depth: number;
  readonly exportName: string;
  readonly file: string;
}

interface WrapperLayer {
  /** `memo` received its own props comparator. */
  readonly comparator: boolean;
  readonly wrapper: ComponentWrapper;
}

interface WrapperImport {
  readonly moduleSpecifier: string;
  readonly importedName: string;
}

const WRAPPER_IMPORTS: readonly (WrapperImport & { readonly wrapper: ComponentWrapper })[] = [
  { importedName: "memo", moduleSpecifier: "react", wrapper: "memo" },
  { importedName: "forwardRef", moduleSpecifier: "react", wrapper: "forwardRef" },
  { importedName: "observer", moduleSpecifier: "@legendapp/state/react", wrapper: "observer" },
  {
    importedName: "reactiveObserver",
    moduleSpecifier: "@legendapp/state/react",
    wrapper: "observer",
  },
  { importedName: "observer", moduleSpecifier: "mobx-react", wrapper: "observer" },
  { importedName: "observer", moduleSpecifier: "mobx-react-lite", wrapper: "observer" },
];

const NAMESPACE_WRAPPERS: ReadonlyMap<string, ReadonlyMap<string, ComponentWrapper>> = new Map([
  [
    "react",
    new Map<string, ComponentWrapper>([
      ["forwardRef", "forwardRef"],
      ["memo", "memo"],
    ]),
  ],
]);

const MAX_EXPORT_DEPTH = 8;

const memoizedModules = new WeakMap<ts.SourceFile, MemoizedModule>();

/** The memoized component a local JSX tag name renders, resolved through imports and re-exports. */
export function memoizedComponentFor(
  state: SourceIndexState,
  file: string,
  localName: string,
): MemoizedComponent | null {
  const sourceFile = state.sourceFiles.get(file);
  const record = state.records.get(file);
  if (!sourceFile || !record) {
    return null;
  }
  const local = memoizedModule(sourceFile).locals.get(localName);
  if (local) {
    return local;
  }
  const binding = record.imports.get(localName);
  const target = binding ? resolveModule(state, file, binding.moduleSpecifier) : null;
  return binding && target
    ? exportedMemoizedComponent(state, { depth: 0, exportName: binding.importedName, file: target })
    : null;
}

function exportedMemoizedComponent(
  state: SourceIndexState,
  target: ExportTarget,
): MemoizedComponent | null {
  const sourceFile = state.sourceFiles.get(target.file);
  const record = state.records.get(target.file);
  if (!sourceFile || !record || target.depth > MAX_EXPORT_DEPTH) {
    return null;
  }
  const direct = memoizedModule(sourceFile).exports.get(target.exportName);
  return (
    direct ??
    importedThenExported(state, record, target) ??
    reexportedMemoizedComponent(state, record, target)
  );
}

function importedThenExported(
  state: SourceIndexState,
  record: ModuleRecord,
  target: ExportTarget,
): MemoizedComponent | null {
  const localName = record.localExports.get(target.exportName);
  const binding = localName === undefined ? undefined : record.imports.get(localName);
  const resolved = binding ? resolveModule(state, target.file, binding.moduleSpecifier) : null;
  return binding && resolved
    ? exportedMemoizedComponent(state, {
        depth: target.depth + 1,
        exportName: binding.importedName,
        file: resolved,
      })
    : null;
}

function reexportedMemoizedComponent(
  state: SourceIndexState,
  record: ModuleRecord,
  target: ExportTarget,
): MemoizedComponent | null {
  const reexport = record.reexports.get(target.exportName);
  if (!reexport) {
    return starExportedMemoizedComponent(state, record, target);
  }
  const resolved = resolveModule(state, target.file, reexport.moduleSpecifier);
  return resolved
    ? exportedMemoizedComponent(state, {
        depth: target.depth + 1,
        exportName: reexport.importedName,
        file: resolved,
      })
    : null;
}

/** A name several star exports provide is ambiguous, so only a single provider resolves. */
function starExportedMemoizedComponent(
  state: SourceIndexState,
  record: ModuleRecord,
  target: ExportTarget,
): MemoizedComponent | null {
  const matches = record.starExports.flatMap((specifier) => {
    const resolved = resolveModule(state, target.file, specifier);
    const match = resolved
      ? exportedMemoizedComponent(state, { ...target, depth: target.depth + 1, file: resolved })
      : null;
    return match ? [match] : [];
  });
  const [only, ...others] = matches;
  return only && others.length === 0 ? only : null;
}

function memoizedModule(sourceFile: ts.SourceFile): MemoizedModule {
  const cached = memoizedModules.get(sourceFile);
  if (cached) {
    return cached;
  }
  const collection: MemoizedCollection = {
    exports: new Map(),
    file: sourceFile.fileName,
    locals: new Map(),
  };
  for (const statement of sourceFile.statements) {
    collectMemoizedStatement(statement, collection);
  }
  for (const statement of sourceFile.statements) {
    collectNamedExports(statement, collection);
  }
  memoizedModules.set(sourceFile, collection);
  return collection;
}

interface MemoizedCollection {
  readonly exports: Map<string, MemoizedComponent>;
  readonly file: string;
  readonly locals: Map<string, MemoizedComponent>;
}

function collectMemoizedStatement(statement: ts.Statement, collection: MemoizedCollection): void {
  if (ts.isVariableStatement(statement)) {
    collectMemoizedVariables(statement, collection);
  } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
    collectDefaultExport(statement.expression, collection);
  }
}

function collectMemoizedVariables(
  statement: ts.VariableStatement,
  collection: MemoizedCollection,
): void {
  if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
    return;
  }
  for (const declaration of statement.declarationList.declarations) {
    collectMemoizedDeclaration(declaration, hasExport(statement), collection);
  }
}

function collectMemoizedDeclaration(
  declaration: ts.VariableDeclaration,
  exported: boolean,
  collection: MemoizedCollection,
): void {
  const wrapped = declaration.initializer ? memoizingWrap(declaration.initializer) : null;
  if (!wrapped || !ts.isIdentifier(declaration.name)) {
    return;
  }
  const name = declaration.name.text;
  const component = { ...wrapped, file: collection.file, name };
  collection.locals.set(name, component);
  if (exported) {
    collection.exports.set(name, component);
  }
}

function collectDefaultExport(expression: ts.Expression, collection: MemoizedCollection): void {
  const value = unwrapTransparentExpression(expression);
  const wrapped = memoizingWrap(value);
  if (wrapped) {
    collection.exports.set("default", { ...wrapped, file: collection.file, name: "default" });
    return;
  }
  const local = ts.isIdentifier(value) ? collection.locals.get(value.text) : undefined;
  if (local) {
    collection.exports.set("default", local);
  }
}

function collectNamedExports(statement: ts.Statement, collection: MemoizedCollection): void {
  if (
    !ts.isExportDeclaration(statement) ||
    statement.moduleSpecifier ||
    statement.isTypeOnly ||
    !statement.exportClause ||
    !ts.isNamedExports(statement.exportClause)
  ) {
    return;
  }
  for (const element of statement.exportClause.elements) {
    const local = collection.locals.get((element.propertyName ?? element.name).text);
    if (local && !element.isTypeOnly) {
      collection.exports.set(element.name.text, local);
    }
  }
}

/** The memoizing layers of `memo(...)`, `observer(...)`, and their `forwardRef` compositions. */
function memoizingWrap(
  expression: ts.Expression,
): Pick<MemoizedComponent, "comparator" | "wrapper"> | null {
  const layers = wrapperLayers(unwrapTransparentExpression(expression));
  const memoizing = layers?.find(
    (layer): layer is WrapperLayer & { readonly wrapper: MemoizingWrapper } =>
      layer.wrapper !== "forwardRef",
  );
  return layers && memoizing
    ? { comparator: layers.some((layer) => layer.comparator), wrapper: memoizing.wrapper }
    : null;
}

/** Wrapper calls from the outside in, or null when the innermost value is not a component. */
function wrapperLayers(expression: ts.Expression): readonly WrapperLayer[] | null {
  if (!ts.isCallExpression(expression)) {
    return isComponentValue(expression) ? [] : null;
  }
  const wrapper = componentWrapper(expression.expression);
  const [component, ...options] = expression.arguments;
  if (!wrapper || !component) {
    return null;
  }
  const inner = wrapperLayers(unwrapTransparentExpression(component));
  return inner && [{ comparator: wrapper === "memo" && options.length > 0, wrapper }, ...inner];
}

function isComponentValue(expression: ts.Expression): boolean {
  return (
    ts.isArrowFunction(expression) ||
    ts.isFunctionExpression(expression) ||
    ts.isIdentifier(expression)
  );
}

function componentWrapper(callee: ts.Expression): ComponentWrapper | null {
  const expression = unwrapTransparentExpression(callee);
  if (ts.isIdentifier(expression)) {
    const binding = lexicalBinding(expression);
    return binding?.kind === "import"
      ? (WRAPPER_IMPORTS.find(
          (candidate) =>
            candidate.moduleSpecifier === binding.moduleSpecifier &&
            candidate.importedName === binding.importedName,
        )?.wrapper ?? null)
      : null;
  }
  if (!ts.isPropertyAccessExpression(expression) || !ts.isIdentifier(expression.expression)) {
    return null;
  }
  const namespace = lexicalBinding(expression.expression);
  const isNamespace =
    namespace?.kind === "import" &&
    (namespace.importedName === "*" || namespace.importedName === "default");
  return isNamespace
    ? (NAMESPACE_WRAPPERS.get(namespace.moduleSpecifier)?.get(expression.name.text) ?? null)
    : null;
}
