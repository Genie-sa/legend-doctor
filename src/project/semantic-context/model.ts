import type { AnalysisFile } from "../analysis-project.js";
import type ts from "typescript";

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
