import type { AnalysisContext } from "./analysis-context.js";
import type { AnalysisFile } from "../analysis-project.js";
import { pathIdentityKey } from "../../core/path-identity.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

export interface ImportedBinding {
  readonly file: AnalysisFile;
  readonly importedName: string;
  readonly localName: string;
  readonly target: string;
}

export interface ModuleLoad {
  readonly file: AnalysisFile;
  readonly target: string;
}

export interface ComputedLoad {
  readonly file: AnalysisFile;
  readonly specifier: ts.Expression | undefined;
}

export interface UnresolvedImport {
  readonly defaultImport: boolean;
  readonly file: AnalysisFile;
  readonly importedNames: ReadonlySet<string>;
  readonly specifier: string;
}

export interface ClosureIndex {
  readonly bindings: ImportedBinding[];
  readonly computedLoads: ComputedLoad[];
  /** Files that fail to parse; their imports never reach the source index. */
  readonly erroredFiles: AnalysisFile[];
  /** Namespace imports, `export * as`, and literal `import()`, `require()`, or module mocks. */
  readonly opaqueLoads: ModuleLoad[];
  readonly publishedByManifest: Map<string, boolean>;
  readonly reexporters: Map<string, Set<string>>;
  readonly unresolvedImports: UnresolvedImport[];
}

// Context identity owns the snapshot: a new scan never reuses old files, resolutions, or manifests.
const indexByContext = new WeakMap<AnalysisContext, ClosureIndex>();

export function closureIndex(context: AnalysisContext): ClosureIndex {
  const cached = indexByContext.get(context);
  if (cached) {
    return cached;
  }
  const index = buildClosureIndex(context);
  indexByContext.set(context, index);
  return index;
}

function buildClosureIndex(context: AnalysisContext): ClosureIndex {
  return indexFiles(context, context.project.files);
}

export function indexFiles(context: AnalysisContext, files: readonly AnalysisFile[]): ClosureIndex {
  const index: ClosureIndex = {
    bindings: [],
    computedLoads: [],
    erroredFiles: [],
    opaqueLoads: [],
    publishedByManifest: new Map(),
    reexporters: new Map(),
    unresolvedImports: [],
  };
  for (const file of files) {
    indexFile(context, index, file);
  }
  return index;
}

function indexFile(context: AnalysisContext, index: ClosureIndex, file: AnalysisFile): void {
  if (file.parserDiagnostics.some((diagnostic) => diagnostic.category === "error")) {
    index.erroredFiles.push(file);
    return;
  }
  const firstBinding = index.bindings.length;
  for (const statement of file.sourceFile.statements) {
    indexModuleStatement(context, index, { file, statement });
  }
  indexLocalReexports(index, file, index.bindings.slice(firstBinding));
  indexRuntimeLoads(context, index, file);
}

function indexModuleStatement(
  context: AnalysisContext,
  index: ClosureIndex,
  { file, statement }: { file: AnalysisFile; statement: ts.Statement },
): void {
  if (
    (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) ||
    !statement.moduleSpecifier ||
    !ts.isStringLiteral(statement.moduleSpecifier)
  ) {
    return;
  }
  const specifier = statement.moduleSpecifier.text;
  const target = context.sourceIndex.moduleFileFor(file.originalPath, specifier);
  if (ts.isExportDeclaration(statement)) {
    indexReexport(index, { file, specifier, statement, target });
  } else if (statement.importClause && !statement.importClause.isTypeOnly) {
    indexImport(index, { clause: statement.importClause, file, specifier, target });
  }
}

function indexImport(
  index: ClosureIndex,
  {
    clause,
    file,
    specifier,
    target,
  }: { clause: ts.ImportClause; file: AnalysisFile; specifier: string; target: string | null },
): void {
  if (target === null) {
    index.unresolvedImports.push(unresolvedImport(file, clause, specifier));
    return;
  }
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
    index.opaqueLoads.push({ file, target });
  }
  for (const [localName, importedName] of importBindingNames(clause)) {
    index.bindings.push({ file, importedName, localName, target });
  }
}

/** `export default imported` and `export { imported }` expose an imported binding like `export from`. */
function indexLocalReexports(
  index: ClosureIndex,
  file: AnalysisFile,
  bindings: readonly ImportedBinding[],
): void {
  const targets = new Map(bindings.map((binding) => [binding.localName, binding.target]));
  for (const name of locallyExportedNames(file.sourceFile)) {
    const target = targets.get(name);
    if (target !== undefined) {
      addReexporter(index, target, file);
    }
  }
}

function locallyExportedNames(sourceFile: ts.SourceFile): string[] {
  return sourceFile.statements.flatMap((statement) => {
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      return [statement.expression.text];
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      !statement.isTypeOnly &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      return statement.exportClause.elements.map(
        (element) => (element.propertyName ?? element.name).text,
      );
    }
    return [];
  });
}

function addReexporter(index: ClosureIndex, target: string, file: AnalysisFile): void {
  const reexporters = index.reexporters.get(target) ?? new Set<string>();
  reexporters.add(pathIdentityKey(file.identityPath));
  index.reexporters.set(target, reexporters);
}

function indexReexport(
  index: ClosureIndex,
  {
    file,
    specifier,
    statement,
    target,
  }: {
    file: AnalysisFile;
    specifier: string;
    statement: ts.ExportDeclaration;
    target: string | null;
  },
): void {
  if (statement.isTypeOnly) {
    return;
  }
  if (target === null) {
    index.unresolvedImports.push(unresolvedReexport(file, statement, specifier));
    return;
  }
  if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
    index.opaqueLoads.push({ file, target });
    return;
  }
  addReexporter(index, target, file);
}

function unresolvedImport(
  file: AnalysisFile,
  clause: ts.ImportClause,
  specifier: string,
): UnresolvedImport {
  return {
    defaultImport: clause.name !== undefined,
    file,
    importedNames: new Set(importBindingNames(clause).map(([, importedName]) => importedName)),
    specifier,
  };
}

function unresolvedReexport(
  file: AnalysisFile,
  statement: ts.ExportDeclaration,
  specifier: string,
): UnresolvedImport {
  const clause = statement.exportClause;
  const importedNames = new Set<string>();
  if (clause && ts.isNamedExports(clause)) {
    for (const element of clause.elements) {
      importedNames.add((element.propertyName ?? element.name).text);
    }
  }
  return { defaultImport: clause === undefined, file, importedNames, specifier };
}

function importBindingNames(clause: ts.ImportClause): (readonly [string, string])[] {
  const names: (readonly [string, string])[] = clause.name ? [[clause.name.text, "default"]] : [];
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    for (const element of clause.namedBindings.elements) {
      if (!element.isTypeOnly) {
        names.push([element.name.text, (element.propertyName ?? element.name).text]);
      }
    }
  }
  return names;
}

function indexRuntimeLoads(
  context: AnalysisContext,
  index: ClosureIndex,
  file: AnalysisFile,
): void {
  visit(file.sourceFile, (node) => {
    if (ts.isCallExpression(node)) {
      indexRuntimeLoad(context, index, { call: node, file });
    }
  });
}

function indexRuntimeLoad(
  context: AnalysisContext,
  index: ClosureIndex,
  { call, file }: { call: ts.CallExpression; file: AnalysisFile },
): void {
  const load = runtimeModuleLoad(call);
  const [specifier] = call.arguments;
  const text = specifier ? constantString(specifier) : null;
  if (load !== "none" && text !== null) {
    const target = context.sourceIndex.moduleFileFor(file.originalPath, text);
    if (target !== null) {
      index.opaqueLoads.push({ file, target });
    }
  } else if (load === "loader") {
    index.computedLoads.push({ file, specifier });
  }
}

/** Folds string literals, their concatenation, and `[...literals].join(literal?)` into one string. */
function constantString(expression: ts.Expression): string | null {
  if (ts.isStringLiteralLike(expression)) {
    return expression.text;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return constantString(expression.expression);
  }
  if (ts.isBinaryExpression(expression)) {
    const left = constantString(expression.left);
    const right = constantString(expression.right);
    return expression.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      left !== null &&
      right !== null
      ? left + right
      : null;
  }
  return ts.isCallExpression(expression) ? constantJoin(expression) : null;
}

function constantJoin(call: ts.CallExpression): string | null {
  const callee = call.expression;
  const [separator, ...rest] = call.arguments;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    callee.name.text !== "join" ||
    !ts.isArrayLiteralExpression(callee.expression) ||
    rest.length > 0
  ) {
    return null;
  }
  const glue = separator === undefined ? "," : constantString(separator);
  const parts = callee.expression.elements.map((element) => constantString(element));
  return glue !== null && parts.every((part) => part !== null) ? parts.join(glue) : null;
}

const MODULE_MOCK_METHODS: ReadonlySet<string> = new Set([
  "createMockFromModule",
  "doMock",
  "importActual",
  "importMock",
  "mock",
  "requireActual",
  "requireMock",
  "setMock",
  "unstable_mockModule",
]);
const MODULE_MOCK_RECEIVERS: ReadonlySet<string> = new Set(["jest", "vi"]);

/**
 * `import()`, `require()`, and the Jest or Vitest module registry load any specifier they are
 * given; a mock-named method on another receiver loads a module only when passed a literal path.
 */
function runtimeModuleLoad(call: ts.CallExpression): "loader" | "literal-only" | "none" {
  const callee = call.expression;
  if (
    callee.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(callee) && callee.text === "require")
  ) {
    return "loader";
  }
  if (!ts.isPropertyAccessExpression(callee) || !MODULE_MOCK_METHODS.has(callee.name.text)) {
    return "none";
  }
  return ts.isIdentifier(callee.expression) && MODULE_MOCK_RECEIVERS.has(callee.expression.text)
    ? "loader"
    : "literal-only";
}

/** A package that is not private and declares an entry point can be imported by unseen code. */
export function isPublishedManifest(index: ClosureIndex, manifest: string): boolean {
  const cached = index.publishedByManifest.get(manifest);
  if (cached !== undefined) {
    return cached;
  }
  const published = manifestIsPublished(ts.sys.readFile(manifest));
  index.publishedByManifest.set(manifest, published);
  return published;
}

function manifestIsPublished(text: string | undefined): boolean {
  const fields = text === undefined ? null : parseJsonObject(text);
  return (
    fields === null ||
    (fields.get("private") !== true &&
      ["exports", "main", "module"].some((field) => fields.get(field) !== undefined))
  );
}

function parseJsonObject(text: string): ReadonlyMap<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed instanceof Object ? new Map(Object.entries(parsed)) : null;
  } catch {
    return null;
  }
}
