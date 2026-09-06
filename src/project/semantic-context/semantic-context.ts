import type { AnalysisFile, AnalysisProject } from "../analysis-project.js";
import type {
  CreateSemanticContextOptions,
  ImportProvenance,
  SemanticContext,
  SemanticContextDiagnostic,
  SemanticContextDiagnosticCode,
  SemanticContextResult,
} from "./model.js";
import { createIdentityPreservingProgram, identityFailure } from "./identity-program.js";
import { importProvenanceOfSymbol, staticAccessFromNamespace } from "./import-provenance.js";
import path from "node:path";
import ts from "typescript";

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
