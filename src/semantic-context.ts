import path from "node:path";

import ts from "typescript";

import type { AnalysisFile, AnalysisProject } from "./analysis-project.js";
import { canonicalPath, pathIdentityKey } from "./path-identity.js";

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
  getCanonicalSymbol(node: ts.Node): ts.Symbol | undefined;
  getDeclarations(symbol: ts.Symbol): readonly ts.Declaration[];
  getImportProvenance(node: ts.Node): ImportProvenance | undefined;
  getSourceFile(file: AnalysisFile): ts.SourceFile | undefined;
  getSymbol(node: ts.Node): ts.Symbol | undefined;
  getType(node: ts.Node): ts.Type | undefined;
  getTypeText(node: ts.Node): string | undefined;
}

class ProgramSemanticContext implements SemanticContext {
  readonly #checker: ts.TypeChecker;
  readonly #program: ts.Program;

  constructor(program: ts.Program) {
    this.#program = program;
    this.#checker = program.getTypeChecker();
  }

  getSourceFile(file: AnalysisFile): ts.SourceFile | undefined {
    const sourceFile = this.#program.getSourceFile(file.identityPath);
    return sourceFile === file.sourceFile ? sourceFile : undefined;
  }

  getSymbol(node: ts.Node): ts.Symbol | undefined {
    return this.#ownsNode(node) ? this.#checker.getSymbolAtLocation(node) : undefined;
  }

  getCanonicalSymbol(node: ts.Node): ts.Symbol | undefined {
    const symbol = this.getSymbol(node);
    if (!symbol) {
      return undefined;
    }
    return symbol.flags & ts.SymbolFlags.Alias
      ? this.#checker.getAliasedSymbol(symbol)
      : symbol;
  }

  getDeclarations(symbol: ts.Symbol): readonly ts.Declaration[] {
    const declarations = symbol.declarations ?? [];
    return declarations.every(declaration => this.#ownsNode(declaration))
      ? [...declarations]
      : [];
  }

  getType(node: ts.Node): ts.Type | undefined {
    return this.#ownsNode(node) ? this.#checker.getTypeAtLocation(node) : undefined;
  }

  getTypeText(node: ts.Node): string | undefined {
    if (!this.#ownsNode(node)) {
      return undefined;
    }
    const type = this.#checker.getTypeAtLocation(node);
    return this.#checker.typeToString(type, node, ts.TypeFormatFlags.NoTruncation);
  }

  getImportProvenance(node: ts.Node): ImportProvenance | undefined {
    if (!this.#ownsNode(node)) {
      return undefined;
    }

    const direct = this.#checker.getSymbolAtLocation(node);
    const directProvenance = direct && importProvenanceOfSymbol(direct);
    if (directProvenance) {
      return directProvenance;
    }

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
  options: CreateSemanticContextOptions
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
    configFilePath
  );
  if (parsedConfig.errors.length > 0) {
    return {
      context: null,
      diagnostics: parsedConfig.errors.map(diagnostic =>
        normalizeTypeScriptDiagnostic("config-invalid", diagnostic)
      ),
    };
  }

  const configuredFiles = new Set(parsedConfig.fileNames.map(pathIdentityKey));
  const unconfiguredFiles = project.files.filter(
    file => !configuredFiles.has(pathIdentityKey(file.identityPath))
  );
  if (unconfiguredFiles.length > 0) {
    return {
      context: null,
      diagnostics: unconfiguredFiles.map(file => ({
        category: "error",
        code: "file-not-in-config",
        fileName: file.originalPath,
        message: "The analysis file is not owned by the selected tsconfig. Create one semantic context per tsconfig shard.",
      })),
    };
  }

  const host = createIdentityPreservingHost(parsedConfig.options, project.files);
  const rootNames = uniqueCanonicalPaths(parsedConfig.fileNames);
  const program = ts.createProgram({
    configFileParsingDiagnostics: parsedConfig.errors,
    host,
    options: parsedConfig.options,
    rootNames,
    ...(parsedConfig.projectReferences
      ? { projectReferences: parsedConfig.projectReferences }
      : {}),
  });

  const mismatches = project.files.filter(
    file => program.getSourceFile(file.identityPath) !== file.sourceFile
  );
  if (mismatches.length > 0) {
    return {
      context: null,
      diagnostics: mismatches.map(file => ({
        category: "error",
      code: "source-file-identity-mismatch",
      fileName: file.originalPath,
      message: "The semantic Program did not retain the cached SourceFile for this analysis file.",
      })),
    };
  }

  return { context: new ProgramSemanticContext(program), diagnostics: [] };
}

function createIdentityPreservingHost(
  options: ts.CompilerOptions,
  files: readonly AnalysisFile[]
): ts.CompilerHost {
  const host = ts.createCompilerHost(options, true);
  const filesByPath = new Map(files.map(file => [pathIdentityKey(file.identityPath), file]));
  const defaultGetSourceFile = host.getSourceFile.bind(host);

  host.fileExists = fileName =>
    filesByPath.has(pathIdentityKey(fileName)) || ts.sys.fileExists(fileName);
  host.readFile = fileName =>
    filesByPath.get(pathIdentityKey(fileName))?.sourceFile.text ?? ts.sys.readFile(fileName);
  host.getSourceFile = (
    fileName,
    languageVersionOrOptions,
    onError,
    shouldCreateNewSourceFile
  ) =>
    filesByPath.get(pathIdentityKey(fileName))?.sourceFile ??
    defaultGetSourceFile(
      fileName,
      languageVersionOrOptions,
      onError,
      shouldCreateNewSourceFile
    );
  host.getSourceFileByPath = (
    fileName,
    _path,
    languageVersionOrOptions,
    onError,
    shouldCreateNewSourceFile
  ) =>
    filesByPath.get(pathIdentityKey(fileName))?.sourceFile ??
    defaultGetSourceFile(
      fileName,
      languageVersionOrOptions,
      onError,
      shouldCreateNewSourceFile
    );
  return host;
}

function importProvenanceOfSymbol(symbol: ts.Symbol): ImportProvenance | undefined {
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isImportSpecifier(declaration)) {
      const importDeclaration = declaration.parent.parent.parent;
      if (!ts.isImportDeclaration(importDeclaration)) {
        continue;
      }
      const moduleSpecifier = stringModuleSpecifier(importDeclaration.moduleSpecifier);
      if (!moduleSpecifier) {
        continue;
      }
      return {
        accessPath: [],
        declaration: importDeclaration,
        importedName: declaration.propertyName?.text ?? declaration.name.text,
        isTypeOnly: declaration.isTypeOnly || declaration.parent.parent.isTypeOnly,
        kind: "named",
        localName: declaration.name.text,
        moduleSpecifier,
      };
    }

    if (ts.isNamespaceImport(declaration)) {
      const importDeclaration = declaration.parent.parent;
      if (!ts.isImportDeclaration(importDeclaration)) {
        continue;
      }
      const moduleSpecifier = stringModuleSpecifier(importDeclaration.moduleSpecifier);
      if (!moduleSpecifier) {
        continue;
      }
      return {
        accessPath: [],
        declaration: importDeclaration,
        importedName: "*",
        isTypeOnly: declaration.parent.isTypeOnly,
        kind: "namespace",
        localName: declaration.name.text,
        moduleSpecifier,
      };
    }

    if (ts.isImportClause(declaration) && declaration.name) {
      const importDeclaration = declaration.parent;
      if (!ts.isImportDeclaration(importDeclaration)) {
        continue;
      }
      const moduleSpecifier = stringModuleSpecifier(importDeclaration.moduleSpecifier);
      if (!moduleSpecifier) {
        continue;
      }
      return {
        accessPath: [],
        declaration: importDeclaration,
        importedName: "default",
        isTypeOnly: declaration.isTypeOnly,
        kind: "default",
        localName: declaration.name.text,
        moduleSpecifier,
      };
    }

    if (
      ts.isImportEqualsDeclaration(declaration) &&
      ts.isExternalModuleReference(declaration.moduleReference) &&
      declaration.moduleReference.expression &&
      ts.isStringLiteralLike(declaration.moduleReference.expression)
    ) {
      return {
        accessPath: [],
        declaration,
        importedName: "export=",
        isTypeOnly: declaration.isTypeOnly,
        kind: "import-equals",
        localName: declaration.name.text,
        moduleSpecifier: declaration.moduleReference.expression.text,
      };
    }
  }
  return undefined;
}

function staticAccessFromNamespace(
  node: ts.Node
): { readonly path: readonly string[]; readonly root: ts.Identifier } | undefined {
  let expression: ts.Expression | undefined;
  if (ts.isPropertyAccessExpression(node)) {
    expression = node;
  } else if (ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent)) {
    expression = node.parent;
  }
  if (!expression) {
    return undefined;
  }

  const accessPath: string[] = [];
  while (ts.isPropertyAccessExpression(expression)) {
    accessPath.unshift(expression.name.text);
    expression = expression.expression;
  }
  return ts.isIdentifier(expression) && accessPath.length > 0
    ? { path: accessPath, root: expression }
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

function normalizeTypeScriptDiagnostic(
  code: SemanticContextDiagnosticCode,
  diagnostic: ts.Diagnostic
): SemanticContextDiagnostic {
  const location =
    diagnostic.file && diagnostic.start !== undefined
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      : undefined;
  return {
    category: "error",
    code,
    message: code === "config-read-failed"
      ? "Unable to read the selected tsconfig."
      : ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    typescriptCode: diagnostic.code,
    ...(diagnostic.file ? { fileName: diagnostic.file.fileName } : {}),
    ...(location ? { column: location.character + 1, line: location.line + 1 } : {}),
  };
}
