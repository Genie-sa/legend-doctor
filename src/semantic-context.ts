import type { AnalysisFile, AnalysisProject } from "./analysis-project.js";
import { canonicalPath, pathIdentityKey } from "./path-identity.js";
import path from "node:path";
import ts from "typescript";

export type SemanticContextDiagnosticCode =
  | "config-read-failed"
  | "config-invalid"
  | "file-not-in-config"
  | "source-file-identity-mismatch";

export interface SemanticContextDiagnostic {
  readonly category: "error";
  readonly code: SemanticContextDiagnosticCode;
  readonly column?: number;
  readonly fileName?: string;
  readonly line?: number;
  readonly message: string;
  readonly typescriptCode?: number;
}

export interface ImportProvenance {
  readonly accessPath: readonly string[];
  readonly declaration: ts.ImportDeclaration | ts.ImportEqualsDeclaration;
  readonly importedName: string;
  readonly isTypeOnly: boolean;
  readonly kind: "default" | "named" | "namespace" | "import-equals";
  readonly localName: string;
  readonly moduleSpecifier: string;
}

export interface CreateSemanticContextOptions {
  /** An explicitly selected or previously discovered tsconfig path. */
  readonly configFilePath: string;
}

export interface SemanticContextResult {
  readonly context: SemanticContext | null;
  readonly diagnostics: readonly SemanticContextDiagnostic[];
}

/**
 * A read-only semantic view whose checker and nodes are owned by the same Program.
 * The Program is intentionally private so callers cannot pair its checker with another AST.
 */
export interface SemanticContext {
  readonly getCanonicalSymbol: (node: ts.Node) => ts.Symbol | undefined;
  readonly getDeclarations: (symbol: ts.Symbol) => readonly ts.Declaration[];
  readonly getImportProvenance: (node: ts.Node) => ImportProvenance | undefined;
  readonly getSourceFile: (file: AnalysisFile) => ts.SourceFile | undefined;
  readonly getSymbol: (node: ts.Node) => ts.Symbol | undefined;
  readonly getType: (node: ts.Node) => ts.Type | undefined;
  readonly getTypeText: (node: ts.Node) => string | undefined;
}

class ProgramSemanticContext implements SemanticContext {
  readonly #checker: ts.TypeChecker;
  readonly #program: ts.Program;

  public constructor(program: ts.Program) {
    this.#program = program;
    this.#checker = program.getTypeChecker();
  }

  public getSourceFile(file: AnalysisFile): ts.SourceFile | undefined {
    const sourceFile = this.#program.getSourceFile(file.identityPath);
    return sourceFile === file.sourceFile ? sourceFile : undefined;
  }

  public getSymbol(node: ts.Node): ts.Symbol | undefined {
    return this.#ownsNode(node) ? this.#checker.getSymbolAtLocation(node) : undefined;
  }

  public getCanonicalSymbol(node: ts.Node): ts.Symbol | undefined {
    const symbol = this.getSymbol(node);
    if (!symbol) {
      return undefined;
    }
    return symbol.flags & ts.SymbolFlags.Alias ? this.#checker.getAliasedSymbol(symbol) : symbol;
  }

  public getDeclarations(symbol: ts.Symbol): readonly ts.Declaration[] {
    const declarations = symbol.declarations ?? [];
    return declarations.every((declaration) => this.#ownsNode(declaration))
      ? [...declarations]
      : [];
  }

  public getType(node: ts.Node): ts.Type | undefined {
    return this.#ownsNode(node) ? this.#checker.getTypeAtLocation(node) : undefined;
  }

  public getTypeText(node: ts.Node): string | undefined {
    if (!this.#ownsNode(node)) {
      return undefined;
    }
    const type = this.#checker.getTypeAtLocation(node);
    return this.#checker.typeToString(type, node, ts.TypeFormatFlags.NoTruncation);
  }

  public getImportProvenance(node: ts.Node): ImportProvenance | undefined {
    if (!this.#ownsNode(node)) {
      return undefined;
    }
    const direct = this.#checker.getSymbolAtLocation(node);
    return (direct && importProvenanceOfSymbol(direct)) ?? this.#namespaceMemberProvenance(node);
  }

  #namespaceMemberProvenance(node: ts.Node): ImportProvenance | undefined {
    const access = staticAccessFromNamespace(node);
    if (!access) {
      return undefined;
    }
    const namespaceSymbol = this.#checker.getSymbolAtLocation(access.root);
    const namespaceProvenance = namespaceSymbol && importProvenanceOfSymbol(namespaceSymbol);
    if (namespaceProvenance?.kind !== "namespace") {
      return undefined;
    }
    return {
      ...namespaceProvenance,
      accessPath: access.path,
    };
  }

  #ownsNode(node: ts.Node): boolean {
    const sourceFile = node.getSourceFile();
    return this.#program.getSourceFile(sourceFile.fileName) === sourceFile;
  }
}

export function createSemanticContext(
  project: AnalysisProject,
  options: CreateSemanticContextOptions,
): SemanticContextResult {
  const configFilePath = path.resolve(options.configFilePath);
  const readResult = ts.readConfigFile(configFilePath, ts.sys.readFile);
  if (readResult.error) {
    return unavailable(normalizeTypeScriptDiagnostic("config-read-failed", readResult.error));
  }

  const parsedConfig = ts.parseJsonConfigFileContent(
    readResult.config,
    ts.sys,
    path.dirname(configFilePath),
    undefined,
    configFilePath,
  );
  if (parsedConfig.errors.length > 0) {
    return {
      context: null,
      diagnostics: parsedConfig.errors.map((diagnostic) =>
        normalizeTypeScriptDiagnostic("config-invalid", diagnostic),
      ),
    };
  }

  const program = createIdentityPreservingProgram(parsedConfig, project.files);
  return (
    identityFailure(program, project.files) ?? {
      context: new ProgramSemanticContext(program),
      diagnostics: [],
    }
  );
}

function createIdentityPreservingProgram(
  parsedConfig: ts.ParsedCommandLine,
  files: readonly AnalysisFile[],
): ts.Program {
  const programOptions: ts.CreateProgramOptions = {
    configFileParsingDiagnostics: parsedConfig.errors,
    host: createIdentityPreservingHost(parsedConfig.options, files),
    options: parsedConfig.options,
    rootNames: uniqueCanonicalPaths(parsedConfig.fileNames),
  };
  if (parsedConfig.projectReferences) {
    return ts.createProgram({
      ...programOptions,
      projectReferences: parsedConfig.projectReferences,
    });
  }
  return ts.createProgram(programOptions);
}

/** Reports the first way the Program failed to adopt the cached analysis files, if any. */
function identityFailure(
  program: ts.Program,
  files: readonly AnalysisFile[],
): SemanticContextResult | null {
  const unconfiguredFiles = files.filter((file) => !program.getSourceFile(file.identityPath));
  if (unconfiguredFiles.length > 0) {
    return fileDiagnostics(
      unconfiguredFiles,
      "file-not-in-config",
      "The analysis file is not owned by the selected tsconfig. Create one semantic context per tsconfig shard.",
    );
  }
  const mismatches = files.filter(
    (file) => program.getSourceFile(file.identityPath) !== file.sourceFile,
  );
  if (mismatches.length > 0) {
    return fileDiagnostics(
      mismatches,
      "source-file-identity-mismatch",
      "The semantic Program did not retain the cached SourceFile for this analysis file.",
    );
  }
  return null;
}

function fileDiagnostics(
  files: readonly AnalysisFile[],
  code: SemanticContextDiagnosticCode,
  message: string,
): SemanticContextResult {
  return {
    context: null,
    diagnostics: files.map((file) => ({
      category: "error",
      code,
      fileName: file.originalPath,
      message,
    })),
  };
}

function createIdentityPreservingHost(
  options: ts.CompilerOptions,
  files: readonly AnalysisFile[],
): ts.CompilerHost {
  const host = ts.createCompilerHost(options, true);
  const filesByPath = new Map(files.map((file) => [pathIdentityKey(file.identityPath), file]));
  const defaultGetSourceFile = host.getSourceFile.bind(host);

  host.fileExists = (fileName): boolean =>
    filesByPath.has(pathIdentityKey(fileName)) || ts.sys.fileExists(fileName);
  host.readFile = (fileName): string | undefined =>
    filesByPath.get(pathIdentityKey(fileName))?.sourceFile.text ?? ts.sys.readFile(fileName);
  host.getSourceFile = (fileName, ...rest): ts.SourceFile | undefined =>
    filesByPath.get(pathIdentityKey(fileName))?.sourceFile ??
    defaultGetSourceFile(fileName, ...rest);
  host.getSourceFileByPath = (fileName, _path, ...rest): ts.SourceFile | undefined =>
    filesByPath.get(pathIdentityKey(fileName))?.sourceFile ??
    defaultGetSourceFile(fileName, ...rest);
  return host;
}

function importProvenanceOfSymbol(symbol: ts.Symbol): ImportProvenance | undefined {
  for (const declaration of symbol.declarations ?? []) {
    const provenance = importProvenanceOfDeclaration(declaration);
    if (provenance) {
      return provenance;
    }
  }
  return undefined;
}

/**
 * The local half of an import binding, before the owning statement is confirmed to be a real
 * `import` declaration rather than a JSDoc `@import` tag.
 */
interface ImportBinding {
  readonly importedName: string;
  readonly isTypeOnly: boolean;
  readonly kind: "default" | "named" | "namespace";
  readonly localName: string;
  readonly owner: ts.Node;
}

function importProvenanceOfDeclaration(declaration: ts.Declaration): ImportProvenance | undefined {
  if (ts.isImportEqualsDeclaration(declaration)) {
    return importEqualsProvenance(declaration);
  }
  const binding = importBindingOfDeclaration(declaration);
  if (!binding || !ts.isImportDeclaration(binding.owner)) {
    return undefined;
  }
  const moduleSpecifier = stringModuleSpecifier(binding.owner.moduleSpecifier);
  if (!moduleSpecifier) {
    return undefined;
  }
  const { importedName, isTypeOnly, kind, localName } = binding;
  return {
    accessPath: [],
    declaration: binding.owner,
    importedName,
    isTypeOnly,
    kind,
    localName,
    moduleSpecifier,
  };
}

function importBindingOfDeclaration(declaration: ts.Declaration): ImportBinding | undefined {
  if (ts.isImportSpecifier(declaration)) {
    return {
      importedName: declaration.propertyName?.text ?? declaration.name.text,
      isTypeOnly: declaration.isTypeOnly || declaration.parent.parent.isTypeOnly,
      kind: "named",
      localName: declaration.name.text,
      owner: declaration.parent.parent.parent,
    };
  }
  if (ts.isNamespaceImport(declaration)) {
    return {
      importedName: "*",
      isTypeOnly: declaration.parent.isTypeOnly,
      kind: "namespace",
      localName: declaration.name.text,
      owner: declaration.parent.parent,
    };
  }
  if (ts.isImportClause(declaration) && declaration.name) {
    return {
      importedName: "default",
      isTypeOnly: declaration.isTypeOnly,
      kind: "default",
      localName: declaration.name.text,
      owner: declaration.parent,
    };
  }
  return undefined;
}

function importEqualsProvenance(
  declaration: ts.ImportEqualsDeclaration,
): ImportProvenance | undefined {
  const { moduleReference } = declaration;
  if (
    !ts.isExternalModuleReference(moduleReference) ||
    !ts.isStringLiteralLike(moduleReference.expression)
  ) {
    return undefined;
  }
  return {
    accessPath: [],
    declaration,
    importedName: "export=",
    isTypeOnly: declaration.isTypeOnly,
    kind: "import-equals",
    localName: declaration.name.text,
    moduleSpecifier: moduleReference.expression.text,
  };
}

function staticAccessFromNamespace(
  node: ts.Node,
): { readonly path: readonly string[]; readonly root: ts.Identifier } | undefined {
  const access = enclosingPropertyAccess(node);
  if (!access) {
    return undefined;
  }
  const accessPath: string[] = [];
  let root: ts.Expression = access;
  while (ts.isPropertyAccessExpression(root)) {
    accessPath.unshift(root.name.text);
    root = root.expression;
  }
  return ts.isIdentifier(root) && accessPath.length > 0 ? { path: accessPath, root } : undefined;
}

function enclosingPropertyAccess(node: ts.Node): ts.PropertyAccessExpression | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return node;
  }
  return ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent)
    ? node.parent
    : undefined;
}

function stringModuleSpecifier(node: ts.Expression): string | undefined {
  return ts.isStringLiteralLike(node) ? node.text : undefined;
}

function uniqueCanonicalPaths(fileNames: readonly string[]): string[] {
  const byCanonicalPath = new Map<string, string>();
  for (const fileName of fileNames) {
    byCanonicalPath.set(pathIdentityKey(fileName), canonicalPath(fileName));
  }
  return [...byCanonicalPath.values()];
}

function unavailable(diagnostic: SemanticContextDiagnostic): SemanticContextResult {
  return { context: null, diagnostics: [diagnostic] };
}

/** {@link SemanticContextDiagnostic} while it is still being assembled field by field. */
type DiagnosticDraft = {
  -readonly [Key in keyof SemanticContextDiagnostic]: SemanticContextDiagnostic[Key];
};

function normalizeTypeScriptDiagnostic(
  code: SemanticContextDiagnosticCode,
  diagnostic: ts.Diagnostic,
): SemanticContextDiagnostic {
  const normalized: DiagnosticDraft = {
    category: "error",
    code,
    message:
      code === "config-read-failed"
        ? "Unable to read the selected tsconfig."
        : ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    typescriptCode: diagnostic.code,
  };
  if (diagnostic.file) {
    normalized.fileName = diagnostic.file.fileName;
  }
  const location =
    diagnostic.file && diagnostic.start !== undefined
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      : undefined;
  if (location) {
    normalized.column = location.character + 1;
    normalized.line = location.line + 1;
  }
  return normalized;
}
